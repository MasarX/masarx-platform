// vehicles.arabic.test.tsx: the fleet vehicles page and drawer render their own copy in Arabic; plates and seeded values stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import * as api from '@/lib/api';
import ar from '@/lib/seed-raw/i18n/areas/ar/fleet';
import { VehiclesModule } from './vehicles';

// Same identity and readiness wait as the trunk vehicles test, in Arabic.
async function mountArabic() {
  renderWithProviders(<VehiclesModule />, {
    locale: 'ar',
    identity: {
      capabilities: ['all'],
      user: {
        organization_id: 'org_rashed',
        access_scope_type: 'tenant',
        access_scope_id: null,
      },
      scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
    },
  });
  await waitFor(() => {
    expect(screen.getAllByText(ar.fleetVehicles.kpi.total).length).toBeGreaterThan(0);
  }, { timeout: 3000 });
}

const untranslated = (selector: string) =>
  [...document.querySelectorAll(selector)].flatMap((element) => findUntranslated(element));

// Not checked: the pills row (ScopePill and Chip are shared components), CapacityGauge,
// the DataTable toolbar, table body cells, the drawer header (plate and type are data)
// and KvGrid values (seeded data).
describe('VehiclesModule in Arabic', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/fleet/vehicles');
    await api.hydrateConsoleLiveMetadata();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/fleet/vehicles');
  });

  it('renders the header, KPI labels and table headers in Arabic', async () => {
    await mountArabic();
    expect(screen.getByText(ar.fleetVehicles.utilisation.ready)).toBeInTheDocument();
    const selectors = '.page-header__title-block, .page-header__actions, .kpi__label, .dt__table thead';
    expect(document.querySelectorAll(selectors).length).toBeGreaterThan(0);
    expect(untranslated(selectors)).toEqual([]);
  });

  it('renders the vehicle drawer tabs and profile copy in Arabic', async () => {
    window.history.pushState(null, '', '/operate/fleet/vehicles?focus=veh_van_118');
    await mountArabic();
    await waitFor(() => {
      expect(document.querySelectorAll('.drawer .tabs').length).toBeGreaterThan(0);
    });
    expect(screen.getByText(ar.fleetVehicles.profile.heading)).toBeInTheDocument();
    const selectors = '.drawer .tabs, .drawer h4, .drawer .kvgrid__key, .drawer p.state__hint';
    expect(untranslated(selectors)).toEqual([]);
  });

  it('keeps the English copy the vehicles page showed before', () => {
    expect(englishT('fleetVehicles.kpi.total')).toBe('Total fleet');
    expect(englishT('fleetVehicles.scope.filteredBy')).toBe('Filtered by branch {branch}');
    expect(englishT('fleetVehicles.schedule.policy.incompleteTitle')).toBe('Maintenance policy incomplete');
    expect(englishT('fleetVehicles.oos.action')).toBe('Mark out-of-service');
    expect(ar.fleetVehicles.tabs.telemetry).toBe('القياس عن بُعد');
    expect(ar.fleetVehicles.field.vin).toBe('رقم الهيكل');
  });
});
