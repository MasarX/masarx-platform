// shipments.test.tsx — covers the operator Shipments registry surface added/
// hardened in claim-A. Targets:
//   1. Module mounts and the registry-driven DataTable renders rows.
//   2. Header `Create shipment` button is capability-gated by `shipments.write`
//      and shows the canonical lock chip when missing.
//   3. Header `Bulk amend / cancel` is capability-gated by `shipments.write`
//      because it opens a write-intent workflow.
//   4. Drawer opens on row click with the canonical 12-tab related rail.
//   5. Drawer footer includes the canonical actions wired to real RPCs:
//      Resort / Refresh routing / Reschedule / Reprint label / Preview cancel / Amend.
//   6. The decision-trail row action uses the universal drawer spec rather
//      than navigating away (regression guard for F-S13 in user-flows.md).
//
// We mount the live `ShipmentsModule` via `renderWithProviders` so the seam
// (queries.ts → api.ts → data-source.ts) executes end-to-end.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { clearToasts, getToasts } from '@/components/toastStore';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';
import {
  ShipmentsModule,
  canEditShipmentTaskStatus,
  compactReferenceToken,
  resolveShipmentFocus,
  resolveShipmentListColumns,
} from '@/modules/operate/shipments';

async function findShipmentDataRow(): Promise<HTMLTableRowElement> {
  let row: HTMLTableRowElement | null = null;
  await waitFor(() => {
    row = document.querySelector<HTMLTableRowElement>('tr[aria-label^="Open shipment"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('aria-label')).toMatch(/^Open shipment .+/);
    expect(row?.textContent ?? '').not.toMatch(/No shipments|No shipment data|No records/i);
  });
  return row!;
}

describe('ShipmentsModule', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearToasts();
    localStorage.removeItem('demo-v2.view.shipments');
    window.history.pushState(null, '', '/operate/shipments');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearToasts();
  });

  it('mounts the page header and the canonical registry table', async () => {
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Shipment data')).toBeInTheDocument();
    expect(await findShipmentDataRow()).toBeInTheDocument();
  });

  it('keeps the list view operator-focused instead of dumping raw shipment table columns', () => {
    const columns = resolveShipmentListColumns([
      { key: 'id', label: 'Id' },
      { key: 'organization_id', label: 'Organization Id' },
      { key: 'client_id', label: 'Client Id' },
      { key: 'tracking_number', label: 'Tracking Number' },
      { key: 'status', label: 'Raw Status' },
    ]);

    expect(columns.map((column) => column.key)).toEqual([
      'tracking_number',
      'client_label',
      'recipient_label',
      'destination_city',
      'service_type',
      'status',
      'promised_delivery_date',
      'cod_amount',
      'box_actual_count',
      'active_task_count',
      'last_scan_at',
    ]);
    expect(columns.some((column) => ['id', 'organization_id', 'client_id'].includes(column.key))).toBe(false);
  });

  it('resolves shipment focus from canonical URL search while preserving legacy hash support', () => {
    expect(resolveShipmentFocus('?focus=shp_9381200', '')).toBe('shp_9381200');
    expect(resolveShipmentFocus('', '#/operate/shipments?focus=shp_9381200')).toBe('shp_9381200');
  });

  it('opens a focused shipment through the identifier backend filter when it is not in the loaded page', async () => {
    window.history.pushState(null, '', '/operate/shipments?focus=SHP-OFFPAGE-001');
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string, opts?: api.ListOpts) => {
      if (key === 'shipments' && opts?.filter && (opts.filter as Record<string, unknown>).identifier) {
        return {
          rows: [{
            id: 'shp_off_page_001',
            tracking_number: 'SHP-OFFPAGE-001',
            status: 'created',
            service_type: 'standard',
            cod_amount: 0,
            promised_delivery_date: '2026-05-05T08:00:00Z',
          }],
          total: 1,
          page: 0,
          page_size: 1,
        };
      }
      return { rows: [], total: 0, page: 0, page_size: 100 };
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(screen.getAllByText('SHP-OFFPAGE-001').length).toBeGreaterThan(0);
    expect(
      listSpy.mock.calls.some(
        ([key, opts]) =>
          key === 'shipments' &&
          (opts?.filter as Record<string, unknown> | undefined)?.identifier === 'SHP-OFFPAGE-001',
      ),
    ).toBe(true);
  });

  it('shows a read-error state when the backend shipment list fails', async () => {
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string, opts?: api.ListOpts) => {
      if (key === 'shipments' && !(opts?.filter as Record<string, unknown> | undefined)?.identifier) {
        throw new Error('shipments registry unavailable');
      }
      return realList(key, opts);
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['shipments.read'] });

    expect(await screen.findByText(/Shipments unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/shipments registry unavailable/i)).toBeInTheDocument();
  });

  it('denies shipments.read without issuing protected shipment reads', async () => {
    window.history.pushState(null, '', '/operate/shipments?focus=SHP-DENIED-001');
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');

    renderWithProviders(<ShipmentsModule />, { capabilities: ['shipments.write'] });

    expect(await screen.findByText('You do not have permission to view shipments.')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        listSpy.mock.calls.filter(
          ([resource]) => resource === 'shipments' || resource === 'shipment_directory' || resource === 'labels',
        ),
      ).toEqual([]);
    });
  });

  it('opens a focused shipment when the shipment is already on the loaded page', async () => {
    window.history.pushState(null, '', '/operate/shipments?focus=shp_9381200');

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(screen.getAllByText('SHP-9381200').length).toBeGreaterThan(0);
  });

  it('formats related drawer references without leaking raw backend prefixes', () => {
    expect(compactReferenceToken('bsk_delivery_abc123', 'Basket')).toBe('Basket #ABC123');
    expect(compactReferenceToken('usr_admin_rashed', 'Actor')).toBe('Actor #RASHED');
    expect(compactReferenceToken('cor_9817', 'Trace')).toBe('Trace #9817');
  });

  it('disables write-intent header actions and shows the lock chip when shipments.write is missing', async () => {
    renderWithProviders(<ShipmentsModule />, { capabilities: ['shipments.read'] });
    expect(screen.getByRole('button', { name: /Create shipment/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Bulk amend \/ cancel/ })).toBeDisabled();
    // Lock chip names the missing permission without exposing the raw capability key.
    expect(screen.getAllByText('Shipment Update permission required').length).toBeGreaterThan(0);
    expect(screen.queryByText('shipments.write')).toBeNull();
  });

  it('removes shipment edit affordances for read-only operators', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['shipments.read'] });
    const row = await findShipmentDataRow();
    expect(document.querySelectorAll('td.is-editable').length).toBe(0);
    await user.click(row);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(document.querySelectorAll('.kvgrid__val--editable').length).toBe(0);
  });

  it('keeps related task status read-only without task write permissions', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['shipments.read'] });
    await user.click(await findShipmentDataRow());
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    await user.click(screen.getByRole('tab', { name: /Tasks/ }));
    await waitFor(() => {
      expect(document.querySelector('[role="tabpanel"]')).not.toBeNull();
    });
    expect(document.querySelectorAll('td.is-editable').length).toBe(0);
    expect(canEditShipmentTaskStatus(false, false)).toBe(false);
    expect(canEditShipmentTaskStatus(true, false)).toBe(false);
    expect(canEditShipmentTaskStatus(false, true)).toBe(true);
  });

  it('opens the canonical 14-tab shipment workbench when a row is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await user.click(await findShipmentDataRow());
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    // Each tab in the rail surfaces `.rail-tab`. Shipment-related basket and
    // evidence context belong in the shipment workbench, so the canonical count is 14.
    await waitFor(() => {
      expect(document.querySelectorAll('.rail-tab').length).toBe(14);
    });
  });

  it('exposes the canonical drawer-footer action set', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await user.click(await findShipmentDataRow());
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });
    // Actions: Resort, Refresh routing, Reschedule, Reprint label, Preview cancel, Amend.
    const footer = document.querySelector('.drawer__footer')!;
    const buttons = footer.querySelectorAll('button');
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    // Spot-check labels — these names are operator-facing.
    expect(footer.textContent).toMatch(/Resort/);
    expect(footer.textContent).toMatch(/Refresh routing/);
    expect(footer.textContent).toMatch(/Reschedule/);
    expect(footer.textContent).toMatch(/Reprint/);
    expect(footer.textContent).toMatch(/Preview cancel/);
    expect(footer.textContent).toMatch(/Amend/);
  });

  it('refreshes routing through the backend geocode action and disables while pending', async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((value: api.ShipmentUpdateGeocodeResult) => void) | undefined;
    const refreshSpy = vi.spyOn(api, 'ui_execute_shipment_update_geocode_v1').mockImplementation(
      () =>
        new Promise<api.ShipmentUpdateGeocodeResult>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await user.click(await findShipmentDataRow());
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });

    const refreshButton = screen.getByRole('button', { name: /Refresh routing/i });
    await user.click(refreshButton);

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(refreshButton).toBeDisabled();
    });
    const payload = refreshSpy.mock.calls[0]?.[0];
    expect(payload?.shipment_id).toBeTruthy();
    expect(payload?.destination_address_id ?? payload?.address_id).toBeTruthy();

    await act(async () => {
      resolveRefresh?.({
        ok: true,
        status: 'workflow_started',
        action_key: 'shipments.update_geocode',
        resource_key: 'shipments',
        count: 1,
        workflow_run_id: 'wfr_refresh_routing',
      });
    });

    await waitFor(() => {
      expect(getToasts().some((toast) => toast.message.includes('Routing refresh queued'))).toBe(true);
    });
    expect(screen.getByText(/^Routing refresh queued$/i)).toBeInTheDocument();
    expect(screen.queryByText(/wfr_refresh_routing/i)).not.toBeInTheDocument();
  });

  it('shows backend routing refresh failures in the same drawer context', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'ui_execute_shipment_update_geocode_v1').mockRejectedValue(
      new Error('nested geocode workflow failed'),
    );

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await user.click(await findShipmentDataRow());
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: /Refresh routing/i }));

    await waitFor(() => {
      expect(getToasts().some((toast) => toast.message.includes('Routing refresh failed'))).toBe(true);
    });
    expect(screen.getByText(/Routing refresh failed\. Try again\./i)).toBeInTheDocument();
  });

  it('shows the cancel preview result in the shipment workflow instead of toast-only success', async () => {
    const user = userEvent.setup();
    vi.spyOn(ds, 'shipment_amend_cancel_options_v1').mockResolvedValue({
      shipment_id: 'shp_9381200',
      operations: {
        cancel: { operation: 'cancel', allowed: true },
      },
    });
    const previewSpy = vi.spyOn(ds, 'shipment_amend_cancel_v1').mockResolvedValue({
      ok: true,
      workflow_template: 'tpl_amend_cancel',
      workflow_run_id: '',
      started_via: 'dry_run_preview',
      canonical_entrypoint: 'not_started',
      dry_run: true,
      diff: { operation: 'cancel', allowed: true, policy: 'shipment_operation_policy' },
      settings_resolution_id: 'srlv_cancel_preview',
    });
    vi.spyOn(api, 'shipment_amend_cancel_options_v1').mockResolvedValue({
      operations: { cancel: { allowed: true } },
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await user.click(await findShipmentDataRow());
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Preview cancel/i })).toBeEnabled();
    });

    await user.click(screen.getByRole('button', { name: /Preview cancel/i }));

    const result = await screen.findByTestId('shipment-cancel-preview-result');
    expect(result).toHaveTextContent(/Policy check completed/i);
    expect(result).toHaveTextContent(/Policy confirmed/i);
    expect(result).toHaveTextContent(/Preview/i);
    expect(result).not.toHaveTextContent(/shipment_operation_policy/i);
    expect(previewSpy).toHaveBeenCalledWith(expect.any(String), 'cancel', {}, { dryRun: true });
    expect(getToasts().some((toast) => toast.message.includes('Cancel preview ready'))).toBe(true);
  });

  it('applies cancel from the preview modal and refreshes shipment views in place', async () => {
    const user = userEvent.setup();
    vi.spyOn(ds, 'shipment_amend_cancel_options_v1').mockResolvedValue({
      shipment_id: 'shp_9381200',
      operations: {
        cancel: { operation: 'cancel', allowed: true },
      },
    });
    const mutationSpy = vi.spyOn(ds, 'shipment_amend_cancel_v1').mockImplementation(async (_shipmentId, op, payload, opts) => {
      expect(op).toBe('cancel');
      if (opts?.dryRun) {
        expect(payload).toEqual({});
        return {
          ok: true,
          workflow_template: 'shipment_delete_v1',
          workflow_run_id: '',
          started_via: 'dry_run_preview',
          canonical_entrypoint: 'not_started',
          dry_run: true,
          diff: { operation: 'cancel', allowed: true, policy: 'shipment_operation_policy' },
          settings_resolution_id: 'srlv_cancel_apply_preview',
        };
      }
      expect(payload).toEqual(
        expect.objectContaining({
          reason: 'console_v2.shipments.cancel_preview_modal',
          source: 'console_v2.shipments.cancel_preview_modal',
        }),
      );
      return {
        ok: true,
        workflow_template: 'shipment_delete_v1',
        workflow_run_id: 'wf_cancel_apply',
        started_via: 'start_workflow_run',
        canonical_entrypoint: 'progress_workflow_run',
        dry_run: false,
        diff: null,
        settings_resolution_id: 'srlv_cancel_apply',
      };
    });
    vi.spyOn(api, 'shipment_amend_cancel_options_v1').mockResolvedValue({
      operations: { cancel: { allowed: true } },
    });
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    const getSpy = vi.spyOn(api, 'ui_get_resource_v1');

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await user.click(await findShipmentDataRow());
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Preview cancel/i })).toBeEnabled();
    });

    await user.click(screen.getByRole('button', { name: /Preview cancel/i }));
    await screen.findByTestId('shipment-cancel-preview-result');
    const listCallsBeforeApply = listSpy.mock.calls.length;
    const getCallsBeforeApply = getSpy.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /Apply cancel/i }));

    const result = await screen.findByTestId('shipment-cancel-apply-result');
    expect(result).toHaveTextContent(/Cancel workflow started/i);
    expect(result).toHaveTextContent(/Workflow confirmed/i);
    expect(result).not.toHaveTextContent(/wf_cancel_apply/i);
    expect(mutationSpy).toHaveBeenCalledWith(expect.any(String), 'cancel', {}, { dryRun: true });
    expect(mutationSpy).toHaveBeenCalledWith(
      expect.any(String),
      'cancel',
      expect.objectContaining({
        reason: 'console_v2.shipments.cancel_preview_modal',
        source: 'console_v2.shipments.cancel_preview_modal',
      }),
      { dryRun: false },
    );
    await waitFor(() => {
      expect(listSpy.mock.calls.slice(listCallsBeforeApply).some(([resource]) => resource === 'shipments')).toBe(true);
      expect(listSpy.mock.calls.slice(listCallsBeforeApply).some(([resource]) => resource === 'shipment_directory')).toBe(true);
      expect(getSpy.mock.calls.slice(getCallsBeforeApply).some(([resource]) => resource === 'shipments')).toBe(true);
    });
    expect(window.location.pathname).toBe('/operate/shipments');
    expect(getToasts().some((toast) => toast.message.includes('Cancel workflow started'))).toBe(true);
  });

  it('does not show a successful resort when the backend rejects the request', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'ui_execute_shipment_resort_v1').mockRejectedValue(new Error('shipment is locked by dispatch policy'));

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await user.click(await findShipmentDataRow());
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: /Resort/ }));

    await waitFor(() => {
      expect(getToasts().some((toast) => toast.message.includes('Resort failed'))).toBe(true);
    });
    expect(getToasts().some((toast) => toast.message.includes('Resort ok'))).toBe(false);
  });

  it('waits for shipment resort readback before showing success', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    const originalGet = api.ui_get_resource_v1;
    let gateReadback = false;
    let readbackStarted = false;
    let releaseReadback: (() => void) | undefined;
    const readbackGate = new Promise<void>((resolve) => {
      releaseReadback = resolve;
    });
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (...args) => {
      const resource = String(args[0] ?? '');
      if (
        gateReadback &&
        ['shipments', 'shipment_directory', 'shipment_actions', 'decision_log', 'audit_table_changes'].includes(resource)
      ) {
        readbackStarted = true;
        await readbackGate;
      }
      return originalList(...args);
    });
    const getSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (...args) => {
      if (gateReadback && args[0] === 'shipments') {
        readbackStarted = true;
        await readbackGate;
      }
      return originalGet(...args);
    });
    const resortSpy = vi.spyOn(api, 'ui_execute_shipment_resort_v1').mockResolvedValue({
      ok: true,
      shipment_id: 'shp_resort_readback',
      action_key: 'shipments.resort',
      basket_policy_applied: true,
    });

    renderWithProviders(<ShipmentsModule />, { capabilities: ['all'] });
    await user.click(await findShipmentDataRow());
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });

    gateReadback = true;
    await user.click(screen.getByRole('button', { name: /^Resort$/i }));

    await waitFor(() => {
      expect(resortSpy).toHaveBeenCalledTimes(1);
      expect(readbackStarted).toBe(true);
    });
    expect(getToasts().some((toast) => toast.message.includes('Resort ok'))).toBe(false);

    await act(async () => {
      releaseReadback?.();
    });

    await waitFor(() => {
      expect(getToasts().some((toast) => toast.message.includes('Resort ok'))).toBe(true);
    });
    expect(listSpy.mock.calls.some(([resource]) => resource === 'shipments')).toBe(true);
    expect(listSpy.mock.calls.some(([resource]) => resource === 'shipment_directory')).toBe(true);
    expect(getSpy.mock.calls.some(([resource]) => resource === 'shipments')).toBe(true);
  });
});
