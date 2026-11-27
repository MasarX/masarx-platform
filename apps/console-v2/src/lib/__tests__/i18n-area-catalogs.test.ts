// Area catalogs: every English key has an Arabic value with the same placeholders.
import { describe, expect, it, vi } from 'vitest';
import { englishT, getConsoleCatalog } from '../i18n-catalog';

type Tree = { [key: string]: string | Tree };

const EN = import.meta.glob<Tree>('../seed-raw/i18n/areas/en/*.ts', { eager: true, import: 'default' });
const AR = import.meta.glob<Tree>('../seed-raw/i18n/areas/ar/*.ts', { eager: true, import: 'default' });
// Values that are deliberately not Arabic words: the locale switch names the other language.
const NON_ARABIC_VALUES = new Set(['shell.topbar.otherLocale']);

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [inner, text] of flatten(value, path)) out.set(inner, text);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n area catalogs', () => {
  it('loads at least the shell and dashboard areas', () => {
    const names = Object.keys(EN).map((file) => file.replace(/^.*\/(\w+)\.ts$/, '$1'));
    expect(names).toEqual(expect.arrayContaining(['shell', 'dashboard']));
  });

  it('has the same areas in both locales', () => {
    expect(Object.keys(AR).sort()).toEqual(Object.keys(EN).map((file) => file.replace('/en/', '/ar/')).sort());
  });

  for (const [file, english] of Object.entries(EN)) {
    describe(file, () => {
      const en = flatten(english);
      const ar = flatten(AR[file.replace('/en/', '/ar/')]);

      it('has the same keys in English and Arabic', () => {
        expect([...ar.keys()].sort()).toEqual([...en.keys()].sort());
      });

      it('keeps every placeholder and writes each Arabic value in Arabic', () => {
        for (const [key, english] of en) {
          const arabic = ar.get(key) ?? '';
          expect(placeholders(arabic), key).toEqual(placeholders(english));
          if (!NON_ARABIC_VALUES.has(key)) expect(arabic, key).toMatch(/[؀-ۿ]/);
        }
      });
    });
  }

  it('covers every English key in the assembled Arabic catalog, including empty values', () => {
    const en = flatten(getConsoleCatalog('en') as Tree);
    const ar = flatten(getConsoleCatalog('ar') as Tree);
    expect([...ar.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, value] of en) {
      if (value) expect(ar.get(key), key).toBeTruthy();
    }
  });

  it('loads and caches only the requested locale on a cold start', async () => {
    vi.resetModules();
    const loader = await import('../i18n-catalog');
    expect(loader.getConsoleCatalog('en')).toBeUndefined();
    expect(loader.getConsoleCatalog('ar')).toBeUndefined();

    const pending = loader.loadConsoleCatalog('ar');
    expect(loader.loadConsoleCatalog('ar')).toBe(pending);
    const arabic = await pending;

    expect(loader.getConsoleCatalog('en')).toBeUndefined();
    expect(loader.getConsoleCatalog('ar')).toBe(arabic);
    expect(loader.translateCatalog(arabic, 'shell.userMenu.access')).toBe('التحكم في الوصول');
    expect(loader.translateCatalog(arabic, 'modules.recipients.plain')).toBe('');
  });

  it('serves area keys through the English catalog lookup', () => {
    expect(englishT('shell.userMenu.access')).toBe('Access control');
    expect(englishT('dashboard.menu.reset')).toBe('Reset to defaults');
  });
});
