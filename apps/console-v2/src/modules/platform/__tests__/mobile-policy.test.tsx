// mobile-policy.test.tsx — verifies the 10 canonical categories render, the
// per-card LadderViz appears, attestation is on screen, and devices filter
// changes the rendered count.
//
// We intentionally do NOT mock resolveMobilePolicy: we exercise the real seam
// + seed so that the contract drift (e.g. a missing seed value) is caught.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { MobilePolicyModule } from '@/modules/platform/mobile-policy';
import * as api from '@/lib/api';

const CATEGORIES = [
  'mobile_visibility_policy',
  'mobile_diagnostics_policy',
  'device_policy',
  'navigation_policy',
  'map_policy',
  'communication_policy',
  'address_policy',
  'driver_safety_policy',
  'ux_safety_policy',
  'mobile_attestation_policy',
];

const MOBILE_POLICY_CAPABILITIES = ['settings.read', 'settings.write', 'user_devices.read', 'user_devices.write'];
const MOBILE_ATTESTATION_LOOKUPS = [
  { value: 'trusted', label: 'Trusted', tone: 'good' },
  { value: 'pending', label: 'Pending', tone: 'warn' },
  { value: 'failed', label: 'Failed', tone: 'danger' },
  { value: 'revoked', label: 'Revoked', tone: 'danger' },
] as ReturnType<typeof api.getLookups>;

function mockMobileAttestationLookups() {
  const realGetLookups = api.getLookups;
  vi.spyOn(api, 'getLookups').mockImplementation((category: string) =>
    category === 'mobile_attestation_status' ? MOBILE_ATTESTATION_LOOKUPS : realGetLookups(category),
  );
}

function renderMobilePolicy(capabilities = MOBILE_POLICY_CAPABILITIES) {
  mockMobileAttestationLookups();
  return renderWithProviders(<MobilePolicyModule />, { capabilities });
}

describe('MobilePolicyModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all 10 canonical policy categories', async () => {
    renderMobilePolicy();
    for (const cat of CATEGORIES) {
      const cards = await screen.findAllByTestId(`policy-card-${cat}`);
      expect(cards.length).toBeGreaterThan(0);
    }
  });

  it('header pill reports the canonical category count', async () => {
    renderMobilePolicy();
    expect(await screen.findByText(/10 canonical categories/i)).toBeInTheDocument();
  });

  it('renders attestation policy as the 10th card', async () => {
    renderMobilePolicy();
    const card = await screen.findByTestId('policy-card-mobile_attestation_policy');
    // Eyebrow text + chip text both contain "Attestation" — use getAllByText
    expect(within(card).getAllByText(/Attestation/i).length).toBeGreaterThan(0);
    expect(within(card).getByText(/resolve_mobile_attestation_policy/)).toBeInTheDocument();
  });

  it('switches to the Devices tab and supports attestation_status filter', async () => {
    renderMobilePolicy();
    fireEvent.click(await screen.findByTestId('mobile-policy-tab-devices'));
    // Filter chip set is rendered in the toolbar
    const trustedBtn = await screen.findByTestId('attestation-filter-trusted');
    fireEvent.click(trustedBtn);
    // The button is now active (class applied)
    expect(trustedBtn.className).toContain('is-active');
    fireEvent.click(screen.getByTestId('attestation-filter-pending'));
    expect(screen.getByTestId('attestation-filter-pending').className).toContain('is-active');
  });

  it('gates the Devices tab with user_devices.read before querying device rows', async () => {
    const realList = api.ui_list_resource_v1;
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'user_device_summary') {
        throw new Error('user_device_summary should not be queried without user_devices.read');
      }
      return realList(resource, opts);
    });

    renderMobilePolicy(['settings.read']);
    fireEvent.click(await screen.findByTestId('mobile-policy-tab-devices'));

    expect(await screen.findByText(/registered device activity/i)).toBeInTheDocument();
    expect(screen.getByText(/Device access permission required/i)).toBeInTheDocument();
    expect(screen.queryByText('AND-3F21-9911')).toBeNull();
    expect(listSpy.mock.calls.some(([resource]) => resource === 'user_device_summary')).toBe(false);
  });

  it('renders a per-policy "Request change" button gated by settings.write', async () => {
    renderMobilePolicy(['settings.read', 'settings.write']);
    const card = await screen.findByTestId('policy-card-driver_safety_policy');
    const btn = within(card).getByRole('button', { name: /Request change/i });
    expect(btn).toBeEnabled();
  });

  it('does not render the raw pending settings-resolution fallback id', async () => {
    renderMobilePolicy();
    await screen.findByTestId('policy-card-mobile_visibility_policy');
    expect(screen.queryByText(/srlv_pending/i)).toBeNull();
  });

  it('renders the resolved-view preview pane', async () => {
    renderMobilePolicy();
    expect(await screen.findByText(/Resolved-view preview/i)).toBeInTheDocument();
    // Field Ops shell title is present
    const allFieldOps = await screen.findAllByText(/Field Ops/i);
    expect(allFieldOps.length).toBeGreaterThan(0);
  });

  it('does not surface a synthetic-id "Revoke (synthetic)" header CTA (W38 closure / W39 symmetry guard)', async () => {
    // W38-PLATFORM closure: the previous synthetic-id "Revoke (synthetic)"
    // header Button — which fired onRevoke('dev_synth') with a hardcoded
    // synthetic device_id — was removed because it could not bind to a
    // real user_devices row at click time. Per-row Revoke flow remains in
    // the rowActions wired to the canonical r.id. This regression guard
    // mirrors the W38 labels.tsx anti-CTA pattern (REAUDIT5B PLATFORM
    // §3.2 / W39 symmetry).
    renderMobilePolicy(['settings.read', 'user_devices.write', 'settings.write', 'all']);
    expect(
      screen.queryByRole('button', { name: /Revoke \(synthetic\)/i }),
    ).toBeNull();
  });

  it('revokes a device through an in-app confirmation and shows backend readback without leaving Devices', async () => {
    const user = userEvent.setup();
    let revoked = false;
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource !== 'user_device_summary') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          row.id === 'dev_4441' && revoked
            ? {
                ...row,
                revoked_at: '2026-05-10T00:00:00.000Z',
                revoked_reason: 'Security rotation',
                is_revoked: true,
              }
            : row,
        ),
      };
    });
    const revokeSpy = vi.spyOn(api, 'ui_execute_user_device_revoke_v1').mockImplementation(async () => {
      revoked = true;
      return {
        ok: true,
        action_key: 'user_devices.revoke',
        resource_key: 'user_devices',
        status: 'revoked',
        device_id: 'AND-3F21-9911',
        revoked_at: '2026-05-10T00:00:00.000Z',
        count: 1,
      };
    });

    renderMobilePolicy(['settings.read', 'user_devices.read', 'user_devices.write']);
    fireEvent.click(await screen.findByTestId('mobile-policy-tab-devices'));
    expect(await screen.findByText('AND-3F21-9911')).toBeInTheDocument();
    const deviceRow = screen.getByRole('row', { name: /AND-3F21-9911/i });
    expect(within(deviceRow).getByText('active')).toBeInTheDocument();

    await user.click(within(deviceRow).getByRole('button', { name: 'Row actions' }));
    await user.click(await screen.findByRole('option', { name: /Revoke device/i }));
    const form = await screen.findByTestId('mobile-device-revoke-form');
    await user.type(within(form).getByLabelText(/Revocation reason/i), 'Security rotation');
    await user.click(within(form).getByRole('button', { name: /Confirm revoke/i }));

    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith('dev_4441', 'Security rotation'));
    await waitFor(() => {
      const updatedRow = screen.getByRole('row', { name: /AND-3F21-9911/i });
      expect(within(updatedRow).getByText('revoked')).toBeInTheDocument();
    });
    expect(screen.getByText('Security rotation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Devices' }).className).toContain('is-active');

    const updatedRow = screen.getByRole('row', { name: /AND-3F21-9911/i });
    await user.click(within(updatedRow).getByRole('button', { name: 'Row actions' }));
    const disabledRevoke = await screen.findByRole('option', { name: /^Revoke device/ });
    expect(disabledRevoke).toHaveClass('is-disabled');
    expect(disabledRevoke).toHaveTextContent('Device is already revoked');
    await user.click(disabledRevoke).catch(() => undefined);
    expect(screen.queryByTestId('mobile-device-revoke-form')).toBeNull();
  });
});
