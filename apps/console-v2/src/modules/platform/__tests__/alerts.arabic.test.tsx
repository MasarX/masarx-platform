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
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/platform-alerts';
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
});
