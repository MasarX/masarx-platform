// #164: dates use the user's locale and an explicit time zone, and RTL
// layout relies on logical properties instead of mirrored physical edges.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { DISPLAY_TIME_ZONE, I18nProvider, resolveIntlLocale, useI18n } from './i18n';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PHYSICAL_EDGE = /(?:^|[\s;{])(?:left|right|(?:border|margin|padding)-(?:left|right)(?:-\w+)?)\s*:/m;

describe('i18n locale and time zone (#164)', () => {
  it('prefers the user regional variant of the active language', () => {
    expect(resolveIntlLocale('en', ['en-GB', 'ar-EG'])).toBe('en-GB');
    expect(resolveIntlLocale('ar', ['en-GB', 'ar-EG'])).toBe('ar-EG');
    expect(resolveIntlLocale('ar', ['en-US'])).toBe('ar');
    expect(resolveIntlLocale('en', [])).toBe('en');
  });

  it('formats dates in the stated display time zone', () => {
    expect(DISPLAY_TIME_ZONE).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    const instant = '2026-11-24T07:30:00Z';
    const expected = new Intl.DateTimeFormat(resolveIntlLocale('en'), {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: DISPLAY_TIME_ZONE,
    }).format(new Date(instant));
    expect(result.current.fmtDateTime(instant)).toBe(expected);
  });
});

describe('RTL overrides (#164)', () => {
  it('rtl.css mirrors no physical edges', () => {
    const css = readFileSync(resolve(TEST_DIR, '../styles/rtl.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(PHYSICAL_EDGE);
  });

  it('landing tracking timeline uses inline-start edges', () => {
    const css = readFileSync(resolve(TEST_DIR, '../../../../docs/marketing/landing-v2/app.css'), 'utf8');
    const timeline =
      css.match(
        /\.track-timeline-item,\s*\.track-timeline-empty\s*\{[^}]*\}|\.track-timeline-item::before\s*\{[^}]*\}/g,
      ) ?? [];
    expect(timeline).toHaveLength(2);
    for (const rule of timeline) expect(rule).not.toMatch(PHYSICAL_EDGE);
  });
});
