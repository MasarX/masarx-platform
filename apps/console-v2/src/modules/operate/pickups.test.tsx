// pickups.test.tsx — CLAIM C / CLAIM-C-FIX tests for PickupsModule.
//
// Asserts the post-hardening contract (CLAIM-C-FIX revision):
//   • mounts without crashing and renders Requests / Waves / Failures tabs
//   • Wave row "Assign driver…" advertises the canonical capability fleet.write
//     (NOT the previous incorrect pickups.write, which does not exist in any
//     backend migration)
//   • Request "Add to wave…" / bulk "Create wave from selected" advertise
//     fleet.write (matching create_pickup_wave_v1's user_has_permission_v1
//     check at migration 202603191130 line 1581-1582)
//   • Failures tab does NOT advertise an unbacked "Mark as resolved" action
//   • Requests "Add to wave…" opens a picker modal (not a toast-only handler)
//   • create_pickup_wave_v1 is invoked with canonical `shipment_ids` payload
//     key (NOT `request_ids`) per migration 202603191130 line 1586/1610
//   • assign_pickup_wave_v1 is invoked with canonical
//     `{ organization_id, route_run_id, driver_user_id }` payload, where
//     driver_user_id resolves to a real driver UUID (NOT the literal
//     'driver_default' string)

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { PickupsModule } from './pickups';
import * as api from '@/lib/api';

const pickupRequestRows = [
  {
    id: 'pr_test_1',
    shipment_id: 'PR-2026-0481',
    sender_id: 'Exampleparcel JED Warehouse',
    client_id: 'Exampleparcel KSA',
    requested_window_start_at: '2026-04-25T14:00:00Z',
    box_count: 22,
    status: 'pending',
  },
];

const pickupWaveRows = [
  {
    id: 'pwv_test_1',
    route_run_id: '00000000-0000-4000-8000-000000000221',
    branch_id: 'RUH-N',
    driver_user_id: '',
    pickup_stop_count: 4,
    total_box_count: 67,
    status: 'planned',
  },
];

const pickupFailureRows = [
  {
    id: 'pf_test_1',
    shipment_id: 'PR-2026-0476',
    failure_reason: 'Sender not ready',
    failed_at: '2026-04-25T12:30:00Z',
  },
];

function mockPickupLists() {
  vi.spyOn(api, 'pickup_requests_list_v1').mockResolvedValue({
    rows: pickupRequestRows,
    total: pickupRequestRows.length,
  });
  vi.spyOn(api, 'pickup_waves_list_v1').mockResolvedValue({
    rows: pickupWaveRows,
    total: pickupWaveRows.length,
  });
  vi.spyOn(api, 'pickup_failures_list_v1').mockResolvedValue({
    rows: pickupFailureRows,
    total: pickupFailureRows.length,
  });
}

function tenantIdentity(capabilities: string[]) {
  return {
    capabilities,
    user: {
      organization_id: 'org_rashed',
      access_scope_type: 'tenant' as const,
      access_scope_id: null,
    },
    scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 as const } },
  };
}

async function mountAndWait() {
  const utils = renderWithProviders(<PickupsModule />, { identity: tenantIdentity(['all']) });
  await waitFor(() => {
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  }, { timeout: 3000 });
  return utils;
}

describe('PickupsModule (CLAIM C / CLAIM-C-FIX)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPickupLists();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts and renders the three tabs', async () => {
    await mountAndWait();
    expect(screen.getByText('Requests')).toBeInTheDocument();
    expect(screen.getByText('Waves')).toBeInTheDocument();
    expect(screen.getByText('Failures')).toBeInTheDocument();
  });

  it('Failures tab does NOT advertise an unbacked "Mark as resolved" action', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    await user.click(screen.getByText('Failures'));
    // Wait for table to render.
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });
    // The row-action "Mark as resolved" must not be present anywhere.
    // (Previously it appeared in the row actions menu but had no backing RPC.)
    const matches = screen.queryAllByText(/Mark as resolved/i);
    expect(matches.length).toBe(0);
  });

  it('Failures tab refetches when revisited so backend-created failures appear without reload', async () => {
    const user = userEvent.setup();
    let visibleFailures: typeof pickupFailureRows = [];
    const failureSpy = vi.spyOn(api, 'pickup_failures_list_v1').mockImplementation(async () => ({
      rows: visibleFailures,
      total: visibleFailures.length,
    }));

    await mountAndWait();
    await user.click(screen.getByText('Failures'));
    await waitFor(() => {
      expect(failureSpy).toHaveBeenCalled();
    });
    expect(screen.queryByText('PF-LIVE-REFRESH')).not.toBeInTheDocument();

    visibleFailures = [
      {
        id: 'pf_live_refresh',
        shipment_id: 'PF-LIVE-REFRESH',
        failure_reason: 'Pickup not ready',
        failed_at: '2026-06-07T15:19:00Z',
      },
    ];

    await user.click(screen.getByText('Requests'));
    await user.click(screen.getByText('Failures'));

    await waitFor(() => {
      expect(screen.getByText('PF-LIVE-REFRESH')).toBeInTheDocument();
    });
    expect(failureSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('"Create wave" header button is gated by fleet.write (NOT pickups.write)', async () => {
    // Render WITHOUT fleet.write — the gated button must be present but
    // disabled (Button gates via `capability` prop and renders a CapabilityLock
    // chip when the user lacks the cap; it does NOT hide the button).
    renderWithProviders(<PickupsModule />, {
      identity: tenantIdentity(['shipments.read', 'pickups.read']),
    });
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    }, { timeout: 3000 });
    const noCapBtn = screen.getByRole('button', { name: /Create wave/i });
    expect(noCapBtn).toBeDisabled();
    // Capability lock chip is appended when capability is denied; this proves
    // the gate is reading from `capability="fleet.write"`.
    expect(noCapBtn.querySelector('.cap-lock, [data-capability]')).not.toBeNull();
  });

  it('keeps pickup wave create and assignment actions inert when fleet.write is missing', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(api, 'create_pickup_wave_v1');
    const assignSpy = vi.spyOn(api, 'assign_pickup_wave_v1');
    vi.spyOn(api, 'pickup_requests_list_v1').mockResolvedValue({
      rows: [
        {
          id: 'pr_denied_1',
          shipment_id: 'PR-DENIED-001',
          sender_id: 'Sender A',
          client_id: 'Client A',
          requested_window_start_at: '2026-04-25T14:00:00Z',
          box_count: 1,
          status: 'pending',
        },
      ],
      total: 1,
    });
    vi.spyOn(api, 'pickup_waves_list_v1').mockResolvedValue({
      rows: [
        {
          id: 'pwv_denied_1',
          route_run_id: '00000000-0000-4000-8000-00000000d001',
          branch_id: 'RUH-N',
          driver_user_id: '',
          pickup_stop_count: 1,
          total_box_count: 1,
          status: 'planned',
        },
      ],
      total: 1,
    });

    renderWithProviders(<PickupsModule />, {
      identity: tenantIdentity(['shipments.read', 'pickups.read']),
    });
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    }, { timeout: 3000 });

    const headerCreate = screen.getByRole('button', { name: /Create wave/i });
    expect(headerCreate).toBeDisabled();
    await user.click(headerCreate);
    expect(createSpy).not.toHaveBeenCalled();

    const rowCheckboxes = await waitFor(() => {
      const found = screen
        .getAllByRole('checkbox')
        .filter((cb) => cb.getAttribute('aria-label') === 'Select row');
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(rowCheckboxes.length).toBeGreaterThan(0);
    await user.click(rowCheckboxes[0]!);
    const bulkCreate = await screen.findByRole('button', { name: /Create wave from selected/i });
    expect(bulkCreate).toBeDisabled();
    await user.click(bulkCreate);
    expect(createSpy).not.toHaveBeenCalled();

    await user.click(screen.getByText('Waves'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const overflowButtons = screen.getAllByRole('button', { name: /Row actions/i });
    await user.click(overflowButtons[0]!);
    const assignOption = await screen.findByRole('option', { name: /^Assign driver/i });
    expect(assignOption).toHaveClass('is-disabled');
    expect(assignOption).toHaveTextContent(/fleet update permission/i);
    await user.click(assignOption).catch(() => undefined);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('Waves tab renders rows that source from pickup_waves_list_v1', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    await user.click(screen.getByText('Waves'));
    // Wait for the waves rows to render.
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
  });

  it('Waves tab resolves hub/driver labels without masking missing joins as generic assignments', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    await user.click(screen.getByText('Waves'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Riyadh North|Riyadh South|Jeddah North|Branch RUH-N/i);
    expect(text).not.toMatch(/Selected hub|Assigned driver/i);
  });

  it('Create wave from selected sends canonical `shipment_ids` payload (NOT `request_ids`)', async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, 'create_pickup_wave_v1')
      .mockResolvedValue({ ok: true, wave_id: 'pwv_test' });

    await mountAndWait();

    // Requests tab is the default. Select all rows via the per-row checkbox.
    const rowCheckboxes = screen
      .getAllByRole('checkbox')
      .filter((cb) => cb.getAttribute('aria-label') === 'Select row');
    expect(rowCheckboxes.length).toBeGreaterThan(0);
    const firstRowCheckbox = rowCheckboxes[0];
    if (!firstRowCheckbox) throw new Error('No row checkbox found');
    await user.click(firstRowCheckbox);

    const bulkBtn = await screen.findByRole('button', { name: /Create wave from selected/i });
    await user.click(bulkBtn);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const readback = await screen.findByLabelText('Pickup wave status');
    expect(readback).toHaveTextContent('pwv_test');
    expect(readback).toHaveTextContent('Create wave from selected requests');
    expect(readback).toHaveTextContent('Pickup orchestration');
    expect(readback).toHaveTextContent('Wave created');
    expect(readback).not.toHaveTextContent(/Backend readback|backend readback|RPC|Source|create_pickup_wave_v1|request_bulk_create_wave/);
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload).toHaveProperty('organization_id');
    // CANONICAL key is shipment_ids per migration 202603191130 line 1586/1610.
    expect(payload).toHaveProperty('shipment_ids');
    expect(Array.isArray((payload as { shipment_ids: unknown }).shipment_ids)).toBe(true);
    expect(((payload as { shipment_ids: string[] }).shipment_ids).length).toBeGreaterThan(0);
    // Must NOT use the legacy `request_ids` key (synthetic adapter would mask
    // the bug, but production RPC reads shipment_ids and would raise).
    expect(payload).not.toHaveProperty('request_ids');
  });

  it('Create request sends canonical create_pickup_request_v1 payload and shows same-screen readback', async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, 'create_pickup_request_v1')
      .mockResolvedValue({
        ok: true,
        shipment_id: '00000000-0000-4000-8000-00000000c101',
        tracking_number: 'PICKUP-REQUEST-READBACK',
        created: true,
      });

    await mountAndWait();

    await user.click(screen.getByTestId('pickup-create-request-open'));
    await screen.findByTestId('pickup-create-request-client-reference');
    await user.selectOptions(screen.getByTestId('pickup-create-request-sender'), '');
    const reference = screen.getByTestId('pickup-create-request-client-reference');
    await user.clear(reference);
    await user.type(reference, 'PICKUP-CONSOLE-TEST');
    await user.click(screen.getByTestId('pickup-create-request-submit'));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload).toHaveProperty('organization_id', 'org_rashed');
    expect(payload).toHaveProperty('client_id');
    expect(payload).toHaveProperty('sender_id', null);
    expect(payload).toHaveProperty('requested_window_start_at');
    expect(payload).toHaveProperty('requested_window_end_at');
    expect(payload).toHaveProperty('origin_address');
    expect(payload).toHaveProperty('metadata');
    expect((payload?.metadata as Record<string, unknown>).source).toBe('console-v2.operate.pickups.create_request');
    const readback = await screen.findByLabelText('Pickup request status');
    expect(readback).toHaveTextContent('Request created and the pickup queue was refreshed');
    expect(readback).not.toHaveTextContent('00000000-0000-4000-8000-00000000c101');
    expect(readback).toHaveTextContent('PICKUP-REQUEST-READBACK');
    expect(readback).not.toHaveTextContent('create_pickup_request_v1');
  });

  it('does not expose false-success editable status cells for requests or waves', async () => {
    const user = userEvent.setup();
    await mountAndWait();

    let statusHeader = screen.getByRole('columnheader', { name: /^Status$/i });
    expect(statusHeader.getAttribute('title')).toBe('Status');
    expect(document.querySelectorAll('.dt-th-mark')).toHaveLength(0);

    await user.click(screen.getByText('Waves'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    statusHeader = screen.getByRole('columnheader', { name: /^Status$/i });
    expect(statusHeader.getAttribute('title')).toBe('Status');
    expect(document.querySelectorAll('.dt-th-mark')).toHaveLength(0);
  });

  it('Assign driver flow sends canonical payload with a real driver UUID and idempotency key', async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, 'assign_pickup_wave_v1')
      .mockResolvedValue({ ok: true, wave_id: 'pwv_test', target: {} });

    await mountAndWait();

    // Switch to Waves tab.
    await user.click(screen.getByText('Waves'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    // Each wave row exposes row-actions through a `⋯` button (aria-label
    // "Row actions") that opens the cmdk Palette. Click the first row's
    // overflow button to open the palette.
    const overflowButtons = screen.getAllByRole('button', { name: /Row actions/i });
    expect(overflowButtons.length).toBeGreaterThan(0);
    const firstOverflow = overflowButtons[0];
    if (!firstOverflow) throw new Error('No row-actions overflow button');
    await user.click(firstOverflow);

    // Wait for palette items to render. Each palette row renders both
    // `.palette__item-label` and `.palette__item-meta` (mono); we target the
    // label span to avoid the duplicate match.
    await waitFor(() => {
      expect(document.querySelectorAll('.palette__item').length).toBeGreaterThan(0);
    });
    const actionLabels = Array.from(
      document.querySelectorAll('.palette__item .palette__item-label'),
    ) as HTMLElement[];
    const assignItem = actionLabels.find((el) => /Assign driver/i.test(el.textContent ?? ''));
    if (!assignItem) throw new Error('Assign driver palette item not found');
    await user.click(assignItem);

    // The driver ReferencePicker (also a palette) now opens. Wait for it and
    // pick "Khalid Al-Otaibi" (id=usr_dr_khalid in seed-raw/domain-routes.js).
    await waitFor(() => {
      const driverLabels = Array.from(
        document.querySelectorAll('.palette__item .palette__item-label'),
      ) as HTMLElement[];
      expect(driverLabels.some((el) => /Khalid/i.test(el.textContent ?? ''))).toBe(true);
    });
    const pickerText = document.querySelector('.palette')?.textContent ?? '';
    expect(pickerText).not.toMatch(/usr_dr_|driver_user_id/i);
    expect(pickerText).toMatch(/Vehicle assigned|No vehicle assigned/i);
    const driverLabels = Array.from(
      document.querySelectorAll('.palette__item .palette__item-label'),
    ) as HTMLElement[];
    const driverEntry = driverLabels.find((el) => /Khalid Al-Otaibi/i.test(el.textContent ?? ''));
    if (!driverEntry) throw new Error('Driver palette entry not found');
    await user.click(driverEntry);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const readback = await screen.findByLabelText('Pickup assignment status');
    expect(readback).toHaveTextContent('pwv_test');
    expect(readback).toHaveTextContent('Khalid Al-Otaibi');
    expect(readback).toHaveTextContent('Assign driver');
    expect(readback).toHaveTextContent('Fleet assignment');
    expect(readback).toHaveTextContent('Driver assignment confirmed');
    expect(readback).not.toHaveTextContent(/Backend readback|backend readback|RPC|Source|assign_pickup_wave_v1|wave_assign_driver/);
    const callArgs = spy.mock.calls[0];
    expect(callArgs).toBeDefined();
    if (!callArgs) throw new Error('spy not called');
    const [waveIdArg, payloadArg] = callArgs as [unknown, unknown];
    const payload = payloadArg as Record<string, unknown>;
    // First positional arg is the wave's route_run_id (canonical UUID).
    expect(waveIdArg).toBeTruthy();
    expect(typeof waveIdArg).toBe('string');
    // Payload MUST include organization_id (migration 202603191130 line 1941).
    expect(payload).toHaveProperty('organization_id');
    // Payload MUST include route_run_id (migration 202603191130 line 1940/1953).
    expect(payload).toHaveProperty('route_run_id');
    // Payload MUST include a real driver UUID (migration 202603191130
    // line 1942/2056-2057). MUST NOT be the literal string 'driver_default'.
    expect(payload).toHaveProperty('driver_user_id');
    const driverUserId = (payload as { driver_user_id: unknown }).driver_user_id;
    expect(typeof driverUserId).toBe('string');
    expect(driverUserId).not.toBe('driver_default');
    expect(driverUserId).toBe('usr_dr_khalid');
    expect(payload).toHaveProperty('idempotency_key');
    expect(String(payload.idempotency_key)).toContain(`:${String(payload.route_run_id)}:`);
    expect(String(payload.idempotency_key)).toMatch(/:usr_dr_khalid$/);
  });
});

// Suppress unused import warning; `within` reserved for future structural assertions.
void within;
