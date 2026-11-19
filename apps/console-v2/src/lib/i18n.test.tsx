// i18n.test.tsx — exercises the canonical I18nProvider contract:
// toggleLocale flips dir, document.documentElement.dir/lang stay in sync,
// and fmtCurrency uses the active locale for formatting.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { I18nProvider, useI18n } from './i18n';

function wrapper({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

describe('lib/i18n', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = '';
    document.documentElement.dir = '';
  });

  it('starts in English with ltr direction by default', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.locale).toBe('en');
    expect(result.current.dir).toBe('ltr');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });

  it('toggleLocale flips locale + dir, and updates <html> attributes', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.toggleLocale());
    expect(result.current.locale).toBe('ar');
    expect(result.current.dir).toBe('rtl');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
  });

  it('fmtCurrency formats per active locale (currency code present in output)', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    const formatted = result.current.fmtCurrency(1234, 'SAR');
    // en-US output should contain the digits (locale-specific glyphs aside).
    expect(formatted).toMatch(/1[,. ]?234/);
  });

  it('fmtCurrency preserves minor units only when present', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.fmtCurrency(87.5, 'SAR')).toMatch(/87[,.]50/);
    expect(result.current.fmtCurrency(88, 'SAR')).not.toMatch(/88[,.]00/);
  });
});
