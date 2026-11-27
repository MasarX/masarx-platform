// Area catalogs: every English key has an Arabic value with the same placeholders.
import { act, renderHook } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, useI18n } from '../i18n';
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

  it('renders without suspending and keeps the current locale until a switch has loaded', async () => {
    vi.resetModules();
    let releaseArabic!: () => void;
    const arabicReady = new Promise<void>((resolve) => { releaseArabic = resolve; });
    vi.doMock('../seed-raw/i18n/ar.js', async () => {
      await arabicReady;
      return vi.importActual('../seed-raw/i18n/ar.js');
    });
    const loader = await import('../i18n-catalog');
    const loadCatalog = vi.spyOn(loader, 'loadConsoleCatalog');
    const { I18nProvider, useI18n } = await import('../i18n');
    const consoleError = vi.spyOn(console, 'error');
    localStorage.setItem('console-v2.locale', 'en');
    try {
      await loader.loadConsoleCatalog('en');
      // The first synchronous render already has the hook result: nothing suspended.
      const view = renderHook(useI18n, { wrapper: I18nProvider });
      expect(view.result.current.t('shell.userMenu.access')).toBe('Access control');
      expect(loadCatalog).not.toHaveBeenCalledWith('ar');

      loadCatalog.mockClear();
      view.rerender();
      expect(loadCatalog).not.toHaveBeenCalled();

      act(() => view.result.current.toggleLocale());
      expect(loadCatalog).toHaveBeenCalledWith('ar');
      expect(view.result.current.locale).toBe('en');
      expect(view.result.current.t('shell.userMenu.access')).toBe('Access control');
      expect(document.documentElement.dir).toBe('ltr');

      // Switching back before Arabic loads wins: the late Arabic load is ignored.
      act(() => view.result.current.toggleLocale());
      await act(async () => {
        releaseArabic();
        await loader.loadConsoleCatalog('ar');
      });
      expect(view.result.current.locale).toBe('en');
      expect(document.documentElement.dir).toBe('ltr');

      // Arabic is now loaded, so the next switch applies at once.
      act(() => view.result.current.toggleLocale());
      expect(view.result.current.locale).toBe('ar');
      expect(view.result.current.t('shell.userMenu.access')).toBe(
        loader.translateCatalog(loader.getConsoleCatalog('ar'), 'shell.userMenu.access')
      );
      expect(document.documentElement.dir).toBe('rtl');
      expect(consoleError.mock.calls.flat().join('\n')).not.toMatch(
        /change in the order of Hooks|Rendered (?:more|fewer) hooks|error during concurrent rendering/i
      );
    } finally {
      vi.doUnmock('../seed-raw/i18n/ar.js');
      consoleError.mockRestore();
      loadCatalog.mockRestore();
      localStorage.removeItem('console-v2.locale');
    }
  });

  it('flushes effect updates and keeps child state when a loaded provider renders and rerenders', async () => {
    let mounts = 0;
    function useProbe(label: string) {
      const i18n = useI18n();
      const [mountId] = useState(() => ++mounts);
      const [seen, setSeen] = useState('');
      useEffect(() => {
        setSeen(label);
      }, [label]);
      return { i18n, mountId, seen };
    }
    const consoleError = vi.spyOn(console, 'error');
    localStorage.setItem('console-v2.locale', 'en');
    try {
      const view = renderHook(({ label }: { label: string }) => useProbe(label), {
        wrapper: I18nProvider,
        initialProps: { label: 'first' },
      });
      // A synchronous render flushes the child's effect update, as it does without the provider.
      expect(view.result.current.seen).toBe('first');

      view.rerender({ label: 'second' });
      expect(view.result.current.seen).toBe('second');

      await act(() => view.result.current.i18n.toggleLocale());
      expect(view.result.current.i18n.locale).toBe('ar');
      expect(view.result.current.seen).toBe('second');
      expect(view.result.current.mountId).toBe(1);
      expect(mounts).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(consoleError.mock.calls.flat().join('\n')).not.toMatch(/suspended inside an `act` scope/);
    } finally {
      consoleError.mockRestore();
      localStorage.removeItem('console-v2.locale');
    }
  });

  it('throws a developer error naming a catalog that was not loaded before render', async () => {
    vi.resetModules();
    const { I18nProvider, useI18n } = await import('../i18n');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('console-v2.locale', 'ar');
    try {
      expect(() => renderHook(useI18n, { wrapper: I18nProvider })).toThrow(/Console catalog "ar" is not loaded/);
    } finally {
      consoleError.mockRestore();
      localStorage.removeItem('console-v2.locale');
    }
  });

  it('serves area keys through the English catalog lookup', () => {
    expect(englishT('shell.userMenu.access')).toBe('Access control');
    expect(englishT('dashboard.menu.reset')).toBe('Reset to defaults');
  });
});
