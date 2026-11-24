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
  /** Clock time (hours, minutes, seconds) in the app locale. */
  fmtTime: (iso: string | number | Date) => string;
  fmtCurrency: (amount: number, currency?: string) => string;
  fmtNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
  /** Time from now in the app locale, such as "5m ago" or "in 2h", in the largest whole unit up to days. */
  fmtRelative: (iso: string | number | Date | null | undefined, now?: number) => string;
}

/** The Arabic half of an area catalog must have exactly the English keys. */
export type CatalogShape<T> = { [K in keyof T]: T[K] extends string ? string : CatalogShape<T[K]> };

// Area catalogs: one file per UI area, each exporting `en` and `ar`, so parallel changes touch separate files.
const AREA_CATALOGS = import.meta.glob<{ en: Catalog; ar: Catalog }>('./seed-raw/i18n/areas/*.ts', { eager: true });

/** Adds an area's keys to a catalog; a key defined twice is an error, so each string has one source. */
function mergeArea(target: Catalog, area: Catalog, source: string, path = ''): void {
  for (const [key, value] of Object.entries(area)) {
    const at = path ? `${path}.${key}` : key;
    const existing = target[key];
    if (value && typeof value === 'object') {
      if (existing === undefined) target[key] = {};
      else if (typeof existing !== 'object') throw new Error(`i18n key ${at} in ${source} is already a string`);
      mergeArea(target[key] as Catalog, value as Catalog, source, at);
    } else if (existing !== undefined) {
      throw new Error(`i18n key ${at} in ${source} is already defined`);
    } else {
      target[key] = value;
    }
  }
}

function buildCatalog(base: Catalog, locale: Locale): Catalog {
  const catalog = structuredClone(base);
  for (const [source, area] of Object.entries(AREA_CATALOGS)) mergeArea(catalog, area[locale], source);
  return catalog;
}

const CATALOGS: Record<Locale, Catalog> = { en: buildCatalog(en as Catalog, 'en'), ar: buildCatalog(ar as Catalog, 'ar') };

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

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => (localStorage.getItem('console-v2.locale') as Locale) || 'en');
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
    (path: string, fallback?: string) => {
      const fromActive = lookup(CATALOGS[locale]!, path);
      if (fromActive) return fromActive;
      const fromEn = lookup(CATALOGS.en!, path);
      return fromEn ?? fallback ?? path;
    },
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
  const fmtRelative = useCallback(
    (iso: string | number | Date | null | undefined, now = Date.now()) => {
      if (iso == null || iso === '') return '—';
      const ms = new Date(iso).getTime();
      if (Number.isNaN(ms)) return '—';
      const s = Math.trunc((ms - now) / 1000);
      const abs = Math.abs(s);
      const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
        abs < 60 ? [s, 'second'] : abs < 3600 ? [Math.trunc(s / 60), 'minute'] : abs < 86400 ? [Math.trunc(s / 3600), 'hour'] : [Math.trunc(s / 86400), 'day'];
      return new Intl.RelativeTimeFormat(intlLocale, { style: 'narrow' }).format(value, unit);
    },
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
      fmtTime,
      fmtCurrency,
      fmtNumber,
      fmtRelative,
    }),
    [locale, dir, t, timeZone, fmtDateTime, fmtTime, fmtCurrency, fmtNumber, fmtRelative]
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

/** Catalog lookup signature shared by `t`, `useT()` and `englishT`. */
export type Translate = I18nCtx['t'];

/** English catalog lookup for code that runs outside React, such as drawer spec builders. */
export const englishT = (path: string, fallback?: string) => lookup(CATALOGS.en!, path) ?? fallback ?? path;

/** Catalog lookup for shared components that may render outside I18nProvider; there it reads the English catalog. */
export function useT(): I18nCtx['t'] {
  return useContext(Ctx)?.t ?? englishT;
}

/** Fills `{name}` placeholders in a catalog string; unknown names stay visible. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
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
