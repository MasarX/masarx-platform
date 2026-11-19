// shipments-reschedule.test.tsx — covers the rebuilt Reschedule modal.
//
// Asserted behavior (CLAIM-LIFECYCLE-LINK Gap 2):
//   1. Click a row → drawer opens → click "Reschedule…" → modal appears.
//   2. Modal shows the date input + the resolved-policy chip.
//   3. Window list does NOT render until a date is picked.
//   4. After a date is picked, list_delivery_slots_v1({shipment_id, slot_date})
//      returns chips for available windows.
//   5. "Apply reschedule" is disabled until a date is selected; window
//      chips are backend policy readback only because the canonical shipment
//      workflow stays slot-date-first.
//   6. Clicking "Apply reschedule" fires shipment_amend_cancel_v1(op=reschedule)
//      with the selected slot_date, refreshes the visible shipment context, and
//      shows a backend result instead of toast-only completion.
//
// The mutation seam is observed by spying on `data-source.ts` directly so we
// don't need MSW for this purely client-side flow.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ShipmentsModule } from '@/modules/operate/shipments';
import * as ds from '@/lib/data-source';

const AMEND_SPY = vi.spyOn(ds, 'shipment_amend_cancel_v1');
const SLOT_SPY = vi.spyOn(ds, 'list_delivery_slots_v1');
const OPTIONS_SPY = vi.spyOn(ds, 'shipment_amend_cancel_options_v1');

beforeEach(() => {
  AMEND_SPY.mockClear();
  OPTIONS_SPY.mockResolvedValue({
    shipment_id: 'shp_9381200',
    tracking_number: 'MX-1001',
    status: 'pending',
    lock_source: 'shipment_operation_policy',
    policy: {},
    operations: {
      modify: { operation: 'modify', allowed: true, status: 'pending' },
      reschedule: { operation: 'reschedule', allowed: true, status: 'pending' },
      address: { operation: 'address', allowed: true, status: 'pending' },
      cancel: { operation: 'cancel', allowed: true, status: 'pending' },
    },
  });
  SLOT_SPY.mockResolvedValue([
    { window_id: 'win_2026_04_26_am', slot_date: '2026-04-26', window_start_local: '10:00', window_end_local: '12:00', remaining: 12 },
    { window_id: 'win_2026_04_26_mid', slot_date: '2026-04-26', window_start_local: '13:00', window_end_local: '15:00', remaining: 8 },
    { window_id: 'win_2026_04_27_am', slot_date: '2026-04-27', window_start_local: '10:00', window_end_local: '12:00', remaining: 14 },
    { window_id: 'win_2026_04_27_mid', slot_date: '2026-04-27', window_start_local: '13:00', window_end_local: '15:00', remaining: 9 },
  ]);
});

async function openRescheduleModal(user: ReturnType<typeof userEvent.setup>) {
  // Wait for shipments table.
  await waitFor(() => {
    expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
  });
  // Open the drawer for the first row.
  await user.click(document.querySelector('.dt__table tbody tr') as Element);
  await waitFor(() => {
    expect(document.querySelector('.drawer')).not.toBeNull();
  });
  // Click "Reschedule…" in the drawer footer.
  const footer = document.querySelector('.drawer__footer')!;
  const rescheduleBtn = Array.from(footer.querySelectorAll('button')).find((b) =>
    /Reschedule/.test(b.textContent ?? ''),
  );
  expect(rescheduleBtn).toBeTruthy();
  await user.click(rescheduleBtn as HTMLElement);
  // Modal should appear.
  await waitFor(() => {
    expect(document.querySelector('.modal')).not.toBeNull();
  });
}

describe('ShipmentsModule · Reschedule modal · live slot picker', () => {
  it('renders a date input and policy chip with the window list initially empty', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openRescheduleModal(user);

    // Policy chip.
    expect(screen.getAllByText(/Delivery slot policy/).length).toBeGreaterThan(0);
    expect(document.body.textContent ?? '').not.toMatch(/delivery_slot_policy/);
    // Date input.
    expect(screen.getByTestId('reschedule-date')).toBeInTheDocument();
    // No window list before a date is picked.
    expect(document.querySelector('[data-testid="reschedule-window-list"]')).toBeNull();
  });

  it('disables Apply reschedule until a date is selected and shows windows as review-only readback', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openRescheduleModal(user);

    // Find Apply reschedule button — disabled at the start.
    const findApply = (): HTMLButtonElement | undefined =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button')).find((b) =>
        /^Apply reschedule$/.test((b.textContent ?? '').trim()),
      );
    expect(findApply()).toBeDisabled();

    // Set a date — windows fetch async. Browser date controls may emit input
    // before change, so cover the real clicked-entry event path too.
    const dateInput = screen.getByTestId('reschedule-date') as HTMLInputElement;
    fireEvent.input(dateInput, { target: { value: '2026-04-26' } });
    // Wait for at least one backend window chip to render. The wrapper has
    // testid `reschedule-window-list`; each chip has testid prefix
    // `reschedule-window-win_`.
    await waitFor(() => {
      const w = document.querySelectorAll('[data-testid^="reschedule-window-win_"]');
      expect(w.length).toBeGreaterThan(0);
    });
    expect(document.body.textContent ?? '').toContain('12 spots');
    // Date is the canonical input and available windows are required readback.
    expect(findApply()).not.toBeDisabled();

    // Window chips are not selectable controls; the backend confirms the final
    // reserved window through readback after apply.
    const firstWindow = document.querySelector<HTMLElement>(
      '[data-testid^="reschedule-window-win_"]',
    );
    expect(firstWindow).not.toBeNull();
    expect(firstWindow?.getAttribute('role')).not.toBe('radio');
    expect(document.querySelector('[data-testid="reschedule-window-list"] [role="radio"]')).toBeNull();

    // The action remains enabled after a specific window is picked.
    await waitFor(() => {
      expect(findApply()).not.toBeDisabled();
    });
  });

  it('shows null-capacity backend windows as open capacity instead of zero spots', async () => {
    const user = userEvent.setup();
    SLOT_SPY.mockResolvedValueOnce([
      {
        window_id: 'win_2026_05_13_open',
        slot_date: '2026-05-13',
        window_start_local: '09:00',
        window_end_local: '18:00',
        remaining: null,
      },
    ]);
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openRescheduleModal(user);

    fireEvent.input(screen.getByTestId('reschedule-date') as HTMLInputElement, {
      target: { value: '2026-05-13' },
    });

    await waitFor(() => {
      expect(screen.getByText(/open capacity/i)).toBeInTheDocument();
    });
    expect(document.body.textContent ?? '').not.toContain('0 spots');
  });

  it('keeps Apply reschedule disabled when the backend returns no available windows', async () => {
    const user = userEvent.setup();
    SLOT_SPY.mockResolvedValueOnce([]);
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openRescheduleModal(user);

    const findApply = (): HTMLButtonElement | undefined =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button')).find((b) =>
        /^Apply reschedule$/.test((b.textContent ?? '').trim()),
      );

    fireEvent.input(screen.getByTestId('reschedule-date') as HTMLInputElement, {
      target: { value: '2026-05-12' },
    });

    await waitFor(() => {
      expect(screen.getByText(/No windows available for that date/i)).toBeInTheDocument();
    });
    expect(findApply()).toBeDisabled();
    expect(AMEND_SPY).not.toHaveBeenCalled();
  });

  it('fires shipment_amend_cancel_v1(op=reschedule) with slot_date and refreshes shipment views in place', async () => {
    const user = userEvent.setup();
    AMEND_SPY.mockResolvedValue({
      ok: true,
      workflow_template: 'shipment_reschedule_v1',
      workflow_run_id: 'wf_reschedule_apply',
      started_via: 'start_workflow_run',
      canonical_entrypoint: 'progress_workflow_run',
      dry_run: false,
      diff: null,
      settings_resolution_id: 'srlv_reschedule_apply',
    });
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1');
    const getSpy = vi.spyOn(ds, 'ui_get_resource_v1');
    window.history.pushState(null, '', '/operate/shipments');
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await openRescheduleModal(user);

    // Resolve the shipment id from the drawer deep-link (the modal title
    // also includes tracking, but the deep-link is the canonical id source).
    const drawerDeepLink =
      document.querySelector('.drawer [data-deeplink], .drawer a[href^="#/operate/shipments?focus="]')
        ?.getAttribute('href') ?? null;
    // Pick the first row's id from the data table directly (more reliable):
    const firstRowAnchor = document.querySelector<HTMLAnchorElement>(
      '.dt__table tbody tr a[href^="#/operate/shipments?focus="]',
    );
    const shipmentIdFromAnchor = firstRowAnchor?.getAttribute('href')?.split('focus=')[1] ?? null;

    // Set date through the input event path used by browser date controls.
    fireEvent.input(screen.getByTestId('reschedule-date') as HTMLInputElement, {
      target: { value: '2026-04-27' },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="reschedule-window-list"]')).not.toBeNull();
    });

    // Windows are displayed as readback only, not as backend-ignored selection.
    const windowChip = document.querySelector<HTMLElement>(
      '[data-testid="reschedule-window-win_2026_04_27_mid"]',
    );
    expect(windowChip).not.toBeNull();
    expect(windowChip?.getAttribute('role')).not.toBe('radio');
    const listCallsBeforeApply = listSpy.mock.calls.length;
    const getCallsBeforeApply = getSpy.mock.calls.length;

    // Click Apply reschedule.
    const applyBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button')).find((b) =>
      /^Apply reschedule$/.test((b.textContent ?? '').trim()),
    )!;
    await user.click(applyBtn);

    // The Console action must start the canonical shipment reschedule workflow.
    await waitFor(() => {
      expect(AMEND_SPY).toHaveBeenCalledTimes(1);
    });
    const [shipmentId, op, payload, opts] = AMEND_SPY.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      { dryRun?: boolean } | undefined,
    ];
    expect(op).toBe('reschedule');
    expect(payload).toMatchObject({
      slot_date: '2026-04-27',
      source: 'console_v2.shipments.reschedule_modal',
    });
    expect(payload).not.toHaveProperty('selected_window_id');
    expect(opts?.dryRun).toBe(false);
    expect(typeof shipmentId).toBe('string');
    // Sanity: matches the row anchor / deep-link if either was found.
    if (shipmentIdFromAnchor) {
      expect(shipmentId).toBe(shipmentIdFromAnchor);
    } else if (drawerDeepLink) {
      expect(drawerDeepLink).toContain(shipmentId);
    }
    const result = await screen.findByTestId('shipment-reschedule-apply-result');
    expect(result).toHaveTextContent(/Reschedule workflow started/i);
    expect(result).toHaveTextContent(/Workflow confirmed/i);
    expect(result).toHaveTextContent(/Workflow status/i);
    expect(result).toHaveTextContent(/Workflow path/i);
    expect(within(result).getByText(/Date 2026-04-27/i)).toBeInTheDocument();
    expect(result.querySelector('pre')).toBeNull();
    await waitFor(() => {
      expect(listSpy.mock.calls.slice(listCallsBeforeApply).some(([resource]) => resource === 'shipments')).toBe(true);
      expect(listSpy.mock.calls.slice(listCallsBeforeApply).some(([resource]) => resource === 'shipment_directory')).toBe(true);
      expect(getSpy.mock.calls.slice(getCallsBeforeApply).some(([resource]) => resource === 'shipments')).toBe(true);
    });
    expect(window.location.pathname).toBe('/operate/shipments');
  });
});
