// feature-flags.arabic.test.tsx: the feature-flags page renders its own copy in Arabic (issue #302).
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
import { FeatureFlagsModule } from '@/modules/platform/feature-flags';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-feature-flags';
import * as dataSource from '@/lib/data-source';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('FeatureFlagsModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/feature-flags');
    dataSource.setRole('ops_admin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<FeatureFlagsModule />, { locale: 'ar', capabilities: ['feature_flags.read'] });

    const [title] = await screen.findAllByText(ar.platformFeatureFlags.featureFlagsModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformFeatureFlags.featureFlagsModule.featureFlagAccessFeature);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<FeatureFlagsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformFeatureFlags.featureFlagsModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformFeatureFlags.featureFlagsModule.titlePlain')).toBe('— rollout & kill switches');
    expect(englishT('platformFeatureFlags.featureFlagsModule.totalFlags')).toBe('Total flags');
    expect(lookup(ar, 'platformFeatureFlags.featureFlagsModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
