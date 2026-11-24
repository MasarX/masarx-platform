// driver-applications.arabic.test.tsx: the driver application queue renders its own copy in Arabic; seeded record values stay as data (#302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, type RenderWithProvidersOptions } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import { CAP } from '@/lib/capabilities';
import { ar } from '@/lib/seed-raw/i18n/areas/fleet';
import { DriverApplicationsModule } from '@/modules/operate/fleet/driver-applications';

const identity: RenderWithProvidersOptions['identity'] = {
  capabilities: ['all', CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW],
  user: { access_scope_type: 'platform', access_scope_id: null, organization_id: 'org_test_driver_applications' },
  scope: { tenant: { id: 'org_test_driver_applications', label: 'Driver Applications Test Tenant', rank: 2 } },
};

// Header title, KPI labels and table headers are module copy; table cells hold seeded data.
// The scope pill is a shared component outside this slice, so the pills row is checked by text only.
const chrome = () => [...document.querySelectorAll('.page-header__title-block, .kpi__label, .kpi__delta, .dt__table thead')];
// Drawer tabs and key labels are module copy; the drawer title and key values are applicant data.
const drawerChrome = () => [...document.querySelectorAll('.drawer__body [role="tablist"], .drawer__body .kvgrid__key')];

describe('DriverApplicationsModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/operate/fleet/driver-applications');
  });

  it('renders the header, KPIs, table headers and drawer in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DriverApplicationsModule />, { locale: 'ar', identity });
    await waitFor(() => {
      expect(screen.queryByText(ar.fleetApplications.loading)).not.toBeInTheDocument();
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(document.body.textContent).toContain(ar.fleetApplications.pills.queue);
    expect(document.body.textContent).toContain(ar.fleetApplications.pills.workflow);
    expect(chrome().length).toBeGreaterThan(0);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(document.querySelector('.dt__table tbody tr') as HTMLElement);
    await waitFor(() => {
      expect(document.querySelector('.drawer__body [role="tablist"]')).not.toBeNull();
    }, { timeout: 3000 });
    expect(drawerChrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(screen.getByRole('tab', { name: ar.fleetApplications.tabs.attestations }));
    await waitFor(() => {
      expect(screen.getByText(ar.fleetApplications.attestations.intro)).toBeInTheDocument();
    }, { timeout: 3000 });
    // Attestation labels name the vendor and the protocol fields in Latin: Cloudflare, UTM, IP.
    expect(drawerChrome().flatMap((element) => findUntranslated(element, ['Cloudflare', 'UTM', 'IP']))).toEqual([]);
  });

  it('keeps the English copy the queue showed before', () => {
    expect(englishT('fleetApplications.kpi.total')).toBe('Total applications');
    expect(englishT('fleetApplications.tabs.aria')).toBe('Driver application drawer tabs');
    expect(englishT('fleetApplications.review.notAllowed')).toBe('Status {status} does not allow {action}');
    expect(englishT('fleetApplications.toast.approveFailed')).toBe('Driver application approval could not be completed. Try again.');
    expect(ar.fleetApplications.tabs.decisions).toBe('القرارات');
    expect(ar.fleetApplications.actions.rejectApplication).toBe('رفض الطلب');
  });
});
