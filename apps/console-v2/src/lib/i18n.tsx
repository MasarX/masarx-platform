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
  fmtCurrency: (amount: number, currency?: string) => string;
  fmtNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
}

const CATALOGS: Record<Locale, Catalog> = { en: en as Catalog, ar: ar as Catalog };
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
      return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA' : 'en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(d);
    },
    [locale]
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
        return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US', {
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        }).format(numericAmount);
      }
      return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(numericAmount);
    },
    [locale]
  );
  const fmtNumber = useCallback(
    (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US', opts).format(n),
    [locale]
  );

  const value = useMemo<I18nCtx>(
    () => ({
      locale,
      dir,
      setLocale: setLocaleState,
      toggleLocale: () => setLocaleState((l) => (l === 'en' ? 'ar' : 'en')),
      t,
      fmtDateTime,
      fmtCurrency,
      fmtNumber,
    }),
    [locale, dir, t, fmtDateTime, fmtCurrency, fmtNumber]
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
