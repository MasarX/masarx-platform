// zones.arabic.test.tsx: the zones page, drawer and create modal render their own copy in Arabic; zone, district and branch names stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { getLookups } from '@/lib/data-source';
import { englishT, fill } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/customers-network';
import { ZonesModule } from './zones';

async function waitForLookups(category: string) {
  const deadline = Date.now() + 1000;
  while (getLookups(category).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const untranslated = (selector: string, allow: string[] = []) =>
  [...document.querySelectorAll(selector)].flatMap((element) => findUntranslated(element, allow));

describe('ZonesModule in Arabic', () => {
  beforeEach(async () => {
    await Promise.all([waitForLookups('zone_status'), waitForLookups('zone_color_token')]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header, KPI strip, side list, drawer and create modal in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ZonesModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => expect(screen.getByTestId('zones-kpi-strip')).toBeInTheDocument());
    expect(screen.getByText(ar.zones.kpi.total)).toBeInTheDocument();
    expect(untranslated('.page-header__title-block')).toEqual([]);
    expect(untranslated('[data-testid="zones-kpi-strip"]')).toEqual([]);
    expect(untranslated('.zones-split__list .section-eyebrow')).toEqual([]);
    await waitFor(() => {
      expect(document.querySelectorAll('.zones-side-row__chips').length).toBeGreaterThan(0);
      expect(untranslated('.zones-side-row__chips')).toEqual([]);
    });

    // Same row the trunk test opens (__tests__/zones.test.tsx).
    const sideList = screen.getByTestId('zones-side-list');
    await user.click(within(sideList).getByLabelText(/Riyadh North/));
    await waitFor(() => {
      expect(document.querySelector('.drawer__title')?.textContent).toBe(fill(ar.zones.drawer.title, { name: 'Riyadh North' }));
    });
    expect(untranslated('.drawer__title', ['Riyadh North'])).toEqual([]);
    await waitFor(() => expect(document.querySelectorAll('.drawer__body .kvgrid__key').length).toBeGreaterThan(1));
    expect(untranslated('.drawer__body [role="tablist"]')).toEqual([]);
    expect(untranslated('.drawer__body .kvgrid__key')).toEqual([]);

    await user.click(screen.getByRole('tab', { name: new RegExp(ar.zones.drawer.tabs.districts) }));
    await waitFor(() => expect(document.querySelector('.drawer__body .dt__table thead')).toBeTruthy());
    expect(untranslated('.drawer__body .dt__table thead')).toEqual([]);
  });

  it('renders the create modal labels in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ZonesModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => expect(screen.getByTestId('zones-side-list')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: ar.zones.actions.newZone }));
    const nameInput = await screen.findByPlaceholderText(ar.zones.create.namePlaceholder);
    expect(nameInput).toHaveAttribute('aria-label', ar.zones.create.nameAria);
    expect(screen.getByLabelText(ar.zones.create.branchCoverage)).toBeInTheDocument();
    expect(untranslated('.modal__title')).toEqual([]);
    expect(untranslated('.modal__body .state__hint:not(.mono)')).toEqual([]);
    expect(untranslated('.modal__footer')).toEqual([]);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('zones.kpi.total')).toBe('Total zones');
    expect(englishT('zones.actions.newZone')).toBe('New zone');
    expect(englishT('zones.create.namePlaceholder')).toBe('e.g. Riyadh East');
    expect(englishT('zones.drawer.noDistricts')).toBe('No districts linked. Triage in operations.');
    expect(englishT('zones.status.suspended')).toBe('suspended');
    expect(fill(englishT('zones.bulk.suspendedAlreadyOther'), { n: 2, already: 1 })).toBe('Suspended 2 zones (1 already suspended).');
    expect(ar.zones.actions.newZone).toBe('منطقة جديدة');
    expect(ar.zones.drawer.tabs.districts).toBe('الأحياء');
  });
});
