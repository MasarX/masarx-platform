// warehouse.test.tsx — verifies the kanban renders, variance flag chips appear
// in header, and supervisor approval toast surfaces task id.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { WarehouseModule } from '@/modules/platform/warehouse';
import * as apiMod from '@/lib/api';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.pointerEvents = '';
  window.history.pushState(null, '', '/platform/warehouse');
});

describe('WarehouseModule', () => {
  it('renders all kanban stages', async () => {
    renderWithProviders(<WarehouseModule />);
    expect(await screen.findByText(/planned/)).toBeInTheDocument();
    expect(screen.getByText(/in transit/)).toBeInTheDocument();
    expect(screen.getByText(/received/)).toBeInTheDocument();
    expect(screen.getByText(/reconciled/)).toBeInTheDocument();
    expect(screen.getByText(/on hold/)).toBeInTheDocument();
  });

  it('variance pending chip appears in header when at least one transfer has variance_flag', async () => {
    renderWithProviders(<WarehouseModule />);
    // Seed has 1 transfer with variance_flag=true (wtr_2026_0481)
    expect(await screen.findByText(/at risk/i)).toBeInTheDocument();
  });

  it('renders an operator-facing workflow label in the header pill', async () => {
    renderWithProviders(<WarehouseModule />);
    expect(await screen.findByText(/Transfer workflow - scan sequence enforced/)).toBeInTheDocument();
    expect(screen.queryByText(/warehouse_transfer_execute_v1/)).toBeNull();
  });

  it('shows denied state without issuing protected warehouse reads when warehouse.read is missing', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');

    renderWithProviders(<WarehouseModule />, { capabilities: ['billing.read'] });

    expect(
      await screen.findByText(/You do not have permission to view warehouse transfers/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Warehouse Read permission required/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).not.toHaveBeenCalledWith('warehouse_transfer_summary', expect.anything());
      expect(listSpy).not.toHaveBeenCalledWith('warehouse_transfer_items', expect.anything());
      expect(listSpy).not.toHaveBeenCalledWith('warehouse_checkpoint_scans', expect.anything());
      expect(listSpy).not.toHaveBeenCalledWith('warehouse_exception_hold', expect.anything());
      expect(listSpy).not.toHaveBeenCalledWith('tasks', expect.anything());
    });
    expect(screen.queryByRole('button', { name: /^Create manifest/i })).toBeNull();
  });

  it('keeps write, scan, reconcile, and task actions denied for read-only warehouse operators', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const createSpy = vi.spyOn(dsAdapter, 'create_warehouse_transfer_manifest_v1');
    const dispatchSpy = vi.spyOn(dsAdapter, 'ui_execute_warehouse_transfer_dispatch_v1');
    const checkpointSpy = vi.spyOn(dsAdapter, 'ui_execute_warehouse_transfer_checkpoint_v1');
    const reconcileSpy = vi.spyOn(dsAdapter, 'ui_execute_warehouse_transfer_reconcile_v1');
    const transitionSpy = vi.spyOn(dsAdapter, 'transition_task_v1');

    renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.read'] });

    const createManifest = await screen.findByRole('button', { name: /Create manifest/i });
    await waitFor(() => {
      expect(listSpy).not.toHaveBeenCalledWith('warehouse_exception_hold', expect.anything());
    });
    expect(createManifest).toBeDisabled();
    expect(createManifest).toHaveTextContent(/Warehouse Write permission required/i);
    await user.click(createManifest).catch(() => undefined);

    await user.click((await screen.findAllByText(/WTR-2026-0479/i))[0]!);
    const drawerText = await waitFor(() => document.querySelector('.drawer')?.textContent ?? '');
    expect(drawerText).toContain('WTR-2026-0479');

    const dispatchButton = await screen.findByRole('button', { name: /Dispatch transfer/i });
    const scanDepartureButton = await screen.findByRole('button', { name: /Scan departure/i });
    const scanArrivalButton = await screen.findByRole('button', { name: /Scan arrival/i });
    const reconcileButton = await screen.findByRole('button', { name: /Reconcile transfer/i });
    expect(dispatchButton).toBeDisabled();
    expect(scanDepartureButton).toBeDisabled();
    expect(scanArrivalButton).toBeDisabled();
    expect(reconcileButton).toBeDisabled();
    expect(dispatchButton).toHaveTextContent(/Warehouse Write permission required/i);
    expect(scanDepartureButton).toHaveTextContent(/Warehouse Write permission required/i);
    expect(scanArrivalButton).toHaveTextContent(/Warehouse Write permission required/i);
    expect(reconcileButton).toHaveTextContent(/Warehouse Write permission required/i);

    const completeTaskButtons = screen.getAllByRole('button', { name: /Complete task/i });
    expect(completeTaskButtons.length).toBeGreaterThan(0);
    expect(completeTaskButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);

    for (const button of [dispatchButton, scanDepartureButton, scanArrivalButton, reconcileButton, ...completeTaskButtons]) {
      await user.click(button).catch(() => undefined);
    }
    expect(createSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(checkpointSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('opens the transfer drawer from a supervisor task query parameter', async () => {
    window.history.pushState(null, '', '/platform/warehouse?task=tsk_4001');
    renderWithProviders(<WarehouseModule />);
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/WTR-2026-0481|tsk_4001/);
    });
  });

  it('approves warehouse variance from the drawer and refreshes terminal workflow readback in place', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    // @ts-expect-error seed raw fixtures are intentionally plain JS modules.
    const warehouseSeed = await import('@/lib/seed-raw/warehouse') as {
      warehouse_transfers: Array<Record<string, unknown>>;
    };
    // @ts-expect-error seed raw fixtures are intentionally plain JS modules.
    const taskSeed = await import('@/lib/seed-raw/domain-tasks') as {
      tasks: Array<Record<string, unknown>>;
    };
    const transfer = warehouseSeed.warehouse_transfers.find((row: Record<string, unknown>) => row.id === 'wtr_2026_0481');
    const task = taskSeed.tasks.find((row: Record<string, unknown>) => row.id === 'tsk_4001');
    expect(transfer).toBeTruthy();
    expect(task).toBeTruthy();
    const originalTransfer = { ...transfer! };
    const originalTask = { ...task! };
    const transitionSpy = vi.spyOn(dsAdapter, 'transition_task_v1');
    const progressSpy = vi
      .spyOn(apiMod, 'progress_workflow_run_until_wait_v1')
      .mockImplementationOnce(async () => {
        Object.assign(transfer!, {
          status: 'reconciled',
          updated_at: '2026-04-25T12:05:00Z',
        });
        Object.assign(task!, { status: 'completed' });
        return {
          workflow_run_id: 'wfr_wh_0481',
          status: 'completed',
          steps: [],
        } as never;
      });

    try {
      Object.assign(task!, {
        resource_type: 'warehouse_transfer',
        resource_id: 'wtr_2026_0481',
        workflow_run_id: 'wfr_wh_0481',
        metadata: {
          ...((task!.metadata as Record<string, unknown> | undefined) ?? {}),
          parent_workflow_run_id: 'wfr_wh_0481',
          task_type_key: 'warehouse_supervisor_approval',
        },
      });
      Object.assign(transfer!, {
        variance_count: 0,
        variance_flag: false,
        hold_reason: null,
      });
      renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'tasks.complete', 'all'] });
      const transferMatches = await screen.findAllByText(/WTR-2026-0481/i);
      await user.click(transferMatches[0]!);
      const approveButton = await screen.findByRole('button', { name: /Approve variance/i });
      expect(approveButton).toBeEnabled();
      await user.click(approveButton);

      await waitFor(() => expect(transitionSpy).toHaveBeenCalled());
      expect(transitionSpy.mock.calls[0]?.[0]).toBe('tsk_4001');
      expect(transitionSpy.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          next_status: 'completed',
          action_kind: 'approve',
          payload: expect.objectContaining({
            warehouse_transfer_id: 'wtr_2026_0481',
            source: 'console_v2.warehouse.variance_approval',
            task_type_key: 'warehouse_supervisor_approval',
          }),
        }),
      );
      await waitFor(() => expect(progressSpy).toHaveBeenCalled());
      expect(progressSpy).toHaveBeenCalledWith(
        'wfr_wh_0481',
        expect.objectContaining({
          warehouse_transfer_id: 'wtr_2026_0481',
          completed_task_id: 'tsk_4001',
          task_action_kind: 'approve',
        }),
        { budget_ms: 12000, max_steps: 16 },
      );
      const drawerText = await waitFor(() => {
        const text = document.querySelector('.drawer')?.textContent ?? '';
        expect(text).toContain('Reconciled');
        expect(text).toContain('No open warehouse workflow task is currently blocking this transfer.');
        expect(text).not.toContain('Exception holds');
        return text;
      });
      expect(drawerText).toContain('WTR-2026-0481');
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Approve variance/i })).toBeNull();
      });
      const readback = await screen.findByTestId('warehouse-action-readback');
      expect(within(readback).getByText('approve_variance')).toBeInTheDocument();
      expect(within(readback).getByText('reconciled')).toBeInTheDocument();
      expect(within(readback).getByText('wfr_wh_0481')).toBeInTheDocument();
    } finally {
      Object.assign(transfer!, originalTransfer);
      Object.assign(task!, originalTask);
    }
  });

  it('row-bound dispatch action calls ui_execute_warehouse_transfer_dispatch_v1', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    const spy = vi.spyOn(dsAdapter, 'ui_execute_warehouse_transfer_dispatch_v1');
    renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'all'] });
    const transferMatches = await screen.findAllByText(/WTR-2026-0477/i);
    await user.click(transferMatches[0]!);
    await user.click(await screen.findByRole('button', { name: /Dispatch transfer/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ warehouse_transfer_id: expect.stringMatching(/^wtr_/) }),
    );
    const readback = await screen.findByTestId('warehouse-action-readback');
    expect(within(readback).getByText('dispatch')).toBeInTheDocument();
    expect(within(readback).getByText('Workflow status')).toBeInTheDocument();
    expect(within(readback).getAllByText(/workflow_started|workflow_existing/).length).toBeGreaterThan(0);
  });

  it('checkpoint scan modal calls ui_execute_warehouse_transfer_checkpoint_v1 with the command key', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    const spy = vi.spyOn(dsAdapter, 'ui_execute_warehouse_transfer_checkpoint_v1');
    renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'all'] });
    const transferMatches = await screen.findAllByText(/WTR-2026-0476/i);
    await user.click(transferMatches[0]!);
    expect(await screen.findByTestId('warehouse-active-task-warehouse_transfer_dispatch')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Scan departure/i }));
    await user.type(await screen.findByTestId('warehouse-checkpoint-barcode'), 'BAG-001');
    const submitButtons = screen.getAllByRole('button', { name: /Scan departure/i });
    await user.click(submitButtons[submitButtons.length - 1]!);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        action_key: 'warehouse_transfers.scan_departure',
        barcode: 'BAG-001',
      }),
    );
  });

  it('requests and records append-only scan corrections with same-drawer readback', async () => {
    const user = userEvent.setup();
    // @ts-expect-error seed raw fixtures are intentionally plain JS modules.
    const warehouseSeed = await import('@/lib/seed-raw/warehouse') as {
      warehouse_checkpoint_scans: Array<Record<string, unknown>>;
    };
    // @ts-expect-error seed raw fixtures are intentionally plain JS modules.
    const taskSeed = await import('@/lib/seed-raw/domain-tasks') as {
      tasks: Array<Record<string, unknown>>;
    };
    const requestSpy = vi.spyOn(apiMod, 'ui_request_warehouse_scan_correction_v1');
    const transitionSpy = vi.spyOn(apiMod, 'transition_task_v1');
    const recordSpy = vi.spyOn(apiMod, 'record_scan_event_v1');
    const originalTaskLength = taskSeed.tasks.length;
    const originalScanLength = warehouseSeed.warehouse_checkpoint_scans.length;

    try {
      renderWithProviders(<WarehouseModule />, {
        capabilities: ['warehouse.write', 'tasks.complete', 'all'],
      });

      await user.click(await screen.findByRole('button', { name: /WTR-2026-0479/i }));
      const scanRow = (await screen.findByText('origin_scan_in')).closest('tr');
      expect(scanRow).toBeTruthy();
      await user.click(within(scanRow!).getByRole('button', { name: /^Row actions$/i }));
      await user.click((await screen.findAllByText('Request correction'))[0]!);
      await user.clear(await screen.findByTestId('warehouse-scan-correction-barcode'));
      await user.type(screen.getByTestId('warehouse-scan-correction-barcode'), 'BAG-0479-CORRECTED');
      await user.type(screen.getByTestId('warehouse-scan-correction-reason'), 'Operator scan correction proof');
      await user.click((await screen.findAllByRole('button', { name: /^Request correction$/i })).at(-1)!);

      await waitFor(() => expect(requestSpy).toHaveBeenCalled());
      expect(requestSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          scan_event_id: 'wcs_1001',
          corrected_barcode: 'BAG-0479-CORRECTED',
          correction_reason: 'Operator scan correction proof',
        }),
      );
      const drawerAfterRequest = await waitFor(() => {
        const text = document.querySelector('.drawer')?.textContent ?? '';
        expect(text).toContain('Scan correction approvals');
        expect(text).toContain('Operator scan correction proof');
        return text;
      });
      expect(drawerAfterRequest).toContain('scan wcs_1001');
      expect(within(await screen.findByTestId('warehouse-action-readback')).getByText('request_scan_correction')).toBeInTheDocument();

      const requestedScanRow = (await screen.findByText('origin_scan_in')).closest('tr');
      expect(requestedScanRow).toBeTruthy();
      await user.click(within(requestedScanRow!).getByRole('button', { name: /^Row actions$/i }));
      await user.click((await screen.findAllByText('Record correction'))[0]!);
      await user.click((await screen.findAllByRole('button', { name: /^Record correction$/i })).at(-1)!);

      await waitFor(() => expect(transitionSpy).toHaveBeenCalled());
      expect(transitionSpy.mock.calls[0]?.[0]).toMatch(/^tsk_scan_corr_/);
      expect(transitionSpy.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          next_status: 'completed',
          action_kind: 'approve',
          payload: expect.objectContaining({
            source: 'console_v2.warehouse.scan_correction_approval',
            scan_event_id: 'wcs_1001',
            warehouse_transfer_id: 'wtr_2026_0479',
            corrected_barcode: 'BAG-0479-CORRECTED',
          }),
        }),
      );
      await waitFor(() => expect(recordSpy).toHaveBeenCalled());
      expect(recordSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          scan_type: 'correction',
          barcode: 'BAG-0479-CORRECTED',
          warehouse_transfer_id: 'wtr_2026_0479',
          correction_of_scan_event_id: 'wcs_1001',
          correction_reason: 'Operator scan correction proof',
        }),
      );
      const drawerAfterRecord = await waitFor(() => {
        const text = document.querySelector('.drawer')?.textContent ?? '';
        expect(text).toContain('BAG-0479-CORRECTED');
        expect(text).toContain('Operator scan correction proof');
        return text;
      });
      expect(drawerAfterRecord).toContain('correction');
      const readback = await screen.findByTestId('warehouse-action-readback');
      expect(within(readback).getByText('record_scan_correction')).toBeInTheDocument();
      expect(within(readback).getAllByText(/sce_/).length).toBeGreaterThanOrEqual(1);
    } finally {
      taskSeed.tasks.splice(originalTaskLength);
      warehouseSeed.warehouse_checkpoint_scans.splice(originalScanLength);
    }
  });

  it('completes the active warehouse pack task from the drawer', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    const transitionSpy = vi.spyOn(dsAdapter, 'transition_task_v1');
    vi
      .spyOn(dsAdapter, 'progress_workflow_run_until_wait_v1')
      .mockResolvedValueOnce({
        workflow_run_id: 'wfr_wh_0475',
        status: 'in_progress',
        steps: [],
      } as never);

    renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'tasks.complete', 'all'] });
    const transferMatches = await screen.findAllByText(/WTR-2026-0475/i);
    await user.click(transferMatches[0]!);
    const taskPanel = await screen.findByTestId('warehouse-active-task-warehouse_transfer_pack');
    expect(within(taskPanel).getByText(/TSK-WH-PACK-0475/)).toBeInTheDocument();
    await user.click(within(taskPanel).getByRole('button', { name: /^Complete task$/i }));

    await waitFor(() => expect(transitionSpy).toHaveBeenCalled());
    expect(transitionSpy.mock.calls[0]?.[0]).toBe('tsk_wh_pack_0475');
    expect(transitionSpy.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        next_status: 'completed',
        action_kind: 'resolve',
        payload: expect.objectContaining({
          warehouse_transfer_id: 'wtr_2026_0475',
          task_type_key: 'warehouse_transfer_pack',
          source: 'console_v2.warehouse.transfer_drawer',
        }),
      }),
    );
    const readback = await screen.findByTestId('warehouse-action-readback');
    expect(within(readback).getByText('task_completed')).toBeInTheDocument();
  });

  it('keeps warehouse dispatch task scan-driven instead of generic task completion', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    const transitionSpy = vi.spyOn(dsAdapter, 'transition_task_v1');

    renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'tasks.complete', 'all'] });
    const transferMatches = await screen.findAllByText(/WTR-2026-0476/i);
    await user.click(transferMatches[0]!);
    const taskPanel = await screen.findByTestId('warehouse-active-task-warehouse_transfer_dispatch');
    expect(within(taskPanel).getByText(/TSK-WH-DISPATCH-0476/)).toBeInTheDocument();
    const completeTaskButton = within(taskPanel).getByRole('button', { name: /^Complete task$/i });
    expect(completeTaskButton).toBeDisabled();
    expect(completeTaskButton).toHaveAttribute(
      'title',
      'Use the dedicated scan or reconcile action for this workflow task.',
    );
    expect(await screen.findByRole('button', { name: /Scan departure/i })).toBeEnabled();
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('destination reconcile modal calls ui_execute_warehouse_transfer_reconcile_v1', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    // @ts-expect-error seed raw fixtures are intentionally plain JS modules.
    const warehouseSeed = await import('@/lib/seed-raw/warehouse') as {
      warehouse_transfers: Array<Record<string, unknown>>;
    };
    // @ts-expect-error seed raw fixtures are intentionally plain JS modules.
    const taskSeed = await import('@/lib/seed-raw/domain-tasks') as {
      tasks: Array<Record<string, unknown>>;
    };
    const transfer = warehouseSeed.warehouse_transfers.find((row: Record<string, unknown>) => row.id === 'wtr_2026_0479');
    const task = taskSeed.tasks.find((row: Record<string, unknown>) => row.id === 'tsk_wh_reconcile_0479');
    expect(transfer).toBeTruthy();
    expect(task).toBeTruthy();
    const originalTransfer = { ...transfer! };
    const originalTask = { ...task! };
    const spy = vi.spyOn(dsAdapter, 'ui_execute_warehouse_transfer_reconcile_v1').mockImplementationOnce(
      async (args) => {
        Object.assign(transfer!, {
          status: 'reconciled',
          received_count: 48,
          variance_count: 0,
          variance_flag: false,
          updated_at: '2026-04-25T07:30:00Z',
        });
        Object.assign(task!, { status: 'completed' });
        return {
          ok: true,
          action_key: 'warehouse_transfers.reconcile_destination',
          resource_key: 'warehouse_transfers',
          warehouse_transfer_id: args.warehouse_transfer_id,
          count: 1,
          status: 'reconcile_recorded',
          transfer_status: 'reconciled',
        };
      },
    );
    try {
      renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'all'] });
      const transferMatches = await screen.findAllByText(/WTR-2026-0479/i);
      await user.click(transferMatches[0]!);
      await user.click(await screen.findByRole('button', { name: /Reconcile transfer/i }));
      await user.clear(await screen.findByTestId('warehouse-reconcile-received'));
      await user.type(await screen.findByTestId('warehouse-reconcile-received'), '48');
      const submitButtons = screen.getAllByRole('button', { name: /Reconcile transfer/i });
      await user.click(submitButtons[submitButtons.length - 1]!);
      await waitFor(() => expect(spy).toHaveBeenCalled());
      expect(spy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          warehouse_transfer_id: expect.stringMatching(/^wtr_/),
          received_shipment_count: 48,
        }),
      );
      const drawerText = await waitFor(() => {
        const text = document.querySelector('.drawer')?.textContent ?? '';
        expect(text).toContain('Reconciled');
        expect(text).toContain('No open warehouse workflow task is currently blocking this transfer.');
        return text;
      });
      expect(drawerText).toContain('48 received / 88 expected');
    } finally {
      Object.assign(transfer!, originalTransfer);
      Object.assign(task!, originalTask);
    }
  });

  it('bulk Reconcile opens the destination reconcile modal and does not transition status', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    const reconcileSpy = vi.spyOn(dsAdapter, 'ui_execute_warehouse_transfer_reconcile_v1');
    const transitionSpy = vi.spyOn(dsAdapter, 'transition_warehouse_transfer_v1');
    renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'all'] });

    const transferMatches = await screen.findAllByText(/WTR-2026-0481/i);
    const transferRow = transferMatches
      .map((match) => match.closest('tr'))
      .find((row): row is HTMLTableRowElement => Boolean(row));
    expect(transferRow).toBeTruthy();
    await user.click(within(transferRow!).getByLabelText('Select row'));
    await user.click(await screen.findByRole('button', { name: /^Reconcile$/i }));

    expect(await screen.findByTestId('warehouse-reconcile-modal')).toBeInTheDocument();
    await user.clear(screen.getByTestId('warehouse-reconcile-received'));
    await user.type(screen.getByTestId('warehouse-reconcile-received'), '48');
    await user.clear(screen.getByTestId('warehouse-reconcile-damaged'));
    await user.type(screen.getByTestId('warehouse-reconcile-damaged'), '2');
    await user.clear(screen.getByTestId('warehouse-reconcile-missing'));
    await user.type(screen.getByTestId('warehouse-reconcile-missing'), '3');
    await user.clear(screen.getByTestId('warehouse-reconcile-unmanifested'));
    await user.type(screen.getByTestId('warehouse-reconcile-unmanifested'), '4');
    await user.type(screen.getByTestId('warehouse-reconcile-notes'), 'destination proof ref PRF-48');
    const submitButtons = screen.getAllByRole('button', { name: /Reconcile transfer/i });
    await user.click(submitButtons[submitButtons.length - 1]!);

    await waitFor(() => expect(reconcileSpy).toHaveBeenCalled());
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(reconcileSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        warehouse_transfer_id: expect.stringMatching(/^wtr_/),
        received_shipment_count: 48,
        damaged_shipment_count: 2,
        missing_shipment_count: 3,
        unmanifested_shipment_count: 4,
        reconcile_notes: 'destination proof ref PRF-48',
      }),
    );
  });

  it('does not surface a synthetic-id "Record scan" or "Execute transfer" header CTA (W38 closure / W39 symmetry guard)', async () => {
    // W38-PLATFORM closure: the previous synthetic-id header CTAs
    // ("Record scan" firing record_scan_event_v1 with `transfer_id:
    // 'wtr_synth'`; "Execute transfer" firing
    // warehouse_transfer_execute_v1 with empty payload) were removed
    // because they could not bind to a real warehouse_transfer at click
    // time. Per-row Receive / Reconcile / Approve variance flows already
    // exist in the kanban card + drawer footer + rowActions wired to the
    // canonical r.id. This regression guard mirrors the W38 labels.tsx
    // anti-CTA pattern (REAUDIT5B PLATFORM §3.2 / W39 symmetry).
    renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'all'] });
    expect(screen.queryByRole('button', { name: /^Record scan$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Execute transfer$/i })).toBeNull();
  });

  // W35e-4 — every callsite passes the canonical jsonb envelope
  // `{ warehouse_transfer_id, to_status }`. The api facade also accepts the
  // legacy 2-arg form for backwards-compat, but we explicitly assert every
  // call records the canonical shape so a future revert to positional args
  // fails closed. Closes REAUDIT3/PLATFORM.md P1-1.
  it('creates a transfer manifest through the canonical warehouse manifest RPC', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    const spy = vi.spyOn(dsAdapter, 'create_warehouse_transfer_manifest_v1');

    renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'all'] });

    await user.click(await screen.findByRole('button', { name: /^Create manifest$/i }));
    expect(await screen.findByTestId('warehouse-manifest-create-modal')).toBeInTheDocument();

    await waitFor(() => {
      expect(document.querySelectorAll('input[data-testid^="warehouse-manifest-shipment-"]').length).toBeGreaterThan(0);
    });
    const selectedShipments = document.querySelectorAll<HTMLInputElement>(
      'input[data-testid^="warehouse-manifest-shipment-"]',
    );
    await user.click(selectedShipments[0]!);

    await user.click(screen.getByRole('button', { name: /^Create manifest$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        transfer_code: expect.stringMatching(/^WTR-/),
        organization_id: expect.any(String),
        from_branch_id: expect.any(String),
        to_branch_id: expect.any(String),
        shipment_ids: expect.arrayContaining([expect.any(String)]),
        metadata: expect.objectContaining({
          source: 'console_v2.warehouse.manifest_create',
        }),
      }),
    );
    expect((spy.mock.calls[0]?.[0] as Record<string, unknown>).from_branch_id).not.toBe(
      (spy.mock.calls[0]?.[0] as Record<string, unknown>).to_branch_id,
    );
    const readback = await screen.findByTestId('warehouse-action-readback');
    expect(within(readback).getByText('manifest_created')).toBeInTheDocument();
    expect(within(readback).getByText(/WTR-/)).toBeInTheDocument();
  });

  it('surfaces manifest creation failures inline for operator recovery', async () => {
    const user = userEvent.setup();
    const dsAdapter = await import('@/lib/data-source');
    const spy = vi
      .spyOn(dsAdapter, 'create_warehouse_transfer_manifest_v1')
      .mockRejectedValueOnce(new Error('shipment_ids must resolve to organization shipments'));

    renderWithProviders(<WarehouseModule />, { capabilities: ['warehouse.write', 'all'] });

    await user.click(await screen.findByRole('button', { name: /^Create manifest$/i }));

    await waitFor(() => {
      expect(document.querySelectorAll('input[data-testid^="warehouse-manifest-shipment-"]').length).toBeGreaterThan(0);
    });
    const selectedShipments = document.querySelectorAll<HTMLInputElement>(
      'input[data-testid^="warehouse-manifest-shipment-"]',
    );
    await user.click(selectedShipments[0]!);
    await user.click(screen.getByRole('button', { name: /^Create manifest$/i }));

    expect(await screen.findByText('Create manifest failed')).toBeInTheDocument();
    expect(screen.getByText('shipment_ids must resolve to organization shipments')).toBeInTheDocument();
    expect(spy).toHaveBeenCalled();
  });

  describe('W35e-4 canonical jsonb envelope for transition_warehouse_transfer_v1', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('legacy 2-arg `(transferId, toStatus)` form is adapted to canonical envelope', async () => {
      const dsAdapter = await import('@/lib/data-source');
      const spy = vi.spyOn(dsAdapter, 'transition_warehouse_transfer_v1');
      // Call via the api facade with legacy positional args.
      await (apiMod as unknown as {
        transition_warehouse_transfer_v1: (id: string, st: string) => Promise<unknown>;
      }).transition_warehouse_transfer_v1('wtr_test', 'received');
      expect(spy).toHaveBeenCalled();
      const args = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      // Canonical envelope received by the adapter regardless of call shape.
      expect(args?.warehouse_transfer_id).toBe('wtr_test');
      expect(args?.to_status).toBe('received');
      // Negative guard: legacy positional args must not leak into the envelope.
      expect((args as { 0?: string })?.[0]).toBeUndefined();
    });

    it('explicit canonical envelope passes through unchanged', async () => {
      const dsAdapter = await import('@/lib/data-source');
      const spy = vi.spyOn(dsAdapter, 'transition_warehouse_transfer_v1');
      await apiMod.transition_warehouse_transfer_v1({
        warehouse_transfer_id: 'wtr_test_2',
        to_status: 'reconciled',
        from_status: 'received',
      });
      const args = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(args?.warehouse_transfer_id).toBe('wtr_test_2');
      expect(args?.to_status).toBe('reconciled');
      expect(args?.from_status).toBe('received');
    });

    // W37 (PLATFORM REAUDIT4 P1) — every callsite that passes `to_status` to the
    // canonical RPC must use a canonical past-tense value from the
    // `warehouse_transfer_status` lookup catalog (per
    // supabase/migrations/202604301500_v_warehouse_transfer_summary.sql:
    // status IN ('received', 'reconciled', 'on_hold')). This regression guard
    // greps the source for any leftover legacy imperative values
    // (`'receive'` / `'reconcile'`) being passed to `transition(...)` so a
    // future revert to imperative values fails closed.
    it('warehouse.tsx callsites pass canonical past-tense to_status values', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const file = path.resolve(__dirname, '../warehouse.tsx');
      const src = fs.readFileSync(file, 'utf8');
      // Negative guard: no legacy imperative value should be passed to transition().
      expect(src).not.toMatch(/transition\([^)]*'receive'\s*\)/);
      expect(src).not.toMatch(/transition\([^)]*'reconcile'\s*\)/);
      // Positive guard: receive/reconcile stay on task-backed workflow commands,
      // not direct status transitions from the Warehouse page.
      expect(src).not.toMatch(/transition\([^)]*'received'\s*\)/);
      expect(src).not.toMatch(/bulkTransition\(\s*rs,\s*'reconciled'/);
      expect(src).toMatch(/ui_execute_warehouse_transfer_reconcile_v1|openReconcileModal/);
    });
  });
});
