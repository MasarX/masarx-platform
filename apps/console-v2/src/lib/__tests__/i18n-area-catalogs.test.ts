// Area catalogs: every English key has an Arabic value with the same placeholders.
import { describe, expect, it } from 'vitest';
import { englishT } from '../i18n';

type Tree = { [key: string]: string | Tree };

const AREAS = import.meta.glob<{ en: Tree; ar: Tree }>('../seed-raw/i18n/areas/*.ts', { eager: true });
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
    const names = Object.keys(AREAS).map((file) => file.replace(/^.*\/(\w+)\.ts$/, '$1'));
    expect(names).toEqual(expect.arrayContaining(['shell', 'dashboard']));
  });

  for (const [file, area] of Object.entries(AREAS)) {
    describe(file, () => {
      const en = flatten(area.en);
      const ar = flatten(area.ar);

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

  it('serves area keys through the English catalog lookup', () => {
    expect(englishT('shell.userMenu.access')).toBe('Access control');
    expect(englishT('dashboard.menu.reset')).toBe('Reset to defaults');
  });
});
