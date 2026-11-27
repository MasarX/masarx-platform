// alerts.arabic.test.tsx: the alerts page renders its own copy in Arabic (issue #302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => null,
  rpc: vi.fn(),
}));

vi.mock('@/lib/seed-loader', async () => {
  // @ts-expect-error JS seed module is intentionally declaration-free.
  const seed = await import('@/lib/seed-raw/seed.js');
  return {
    seed,
    SEED_MODE_ENABLED: true,
  };
});

import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { AlertsModule } from '@/modules/platform/alerts';
import { englishT, resolveIntlLocale, useI18n } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-alerts';
import * as dataSource from '@/lib/data-source';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('AlertsModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/alerts');
    dataSource.setRole('ops_admin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<AlertsModule />, { locale: 'ar', capabilities: ['alerts.read'] });

    const [title] = await screen.findAllByText(ar.platformAlerts.alertsModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformAlerts.alertsModule.alertRules);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<AlertsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformAlerts.alertsModule.alertsManagementRequiresThe)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformAlerts.alertsModule.titleAccent')).toBe('Alerts');
    expect(englishT('platformAlerts.alertsModule.operationsAlerts')).toBe('Operations alerts');
    expect(lookup(ar, 'platformAlerts.alertsModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });

  it.each([
    ['platformAlerts.helpers.acknowledgeFailed', 'Unable to acknowledge ops alert'],
    ['platformAlerts.alertsModule.newAlertRule', 'New alert rule'],
  ])('keeps the English helper copy for %s and has Arabic', (key, english) => {
    expect(englishT(key)).toBe(english);
    expect(lookup(ar, key)).toMatch(/[\u0600-\u06FF]/);
  });

  it('formats relative times in Arabic', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    function Probe() {
      const { fmtRelative } = useI18n();
      return <span data-testid="relative">{`${fmtRelative(now - 5 * 60_000, now)}|${fmtRelative(null, now)}`}</span>;
    }
    renderWithProviders(<Probe />, { locale: 'ar' });
    const expected = new Intl.RelativeTimeFormat(resolveIntlLocale('ar'), { style: 'narrow' }).format(-5, 'minute');
    expect(expected).toMatch(/[\u0600-\u06FF]/);
    expect(screen.getByTestId('relative').textContent).toBe(`${expected}|—`);
  });
});
