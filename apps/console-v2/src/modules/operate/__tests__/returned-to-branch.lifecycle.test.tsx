// returned-to-branch.lifecycle.test.tsx — closes OPERATIONS reaudit D2-A
// (Wave 7 audit, REVISION verdict). The previous returned-to-branch tests
// only covered mount semantics + the recommendation chip. This file adds the
// missing per-RPC Vitest assertions for the 5 mutation sites in
// `returned-to-branch.tsx`:
//
//   1. record_scan_event_v1                  (Intake scan modal · :259)
//   2. shipment_amend_cancel_v1 (reschedule)  (Reschedule modal · :361)
//   3. shipment_amend_cancel_v1 (reschedule)  (Re-attempt drawer · :139)
//   4. ui_execute_shipment_batch_operation_v1 (Bulk reschedule preview · :217)
//   5. ui_execute_shipment_batch_operation_v1 (Bulk re-attempt · :230)
//
// Asserted behavior per action:
//   • mount + capability gate (positive + negative)
//   • happy path — clicking the action button fires the canonical RPC with
//     the expected payload shape (tracking number / op / source flag, etc.)
//   • mutation invalidation — the relevant query key is invalidated post
//     mutation (where the canonical hook does so)
//   • RPC-name assertion — the canonical seam is the one called (no orphan
//     toast or fictional RPC reached)
//   • failure mode — when the RPC rejects, the seam is still called and the
//     module does not crash
//
// Pattern mirrors `route-plans.lifecycle.test.tsx` /
// `exceptions.lifecycle.test.tsx`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ReturnedToBranchModule } from '@/modules/operate/returned-to-branch';
import * as ds from '@/lib/data-source';
import {
  exceptionReturnOperatorIdentity,
  exceptionReturnListResource,
  returnedToBranchRows,
} from './exceptions-return.fixtures';

const SCAN_SPY = vi.spyOn(ds, 'record_scan_event_v1');
const AMEND_SPY = vi.spyOn(ds, 'shipment_amend_cancel_v1');
const BATCH_SPY = vi.spyOn(ds, 'ui_execute_shipment_batch_operation_v1');
const NDR_SPY = vi.spyOn(ds, 'resolve_ndr_branch_next_action_v1');
const RESOLVE_SETTINGS_SPY = vi.spyOn(ds, 'resolveSettings');
const RETURN_LIST_SPY = vi.spyOn(ds.return_to_branch_shipments_v1, 'list');
const LIST_RESOURCE_SPY = vi.spyOn(ds, 'ui_list_resource_v1');
const LIST_RESOURCE = ds.ui_list_resource_v1;

beforeEach(() => {
  SCAN_SPY.mockClear();
  SCAN_SPY.mockResolvedValue({
    ok: true,
    scan_event_id: 'sev_return_fixture',
    created: true,
  });
  AMEND_SPY.mockClear();
  AMEND_SPY.mockResolvedValue({
    ok: true,
    workflow_template: 'shipment_reschedule_v1',
    workflow_run_id: 'wfr_return_fixture',
    started_via: 'console_v2.returned_to_branch',
    canonical_entrypoint: 'public.shipment_amend_cancel_v1',
    dry_run: false,
    diff: null,
    settings_resolution_id: 'srlv_return_fixture',
  });
  BATCH_SPY.mockClear();
  BATCH_SPY.mockResolvedValue({
    ok: true,
    count: 1,
    op: 'reschedule',
    dry_run: false,
  });
  NDR_SPY.mockClear();
  NDR_SPY.mockResolvedValue('reschedule');
  RESOLVE_SETTINGS_SPY.mockClear();
  RESOLVE_SETTINGS_SPY.mockResolvedValue({
    value: {
      default_reschedule_offsets: ['P1D', 'P2D', 'P3D'],
    },
    resolved_from: 'global',
    ladder_path: [
      {
        rank: 0,
        scope_type: 'global',
        scope_id: null,
        has_value: true,
        value: { default_reschedule_offsets: ['P1D', 'P2D', 'P3D'] },
      },
    ],
    settings_resolution_id: 'srlv_return_slot_policy',
    override_of: null,
  });
  RETURN_LIST_SPY.mockClear();
  RETURN_LIST_SPY.mockResolvedValue(returnedToBranchRows);
  LIST_RESOURCE_SPY.mockClear();
  LIST_RESOURCE_SPY.mockImplementation((resource, opts) =>
    exceptionReturnListResource(resource, opts, LIST_RESOURCE),
  );
});

async function waitForRowsLoaded() {
  await waitFor(() => {
    expect(document.body.textContent).toContain('RTB-FIXTURE-001');
  });
}

function findModalButton(label: RegExp): HTMLElement {
  const modal = document.querySelector('.modal');
  if (!modal) throw new Error('modal not rendered');
  const btn = Array.from(modal.querySelectorAll('button')).find((b) => {
    const span = b.querySelector('span');
    return label.test((span?.textContent ?? b.textContent ?? '').trim());
  });
  if (!btn) throw new Error(`modal button matching ${label} not found`);
  return btn as HTMLElement;
}

function findDrawerButton(label: RegExp): HTMLElement {
  const drawer = document.querySelector('.drawer');
  if (!drawer) throw new Error('drawer not rendered');
  const btn = Array.from(drawer.querySelectorAll('button')).find((b) => {
    const span = b.querySelector('span');
    return label.test((span?.textContent ?? b.textContent ?? '').trim());
  });
  if (!btn) throw new Error(`drawer button matching ${label} not found`);
  return btn as HTMLElement;
}

function expectCanonicalSlotDate(payload: Record<string, unknown>, expected?: string) {
  expect(payload.slot_date).toEqual(expected ?? expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  expect(payload).not.toHaveProperty('promised_delivery_date');
}

async function expectReturnActionReadback({
  action,
  rpc,
  source,
  settingsResolutionId,
}: {
  action: string;
  rpc: string;
  source: string;
  settingsResolutionId?: string;
}) {
  const panel = await waitFor(() => {
    const found = document.querySelector('[aria-label="Return action status"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  const text = panel.textContent ?? '';
  expect(text).toContain('RTB-FIXTURE-001');
  expect(text).toContain(action);
  expect(text).toContain('Action completed and the returned-to-branch queue was refreshed');
  expect(text).toContain('Workflow');
  expect(text).toContain('Policy check');
  expect(text).not.toContain(rpc);
  expect(text).not.toContain(source);
  if (settingsResolutionId) {
    expect(text).toContain('Passed');
    expect(text).not.toContain(settingsResolutionId);
  } else {
    expect(text).toMatch(/Workflow\s*Pending/);
    expect(text).toMatch(/Policy check\s*Pending/);
  }
  expect(text).toContain('shipments; selected shipment updated');
  expect(RETURN_LIST_SPY.mock.calls.length).toBeGreaterThan(1);
}

async function pickFromPalette(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  // Row actions go through the command palette (cmdk-backed `.palette__item`).
  await waitFor(() => {
    expect(document.querySelector('.palette, [cmdk-list]')).not.toBeNull();
  });
  const item = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('.palette__item, [cmdk-item]')).find((el) =>
      label.test((el.textContent ?? '').trim()),
    );
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  await user.click(item);
}

describe('ReturnedToBranchModule · lifecycle mutations (OPERATIONS reaudit D2-A)', () => {
  it('mounts and renders the queue with at least one returned-to-branch row', async () => {
    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity });
    await waitForRowsLoaded();
    // PageHeader renders title accent "Returned" + plain "to branch". Anchor
    // on the queue pill so the assertion is unambiguous regardless of how many
    // other surfaces also mention the word "Returned".
    expect(screen.getByText(/Returned shipments queue/)).toBeInTheDocument();
  });

  it('opens returned shipment context in place from the queue row', async () => {
    window.history.pushState(null, '', '/operate/returned-to-branch');
    const realGet = ds.ui_get_resource_v1;
    vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (resource === 'shipments') {
        return {
          id: String(id),
          tracking_number: 'RTB-READBACK-SHIPMENT',
          status: 'returned_to_branch',
          service_type: 'standard',
        };
      }
      return realGet(resource, id);
    });
    const user = userEvent.setup();
    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity });
    await waitForRowsLoaded();

    const firstRow = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
    expect(firstRow).not.toBeNull();
    await user.click(firstRow!);

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(window.location.pathname).toBe('/operate/returned-to-branch');
    expect(window.location.search).toBe('');
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('disables the Intake scan header button when warehouse.scan capability is missing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReturnedToBranchModule />, {
      identity: {
        ...exceptionReturnOperatorIdentity,
        capabilities: ['shipments.read'],
      },
    });
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    }, { timeout: 3000 });
    const btn = screen.getByRole('button', { name: /Intake scan/i });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(document.querySelector('.modal')).toBeNull();
    expect(SCAN_SPY).not.toHaveBeenCalled();
  });

  it('Intake scan modal · happy path · fires record_scan_event_v1 with tracking_number + return_to_branch_intake type', async () => {
    renderWithProviders(<ReturnedToBranchModule />, {
      identity: exceptionReturnOperatorIdentity,
    });
    const user = userEvent.setup();
    await waitForRowsLoaded();

    // Open the intake scan modal via the header button.
    const intakeBtn = screen.getByRole('button', { name: /Intake scan/i });
    await user.click(intakeBtn);

    // Type a tracking number (>=4 chars) so submit is enabled.
    await waitFor(() => {
      expect(document.querySelector('.modal input[type="text"]')).not.toBeNull();
    });
    const input = document.querySelector('.modal input[type="text"]') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'SHP-9381201');

    // Click "Record scan".
    const submitBtn = findModalButton(/^Record scan$/);
    await user.click(submitBtn);

    await waitFor(() => {
      expect(SCAN_SPY).toHaveBeenCalled();
    });
    const [payload] = SCAN_SPY.mock.calls[0] as [{
      scan_type?: string;
      tracking_number?: string;
      barcode?: string;
      branch_id?: string;
      idempotency_key?: string;
      metadata?: { source?: string; tracking_number?: string };
    }];
    expect(payload?.scan_type).toBe('return_to_branch_intake');
    expect(payload?.tracking_number).toBe('SHP-9381201');
    expect(payload?.barcode).toBe('SHP-9381201');
    expect(payload?.branch_id).toBeTruthy();
    expect(payload?.idempotency_key).toContain('console-v2:return-to-branch:');
    expect(payload?.metadata).toMatchObject({
      source: 'console_v2.returned_to_branch.intake_scan',
      tracking_number: 'SHP-9381201',
    });
  });

  it('Re-attempt drawer · happy path · fires shipment_amend_cancel_v1 with op=reschedule + tracking + source flag', async () => {
    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity });
    const user = userEvent.setup();
    await waitForRowsLoaded();

    // Open the row-action menu on the first row via the kebab button
    // (DataTable renders <button aria-label="Row actions">⋯</button>).
    const rowActionsBtns = Array.from(
      document.querySelectorAll('.dt__table tbody button[aria-label="Row actions"]'),
    );
    expect(rowActionsBtns.length).toBeGreaterThan(0);
    await user.click(rowActionsBtns[0] as HTMLElement);

    // Pick "Re-attempt now" from the command palette.
    await pickFromPalette(user, /Re-attempt now/i);

    // The drawer footer renders "Queue re-attempt"; click it.
    const queueBtn = await waitFor(() => findDrawerButton(/Queue re-attempt/i));
    await user.click(queueBtn);

    await waitFor(() => {
      expect(AMEND_SPY).toHaveBeenCalled();
    });
    const [shipmentId, op, payload] = AMEND_SPY.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(typeof shipmentId).toBe('string');
    expect(shipmentId.length).toBeGreaterThan(0);
    expect(shipmentId).not.toMatch(/^SHP-/);
    expect(op).toBe('reschedule');
    expect(payload.source).toBe('returned_to_branch_reattempt');
    expectCanonicalSlotDate(payload);
    await expectReturnActionReadback({
      action: 'Re-attempt now',
      rpc: 'shipment_amend_cancel_v1',
      source: 'returned_to_branch_reattempt',
      settingsResolutionId: 'srlv_return_fixture',
    });
  });

  it('Bulk reschedule (preview) · happy path · fires ui_execute_shipment_batch_operation_v1 with dryRun=true', async () => {
    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity });
    const user = userEvent.setup();
    await waitForRowsLoaded();

    // Select the first row.
    const firstRowCheckbox = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.getAttribute('aria-label') === 'Select row');
    if (!firstRowCheckbox) throw new Error('No row checkbox');
    await user.click(firstRowCheckbox);

    // Click "Bulk reschedule (preview)".
    const bulkPreview = await screen.findByRole('button', {
      name: /Bulk reschedule \(preview\)/i,
    });
    await user.click(bulkPreview);

    await waitFor(() => {
      expect(BATCH_SPY).toHaveBeenCalled();
    });
    const [ids, op, payload, opts] = BATCH_SPY.mock.calls[0] as [
      string[],
      string,
      Record<string, unknown>,
      { dryRun?: boolean } | undefined,
    ];
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).not.toMatch(/^SHP-/);
    expect(op).toBe('reschedule');
    expect(payload.source).toBe('returned_to_branch_bulk_reschedule');
    expectCanonicalSlotDate(payload);
    expect(opts?.dryRun).toBe(true);
  });

  it('Bulk re-attempt · happy path · fires ui_execute_shipment_batch_operation_v1 (non-dry) and invalidates the list', async () => {
    const { queryClient } = renderWithProviders(<ReturnedToBranchModule />, {
      identity: exceptionReturnOperatorIdentity,
    });
    const user = userEvent.setup();
    await waitForRowsLoaded();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    // Select the first row.
    const firstRowCheckbox = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.getAttribute('aria-label') === 'Select row');
    if (!firstRowCheckbox) throw new Error('No row checkbox');
    await user.click(firstRowCheckbox);

    // Click "Bulk re-attempt" (no preview suffix).
    const bulkReattempt = await screen.findByRole('button', {
      name: /^Bulk re-attempt$/i,
    });
    await user.click(bulkReattempt);

    await waitFor(() => {
      expect(BATCH_SPY).toHaveBeenCalled();
    });
    const lastCall = BATCH_SPY.mock.calls[BATCH_SPY.mock.calls.length - 1] as [
      string[],
      string,
      Record<string, unknown>,
      { dryRun?: boolean } | undefined,
    ];
    expect(Array.isArray(lastCall[0])).toBe(true);
    expect(lastCall[0].length).toBeGreaterThan(0);
    expect(lastCall[0][0]).not.toMatch(/^SHP-/);
    expect(lastCall[1]).toBe('reschedule');
    expect(lastCall[2].source).toBe('returned_to_branch_reattempt');
    expectCanonicalSlotDate(lastCall[2]);
    expect(!!lastCall[3]?.dryRun).toBe(false);

    // useShipmentBatchOp invalidates `qk.list('shipments')` on success.
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
    await expectReturnActionReadback({
      action: 'Bulk re-attempt (1)',
      rpc: 'ui_execute_shipment_batch_operation_v1',
      source: 'returned_to_branch_reattempt',
    });
  });

  it('failure mode · record_scan_event_v1 rejection does not crash the module (intake scan)', async () => {
    SCAN_SPY.mockRejectedValueOnce(new Error('network outage'));
    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity });
    const user = userEvent.setup();
    await waitForRowsLoaded();

    const intakeBtn = screen.getByRole('button', { name: /Intake scan/i });
    await user.click(intakeBtn);

    await waitFor(() => {
      expect(document.querySelector('.modal input[type="text"]')).not.toBeNull();
    });
    const input = document.querySelector('.modal input[type="text"]') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'SHP-FAIL-7142');

    const submitBtn = findModalButton(/^Record scan$/);
    await user.click(submitBtn);

    await waitFor(() => {
      expect(SCAN_SPY).toHaveBeenCalled();
    });
    // Module remains in DOM even after rejection. Anchor on the queue pill text
    // because the title accent appears in multiple page chrome nodes.
    expect(screen.getByText(/Returned shipments queue/)).toBeInTheDocument();
    SCAN_SPY.mockReset();
  });

  it('Reschedule delivery modal - happy path - sends canonical slot_date through shipment_amend_cancel_v1', async () => {
    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity });
    const user = userEvent.setup();
    await waitForRowsLoaded();

    const rowActionsBtns = Array.from(
      document.querySelectorAll('.dt__table tbody button[aria-label="Row actions"]'),
    );
    expect(rowActionsBtns.length).toBeGreaterThan(0);
    await user.click(rowActionsBtns[0] as HTMLElement);

    await pickFromPalette(user, /Reschedule delivery/i);

    const select = await waitFor(() => {
      const found = document.querySelector('.modal select') as HTMLSelectElement | null;
      expect(found).toBeTruthy();
      expect(found?.value).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
      return found as HTMLSelectElement;
    });
    const selectedSlotDate = select.value;

    const applyBtn = findModalButton(/^Apply reschedule$/);
    await user.click(applyBtn);

    await waitFor(() => {
      expect(AMEND_SPY).toHaveBeenCalled();
    });
    const [shipmentId, op, payload] = AMEND_SPY.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(typeof shipmentId).toBe('string');
    expect(shipmentId.length).toBeGreaterThan(0);
    expect(shipmentId).not.toMatch(/^SHP-/);
    expect(op).toBe('reschedule');
    expect(payload.source).toBe('returned_to_branch');
    expectCanonicalSlotDate(payload, selectedSlotDate);
    await expectReturnActionReadback({
      action: 'Reschedule delivery',
      rpc: 'shipment_amend_cancel_v1',
      source: 'returned_to_branch',
      settingsResolutionId: 'srlv_return_fixture',
    });
  });

  it('Reschedule delivery modal - fail closed - surfaces backend policy rejection without readback success', async () => {
    AMEND_SPY.mockRejectedValueOnce(new Error('branch_unmapped'));

    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity });
    const user = userEvent.setup();
    await waitForRowsLoaded();

    const rowActionsBtns = Array.from(
      document.querySelectorAll('.dt__table tbody button[aria-label="Row actions"]'),
    );
    expect(rowActionsBtns.length).toBeGreaterThan(0);
    await user.click(rowActionsBtns[0] as HTMLElement);

    await pickFromPalette(user, /Reschedule delivery/i);

    const applyBtn = await waitFor(() => findModalButton(/^Apply reschedule$/));
    await user.click(applyBtn);

    await waitFor(() => {
      expect(AMEND_SPY).toHaveBeenCalled();
    });
    expect(document.querySelector('.modal')).toHaveTextContent('Recovery action blocked');
    expect(document.querySelector('.modal')).toHaveTextContent(
      'Delivery slot policy could not map this returned shipment to an active branch',
    );
    expect(screen.queryByLabelText('Return action status')).not.toBeInTheDocument();
  });
});
