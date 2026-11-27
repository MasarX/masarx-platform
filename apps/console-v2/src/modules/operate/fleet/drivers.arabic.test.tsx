// drivers.arabic.test.tsx: the drivers page renders its own copy in Arabic; driver names and codes stay as data.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as api from '@/lib/api';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/fleet';
import { DriversModule } from './drivers';

// ScopePill is shared chrome owned elsewhere, so the header pills are limited to `.chip`.
const chrome = () => [
  ...document.querySelectorAll(
    '.page-header__title-block, .page-header__pills .chip, .page-header__actions, .kpi-strip .kpi__label, .kpi-strip .kpi__delta, .dt__table thead',
  ),
];

describe('DriversModule in Arabic', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/fleet/drivers');
    await api.hydrateConsoleLiveMetadata();
  });

  it('renders the header, KPI strip, table headers and drawer tabs in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DriversModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => expect(screen.getByText('Khalid Al-Otaibi')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(ar.fleetDrivers.kpi.total)).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(4);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    const row = screen.getByText('Khalid Al-Otaibi').closest('tr');
    if (!row) throw new Error('No row for Khalid');
    await user.click(row);
    await waitFor(() => expect(document.querySelector('.drawer [role="tablist"]')).toBeTruthy());
    const tabs = [...document.querySelectorAll('.drawer [role="tablist"] [role="tab"]')].map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual([
      ar.fleet.profile,
      ar.fleet.documents,
      ar.fleetDrivers.tabs.compliance,
      ar.fleetDrivers.tabs.hos,
      ar.fleetDrivers.tabs.vehicleHistory,
      ar.fleetDrivers.tabs.performance,
    ]);
    const drawerChrome = [...document.querySelectorAll('.drawer [role="tablist"], .drawer .kvgrid__key')];
    expect(drawerChrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy for trunk tests and code outside React', () => {
    expect(englishT('fleetDrivers.kpi.total')).toBe('Total drivers');
    expect(englishT('fleetDrivers.tabs.ariaLabel')).toBe('Driver drawer tabs');
    expect(englishT('fleetDrivers.hos.todaySegments')).toBe("Today's segments");
    expect(englishT('fleetDrivers.modal.noteEvent')).toBe('Note compliance event · {name}');
    expect(englishT('fleetDrivers.create.usersLoadingTitle')).toBe('Tenant users loading');
    expect(ar.fleetDrivers.kpi.total).toBe('إجمالي السائقين');
    expect(ar.fleetDrivers.tabs.hos).toBe('ساعات الخدمة');
    expect(ar.fleet.eyebrow).toBe('التشغيل · الأسطول');
  });
});
