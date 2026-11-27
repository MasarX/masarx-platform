// dashboard.arabic.test.tsx: the dashboard renders its own copy in Arabic; seeded record values stay as data.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { DashboardModule, formatCommandExecution } from '@/modules/dashboard';
import { englishT } from '@/lib/i18n';

describe('DashboardModule in Arabic', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the toolbar, view tabs and widget chrome in Arabic', async () => {
    renderWithProviders(<DashboardModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => expect(document.querySelectorAll('.dash-tab').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryAllByText('جارٍ التحميل…')).toHaveLength(0));
    const chrome = [...document.querySelectorAll('.dash-tab, .dash-toolbar, .dash-widget__head, .counter__label, .state__hint')];
    expect(chrome.length).toBeGreaterThan(0);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English command summary for code outside React', () => {
    expect(englishT('dashboard.menu.reset')).toBe('Reset to defaults');
    expect(typeof formatCommandExecution).toBe('function');
  });
});
