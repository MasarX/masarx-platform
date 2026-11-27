// i18n.tsx — EN + AR with RTL logic flip. Uses dot-paths into the catalog;
// missing keys return the path so they're easy to spot in screenshots.
import { Fragment, createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useIdentity } from './identity';
import { useResolveSettings } from './queries';
import { reportError } from './telemetry';
import { englishT, getConsoleCatalog, loadConsoleCatalog, readConsoleLocale, translateCatalog, type Locale, type Translate } from './i18n-catalog';

export { englishT, fill, type Translate } from './i18n-catalog';

/** Like `fill`, but each value stays a node, so callers can isolate data such as IDs and emails in `<bdi>`. */
export function fillNodes(template: string, values: Record<string, ReactNode>): ReactNode[] {
  return template.split(/\{(\w+)\}/).map((part, index) =>
    index % 2 === 0 ? part : <Fragment key={index}>{part in values ? values[part] : `{${part}}`}</Fragment>,
  );
}

interface I18nCtx {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  setLocale: (l: Locale) => void;
  toggleLocale: () => void;
  t: Translate;
  /** IANA zone used for date/time display; see TenantTimeZoneSync. */
  timeZone: string;
  fmtDateTime: (iso: string | number | Date) => string;
  /** Clock time (hours, minutes, seconds) in the app locale. */
  fmtTime: (iso: string | number | Date) => string;
  fmtCurrency: (amount: number, currency?: string) => string;
  fmtNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
}

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

// Render never suspends: the entry point loads the first catalog before mounting
// and setLocale loads the next one before switching. Suspending here varied the
// hook order between renders, and use() stops act() from flushing effects in tests.
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readConsoleLocale);
  const catalog = getConsoleCatalog(locale);
  // The language the latest switch asked for; an older load that settles later is ignored.
  const requested = useRef<Locale | null>(null);
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
    (path: string, fallback?: string) => translateCatalog(catalog, path, fallback),
    [catalog]
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
  const fmtTime = useCallback(
    (iso: string | number | Date) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      return new Intl.DateTimeFormat(intlLocale, {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
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

  // Keeps the current language on screen until the next catalog has loaded.
  const setLocale = useCallback((next: Locale) => {
    requested.current = next;
    const apply = () => {
      if (requested.current === next) startTransition(() => setLocaleState(next));
    };
    if (getConsoleCatalog(next)) {
      apply();
      return;
    }
    loadConsoleCatalog(next).then(apply, (error: unknown) => {
      if (requested.current === next) requested.current = null;
      reportError(error instanceof Error ? error : new Error(String(error)), { locale: next });
    });
  }, []);

  const value = useMemo<I18nCtx>(
    () => ({
      locale,
      dir,
      setLocale,
      toggleLocale: () => setLocale((requested.current ?? locale) === 'en' ? 'ar' : 'en'),
      t,
      timeZone,
      fmtDateTime,
      fmtTime,
      fmtCurrency,
      fmtNumber,
    }),
    [locale, dir, setLocale, t, timeZone, fmtDateTime, fmtTime, fmtCurrency, fmtNumber]
  );

  // After every hook, so the hook order is the same on every render.
  if (!catalog) throw new Error(`Console catalog "${locale}" is not loaded; await loadConsoleCatalog("${locale}") before rendering I18nProvider`);
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

/** Shared components use the active locale or the preloaded English catalog. */
export function useT(): I18nCtx['t'] {
  return useContext(Ctx)?.t ?? englishT;
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
