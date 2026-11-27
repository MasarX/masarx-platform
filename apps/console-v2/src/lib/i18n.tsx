// i18n.tsx — EN + AR with RTL logic flip. Uses dot-paths into the catalog;
// missing keys return the path so they're easy to spot in screenshots.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useIdentity } from './identity';
import { useResolveSettings } from './queries';
// @ts-expect-error JS catalogs without types
import { en } from './seed-raw/i18n/en.js';
// @ts-expect-error JS catalogs without types
import { ar } from './seed-raw/i18n/ar.js';

type Locale = 'en' | 'ar';
type Catalog = Record<string, unknown>;

interface I18nCtx {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  setLocale: (l: Locale) => void;
  toggleLocale: () => void;
  t: (path: string, fallback?: string) => string;
  /** IANA zone used for date/time display; see TenantTimeZoneSync. */
  timeZone: string;
  fmtDateTime: (iso: string | number | Date) => string;
  fmtCurrency: (amount: number, currency?: string) => string;
  fmtNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
}

const CATALOGS: Record<Locale, Catalog> = { en: en as Catalog, ar: ar as Catalog };

// Display zone, decided here only: the tenant's `tenant_default_timezone.iana`
// once identity has loaded (TenantTimeZoneSync), else the user's own zone below.
export const DISPLAY_TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** True for a zone name Intl accepts; a bad settings row must not break date display. */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The user's preferred regional variant of the active language (en-GB, ar-EG),
// else the bare language tag.
export function resolveIntlLocale(locale: Locale, preferred: readonly string[] = navigator.languages ?? []): string {
  return preferred.find((tag) => tag.toLowerCase().split('-')[0] === locale) ?? locale;
}
const Ctx = createContext<I18nCtx | null>(null);
const TenantTimeZoneCtx = createContext<((zone: string | null) => void) | null>(null);

function lookup(catalog: Catalog, path: string): string | undefined {
  const parts = path.split('.');
  let cur: unknown = catalog;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

function readConsoleLocale(): Locale {
  return globalThis.localStorage?.getItem('console-v2.locale') === 'ar' ? 'ar' : 'en';
}

function translate(catalog: Locale, path: string, fallback?: string): string {
  const fromActive = lookup(CATALOGS[catalog], path);
  return fromActive || (lookup(CATALOGS.en, path) ?? fallback ?? path);
}

export function translateAdapterMessage(path: string, locale = readConsoleLocale()): string {
  return translate(locale, path);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readConsoleLocale);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const intlLocale = useMemo(() => resolveIntlLocale(locale), [locale]);
  const [tenantTimeZone, setTenantTimeZone] = useState<string | null>(null);
  const timeZone = tenantTimeZone ?? DISPLAY_TIME_ZONE;

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    localStorage.setItem('console-v2.locale', locale);
  }, [locale, dir]);

  const t = useCallback(
    (path: string, fallback?: string) => translate(locale, path, fallback),
    [locale]
  );

  const fmtDateTime = useCallback(
    (iso: string | number | Date) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      return new Intl.DateTimeFormat(intlLocale, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZone,
      }).format(d);
    },
    [intlLocale, timeZone]
  );
  const fmtCurrency = useCallback(
    (amount: number, currency?: string) => {
      const numericAmount = Number.isFinite(amount) ? amount : 0;
      const hasMinorUnits = Math.abs(numericAmount % 1) > 0.000001;
      const fractionDigits = hasMinorUnits ? 2 : 0;
      // AGENTS.md §2 (W30/G1): no inline ISO-code fallback. When the
      // caller passes empty/undefined currency (canonical row not seeded
      // OR row-level field missing), render the amount as a plain number
      // without an ISO suffix — visible to operators as a bare value
      // rather than a silent locale default.
      if (!currency) {
        return new Intl.NumberFormat(intlLocale, {
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        }).format(numericAmount);
      }
      return new Intl.NumberFormat(intlLocale, {
        style: 'currency',
        currency,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(numericAmount);
    },
    [intlLocale]
  );
  const fmtNumber = useCallback(
    (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(intlLocale, opts).format(n),
    [intlLocale]
  );

  const value = useMemo<I18nCtx>(
    () => ({
      locale,
      dir,
      setLocale: setLocaleState,
      toggleLocale: () => setLocaleState((l) => (l === 'en' ? 'ar' : 'en')),
      t,
      timeZone,
      fmtDateTime,
      fmtCurrency,
      fmtNumber,
    }),
    [locale, dir, t, timeZone, fmtDateTime, fmtCurrency, fmtNumber]
  );

  return (
    <Ctx.Provider value={value}>
      <TenantTimeZoneCtx.Provider value={setTenantTimeZone}>
        <NextIntlClientProvider locale={locale}>{children}</NextIntlClientProvider>
      </TenantTimeZoneCtx.Provider>
    </Ctx.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

/**
 * Mount inside IdentityProvider. Once identity has loaded, resolves the active
 * tenant's `tenant_default_timezone` and makes it the display zone. A missing or
 * invalid row, or signing out, falls back to DISPLAY_TIME_ZONE.
 */
export function TenantTimeZoneSync() {
  const setTenantTimeZone = useContext(TenantTimeZoneCtx);
  const { isAuthenticated, scope, currentTenantId } = useIdentity();
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const settingsScope = useMemo(() => (tenantId ? { organization_id: tenantId } : undefined), [tenantId]);
  const policy = useResolveSettings('tenant_default_timezone', settingsScope, { enabled: isAuthenticated });
  const iana = isAuthenticated ? (policy.data?.value as { iana?: unknown } | undefined)?.iana : undefined;
  useEffect(() => {
    setTenantTimeZone?.(isValidTimeZone(iana) ? iana : null);
  }, [iana, setTenantTimeZone]);
  return null;
}
