// geocoding.arabic.test.tsx: the geocoding page renders its own copy in Arabic; addresses and provider values stay as data (#302).
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/marketplace-geocoding';
import { GeocodingModule } from './geocoding';

const RASHED_TENANT_IDENTITY = {
  capabilities: ['all'],
  user: {
    access_scope_type: 'tenant' as const,
    organization_id: 'org_rashed',
  },
  scope: {
    tenant: { id: 'org_rashed', label: 'Rashed Express', rank: 2 as const },
  },
};

// Header title, KPI labels and deltas, the tab strip and table headers are module copy; table cells hold seeded data.
const chrome = () => [
  ...document.querySelectorAll('.page-header__title-block, .kpi__label, .kpi__delta, .dt__table thead'),
  ...document.querySelectorAll(`[role="tablist"][aria-label="${ar.geocoding.tabs.aria}"]`),
];
// Drawer key labels and section eyebrows are module copy; the drawer title and key values are address data.
const drawerChrome = () => [...document.querySelectorAll('.drawer .kvgrid__key, .drawer .section-eyebrow')];

describe('GeocodingModule in Arabic', () => {
  it('renders the header, KPIs, tabs, address table headers and address drawer in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeocodingModule />, { locale: 'ar', identity: RASHED_TENANT_IDENTITY });
    await waitFor(() => {
      expect(screen.getByText(ar.geocoding.kpi.validPct)).toBeInTheDocument();
    }, { timeout: 3000 });
    // The seed addresses use "Olaya St" on every street.
    const streetCells = await screen.findAllByText(/Olaya St/);
    expect(chrome().length).toBeGreaterThan(0);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(streetCells[0]!);
    await waitFor(() => {
      expect(screen.getAllByText(ar.geocoding.section.addressGeocodes).length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(drawerChrome().length).toBeGreaterThan(0);
    expect(drawerChrome().flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy the page showed before', () => {
    expect(englishT('geocoding.kpi.validPct')).toBe('Valid %');
    expect(englishT('geocoding.kpi.attempts24h')).toBe('Attempts (24h)');
    expect(englishT('geocoding.map.coverage')).toBe('Geocoding coverage map');
    expect(englishT('geocoding.section.addressGeocodes')).toBe('Geocodes for this address');
    expect(ar.geocoding.tabs.addresses).toBe('العناوين');
    expect(ar.geocoding.kpi.avgConfidence).toBe('متوسط الثقة');
  });
});
