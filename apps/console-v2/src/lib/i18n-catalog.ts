export type Locale = 'en' | 'ar';
export type Translate = (path: string, fallback?: string) => string;
type Catalog = Record<string, unknown>;

/** The Arabic half of an area catalog must have exactly the English keys. */
export type CatalogShape<T> = { [K in keyof T]: T[K] extends string ? string : CatalogShape<T[K]> };

const areas = {
  en: import.meta.glob<Catalog>('./seed-raw/i18n/areas/en/*.ts', { import: 'default' }),
  ar: import.meta.glob<Catalog>('./seed-raw/i18n/areas/ar/*.ts', { import: 'default' }),
};
const bases = {
  // @ts-expect-error JS catalogs without types
  en: () => import('./seed-raw/i18n/en.js').then((module) => module.en as Catalog),
  // @ts-expect-error JS catalogs without types
  ar: () => import('./seed-raw/i18n/ar.js').then((module) => module.ar as Catalog),
};
const catalogs: Partial<Record<Locale, Catalog>> = {};
const catalogPromises: Partial<Record<Locale, Promise<Catalog>>> = {};

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

async function buildCatalog(locale: Locale): Promise<Catalog> {
  const [base, translations] = await Promise.all([
    bases[locale](),
    Promise.all(Object.entries(areas[locale]).map(async ([source, load]) => [source, await load()] as const)),
  ]);
  const catalog = structuredClone(base);
  for (const [source, area] of translations) mergeArea(catalog, area, source);
  return catalog;
}

export function loadConsoleCatalog(locale: Locale): Promise<Catalog> {
  const cached = catalogPromises[locale];
  if (cached) return cached;

  const promise = buildCatalog(locale).then((catalog) => {
    catalogs[locale] = catalog;
    // React can read the catalog synchronously even when it was preloaded outside render.
    Object.assign(promise, { status: 'fulfilled', value: catalog });
    return catalog;
  });
  catalogPromises[locale] = promise;
  return promise;
}

export function getConsoleCatalog(locale: Locale): Catalog | undefined {
  return catalogs[locale];
}

export function readConsoleLocale(): Locale {
  return globalThis.localStorage?.getItem('console-v2.locale') === 'ar' ? 'ar' : 'en';
}

function lookup(catalog: Catalog | undefined, path: string): string | undefined {
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

export function translateCatalog(catalog: Catalog | undefined, path: string, fallback?: string): string {
  const value = lookup(catalog, path);
  return value || (lookup(catalogs.en, path) ?? value ?? fallback ?? path);
}

export function translateAdapterMessage(path: string, locale = readConsoleLocale()): string {
  return translateCatalog(catalogs[locale], path);
}

/** Synchronous English lookup for callers that have loaded the English catalog. */
export const englishT: Translate = (path, fallback) => lookup(catalogs.en, path) ?? fallback ?? path;

/** Fills `{name}` placeholders in a catalog string; unknown names stay visible. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
