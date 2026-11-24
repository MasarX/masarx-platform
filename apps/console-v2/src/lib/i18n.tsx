// i18n.tsx — EN + AR with RTL logic flip. Uses dot-paths into the catalog;
// missing keys return the path so they're easy to spot in screenshots.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
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
  fmtDateTime: (iso: string | number | Date) => string;
  /** Clock time (hours, minutes, seconds) in the app locale. */
  fmtTime: (iso: string | number | Date) => string;
  fmtCurrency: (amount: number, currency?: string) => string;
  fmtNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
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

// The console has no session-wide tenant display zone, so dates show in the
// user's own zone. This is the single place to change that default.
export const DISPLAY_TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone;

// The user's preferred regional variant of the active language (en-GB, ar-EG),
// else the bare language tag.
export function resolveIntlLocale(locale: Locale, preferred: readonly string[] = navigator.languages ?? []): string {
  return preferred.find((tag) => tag.toLowerCase().split('-')[0] === locale) ?? locale;
}
const Ctx = createContext<I18nCtx | null>(null);

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
        timeZone: DISPLAY_TIME_ZONE,
      }).format(d);
    },
    [intlLocale]
  );
  const fmtTime = useCallback(
    (iso: string | number | Date) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      return new Intl.DateTimeFormat(intlLocale, {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: DISPLAY_TIME_ZONE,
      }).format(d);
    },
    [intlLocale]
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
      fmtDateTime,
      fmtTime,
      fmtCurrency,
      fmtNumber,
    }),
    [locale, dir, t, fmtDateTime, fmtTime, fmtCurrency, fmtNumber]
  );

  return (
    <Ctx.Provider value={value}>
      <NextIntlClientProvider locale={locale}>{children}</NextIntlClientProvider>
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
