// marketplace.arabic.test.tsx: the marketplace page renders its own copy in Arabic; seeded record values stay as data (#302).
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/marketplace-geocoding';
import { MarketplaceModule } from '../marketplace';

// Header title, KPI labels and deltas, the tab strip and table headers are module copy; table cells hold seeded data.
const chrome = () => [
  ...document.querySelectorAll('.page-header__title-block, .kpi__label, .kpi__delta, .dt__table thead'),
  ...document.querySelectorAll(`[role="tablist"][aria-label="${ar.marketplace.tabs.aria}"]`),
];

describe('MarketplaceModule in Arabic', () => {
  it('renders the header, KPIs, tabs and offer table headers in Arabic', async () => {
    renderWithProviders(<MarketplaceModule />, {
      locale: 'ar',
      capabilities: ['marketplace.read', 'marketplace.write'],
    });
    await waitFor(() => {
      expect(screen.getByTestId('marketplace-tab-offers')).toBeInTheDocument();
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(screen.getByTestId('marketplace-tab-offers')).toHaveTextContent(ar.marketplace.tabs.offers);
    expect(screen.getByText(ar.marketplace.kpi.openRequests)).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(0);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy the marketplace showed before', () => {
    expect(englishT('marketplace.action.awardOffer')).toBe('Award offer');
    expect(englishT('marketplace.kpi.openRequests')).toBe('Open requests');
    expect(englishT('marketplace.tabs.contracts')).toBe('Contracts');
    expect(englishT('marketplace.drawer.offer')).toBe('Offer · {id}');
    expect(ar.marketplace.tabs.offers).toBe('العروض');
    expect(ar.marketplace.action.awardOffer).toBe('ترسية العرض');
  });
});
