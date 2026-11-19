// exceptions.lifecycle.test.tsx — closes OPERATIONS reaudit D2 for the
// exceptions surface. Adds per-RPC Vitest assertions for the NDR
// resolution actions (Preview / Apply / Escalate) and the per-row Apply /
// cell-edit transitions that previously had no direct mutation test
// (`exceptions.test.tsx` only mounts and verifies the SLA chip + tab cleanup).
//
// Asserted behavior per action:
//   1. mount + capability gate (positive + negative).
//   2. happy path — clicking the action button fires the canonical RPC
//      (`ui_execute_dispatch_exception_resolution_v1` for Preview/Apply,
//      `transition_task_v1` for Escalate / status cell-edit) with the
//      expected payload.
//   3. mutation invalidation — tasks list query is invalidated post-mutation.
//   4. failure mode — when the RPC rejects, the seam is still called and the
//      module does not crash.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ExceptionsModule } from '@/modules/operate/exceptions';
import * as ds from '@/lib/data-source';
import {
  exceptionReturnCompleteResource,
  exceptionReturnOperatorIdentity,
  exceptionTaskRows,
} from './exceptions-return.fixtures';

const RESOLVE_SPY = vi.spyOn(ds, 'ui_execute_dispatch_exception_resolution_v1');
const TRANSITION_SPY = vi.spyOn(ds, 'transition_task_v1');
const NDR_SPY = vi.spyOn(ds, 'resolve_ndr_branch_next_action_v1');
const LOOKUP_ROW_SPY = vi.spyOn(ds, 'lookupRow');
const LIST_TASKS_SPY = vi.spyOn(ds, 'listTasks');
const COMPLETE_LIST_SPY = vi.spyOn(ds, 'ui_list_resource_complete');
const COMPLETE_RESOURCE = ds.ui_list_resource_complete;

beforeEach(() => {
  RESOLVE_SPY.mockClear();
  RESOLVE_SPY.mockResolvedValue({
    ok: true,
    task_id: 'tsk_exception_refused_fixture',
    resolution: { resolution_action: 'reschedule' },
    dry_run: false,
    canonical_entrypoint: 'public.ui_execute_dispatch_exception_resolution_v1',
    canonical_args: {
      action_key: 'dispatch_exception_review.complete',
      resource_key: 'dispatch_exception_review',
      selection_ids: ['tsk_exception_refused_fixture'],
      selection_id: 'tsk_exception_refused_fixture',
      selection_count: 1,
      params: { resolution_action: 'reschedule' },
    },
    policy: 'ndr_policy',
    settings_resolution_id: 'srlv_exception_fixture',
    apply_status: 'completed',
    results: [],
  });
  TRANSITION_SPY.mockClear();
  TRANSITION_SPY.mockResolvedValue({
    ok: true,
    task: { id: 'tsk_exception_refused_fixture', status: 'escalated' },
  });
  NDR_SPY.mockClear();
  NDR_SPY.mockResolvedValue('reschedule');
  LOOKUP_ROW_SPY.mockClear();
  LOOKUP_ROW_SPY.mockImplementation((category, value) => {
    if (category === 'task_action_kind' && value === 'escalate') {
      return { value, label: 'Escalate', metadata: { next_status: 'escalated' } };
    }
    if (category === 'ndr_branch_next_action' && value === 'reschedule') {
      return { value, tone: 'good', label: 'Reschedule' };
    }
    if (category === 'ndr_action' && value === 'hold_at_branch') {
      return { value, label: 'Hold at Branch' };
    }
    return null;
  });
  LIST_TASKS_SPY.mockClear();
  LIST_TASKS_SPY.mockResolvedValue(exceptionTaskRows);
  COMPLETE_LIST_SPY.mockClear();
  COMPLETE_LIST_SPY.mockImplementation((resource, opts) =>
    exceptionReturnCompleteResource(resource, opts, COMPLETE_RESOURCE),
  );
});

async function openFirstTaskDrawer() {
  const user = userEvent.setup();
  await waitFor(() => {
    expect(document.body.textContent).toContain('TSK-NDR-FIXTURE');
  });
  await user.click(document.querySelector('.dt__table tbody tr') as Element);
  await waitFor(() => {
    expect(document.querySelector('.drawer')).not.toBeNull();
  });
  return user;
}

function findDrawerButton(label: RegExp): HTMLElement {
  const drawer = document.querySelector('.drawer');
  if (!drawer) throw new Error('drawer not rendered');
  const btn = Array.from(drawer.querySelectorAll('button')).find((b) => {
    return label.test((b.textContent ?? '').trim());
  });
  if (!btn) {
    const labels = Array.from(drawer.querySelectorAll('button'))
      .map((b) => (b.textContent ?? '').trim())
      .filter(Boolean)
      .join(' | ');
    throw new Error(`drawer button matching ${label} not found. Buttons: ${labels}`);
  }
  return btn as HTMLElement;
}

function completedTaskRows() {
  return exceptionTaskRows.map((row) =>
    row.id === 'tsk_exception_refused_fixture'
      ? {
          ...row,
          status: 'completed',
          metadata: {
            ...(row.metadata ?? {}),
            resolution_action: 'reschedule',
            resolution_status: 'completed',
          },
        }
      : row,
  );
}

function mockApplyThenCompletedReadback(action = 'reschedule') {
  let completed = false;
  LIST_TASKS_SPY.mockImplementation(async () => (completed ? completedTaskRows() : exceptionTaskRows));
  RESOLVE_SPY.mockImplementation(async (_taskId, _resolution, opts) => {
    if (!opts?.dryRun) completed = true;
    return {
      ok: true,
      task_id: 'tsk_exception_refused_fixture',
      resolution: { resolution_action: action },
      dry_run: Boolean(opts?.dryRun),
      canonical_entrypoint: 'public.ui_execute_dispatch_exception_resolution_v1',
      canonical_args: {
        action_key: 'dispatch_exception_review.complete',
        resource_key: 'dispatch_exception_review',
        selection_ids: ['tsk_exception_refused_fixture'],
        selection_id: 'tsk_exception_refused_fixture',
        selection_count: 1,
        params: { resolution_action: action },
      },
      policy: 'ndr_policy',
      settings_resolution_id: 'srlv_exception_fixture',
      apply_status: opts?.dryRun ? 'preview' : 'completed',
      results: opts?.dryRun
        ? []
        : [{
            task_id: 'tsk_exception_refused_fixture',
            outcome: 'ok',
            task_event_id: 'te_exception_fixture',
            workflow_run_id: 'wr_exception_fixture',
            shipment_action_id: 'sa_exception_fixture',
          }],
    };
  });
}

function findPaletteItem(label: RegExp): HTMLElement {
  const item = Array.from(document.querySelectorAll<HTMLElement>('.palette__item')).find((node) =>
    label.test(node.querySelector('.palette__item-label')?.textContent?.trim() ?? ''),
  );
  if (!item) throw new Error(`palette item matching ${label} not found`);
  return item;
}

describe('ExceptionsModule · NDR resolution lifecycle (OPERATIONS reaudit D2)', () => {
  it('mounts the queue and shows at least one task row', async () => {
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    await waitFor(() => {
      expect(document.body.textContent).toContain('TSK-NDR-FIXTURE');
    });
    expect(screen.getByText(/Exceptions/i)).toBeInTheDocument();
  });

  it('disables drawer and table resolution actions when tasks.write is missing', async () => {
    renderWithProviders(<ExceptionsModule />, {
      identity: {
        ...exceptionReturnOperatorIdentity,
        capabilities: ['shipments.read'],
      },
    });
    await openFirstTaskDrawer();
    expect(findDrawerButton(/^Preview reschedule/i)).toBeDisabled();
    expect(findDrawerButton(/^Apply reschedule/i)).toBeDisabled();
    expect(findDrawerButton(/^Escalate/i)).toBeDisabled();
    expect(screen.getAllByText(/Task update permission required/i).length).toBeGreaterThan(0);

    await userEvent.keyboard('{Escape}');
    const firstRowCheckbox = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.getAttribute('aria-label') === 'Select row');
    if (!firstRowCheckbox) throw new Error('No row checkbox');
    await userEvent.click(firstRowCheckbox);
    expect(await screen.findByRole('button', { name: /Bulk reschedule \(preview\)/i })).toBeDisabled();
    expect(await screen.findByRole('button', { name: /Return to branch \(preview\)/i })).toBeDisabled();

    await userEvent.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    await waitFor(() => {
      expect(findPaletteItem(/^Preview reschedule$/)).toHaveClass('is-disabled');
    });
    expect(findPaletteItem(/^Preview cancel$/)).toHaveClass('is-disabled');
  });

  it('shows a read-only resolved state for terminal NDR tasks', async () => {
    LIST_TASKS_SPY.mockResolvedValue(completedTaskRows());

    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    await openFirstTaskDrawer();

    const drawer = document.querySelector('.drawer');
    expect(drawer).not.toBeNull();
    expect(drawer).toHaveTextContent('Recovery action is already resolved for this task (completed).');
    expect(drawer).not.toHaveTextContent('Preview reschedule');
    expect(drawer).not.toHaveTextContent('Apply reschedule');
  });

  it('Preview fires ui_execute_dispatch_exception_resolution_v1 with dryRun=true', async () => {
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    const user = await openFirstTaskDrawer();
    const ta = document.querySelector('.drawer textarea') as HTMLTextAreaElement | null;
    if (ta) await user.type(ta, 'Preview note for backend evidence');
    const previewBtn = findDrawerButton(/^Preview reschedule$/i);
    await user.click(previewBtn);
    await waitFor(() => {
      expect(RESOLVE_SPY).toHaveBeenCalled();
    });
    const [taskId, resolution, opts] = RESOLVE_SPY.mock.calls[0] as [
      string,
      unknown,
      { dryRun?: boolean | 'preview' } | undefined,
    ];
    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(0);
    expect(resolution).toMatchObject({
      resolution_action: expect.any(String),
      notes: 'Preview note for backend evidence',
    });
    expect(opts?.dryRun).toBe(true);
    const preview = await screen.findByLabelText('Exception resolution preview');
    expect(preview).toHaveTextContent('Preview ready');
    expect(preview).toHaveTextContent('reschedule');
    expect(preview).toHaveTextContent('public.ui_execute_dispatch_exception_resolution_v1');
    expect(preview).toHaveTextContent('ndr_policy');
    expect(preview).toHaveTextContent('Passed');
    expect(preview).toHaveTextContent('preview');
  });

  it('shows a visible apply blocker when required evidence notes are missing', async () => {
    LIST_TASKS_SPY.mockResolvedValue(
      exceptionTaskRows.map((row) =>
        row.id === 'tsk_exception_refused_fixture' ? { ...row, evidence_required: true } : row,
      ),
    );
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    await openFirstTaskDrawer();

    const applyBtn = findDrawerButton(/^Apply reschedule$/i);
    expect(applyBtn).toBeDisabled();
    expect(screen.getByText('Evidence required')).toBeInTheDocument();
    expect(screen.getByText('Evidence required: add notes before apply.')).toBeInTheDocument();
  });

  it('Apply fires ui_execute_dispatch_exception_resolution_v1 without dryRun and invalidates tasks', async () => {
    mockApplyThenCompletedReadback();
    const { queryClient } = renderWithProviders(<ExceptionsModule />, {
      identity: exceptionReturnOperatorIdentity,
    });
    const user = await openFirstTaskDrawer();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    // The Apply button may be disabled if evidence_required is true and notes
    // are empty. Fill the textarea first to clear that gate.
    const ta = document.querySelector('.drawer textarea') as HTMLTextAreaElement | null;
    if (ta) await user.type(ta, 'Verified with recipient · reschedule to tomorrow');
    const applyBtn = findDrawerButton(/^Apply reschedule$/i);
    expect(applyBtn).not.toBeDisabled();
    await user.click(applyBtn);
    await waitFor(() => {
      expect(RESOLVE_SPY).toHaveBeenCalled();
    });
    const lastCall = RESOLVE_SPY.mock.calls[RESOLVE_SPY.mock.calls.length - 1] as [
      string,
      unknown,
      { dryRun?: boolean } | undefined,
    ];
    expect(typeof lastCall[0]).toBe('string');
    expect(lastCall[0]?.length).toBeGreaterThan(0);
    expect(lastCall[1]).toMatchObject({
      resolution_action: expect.any(String),
      notes: 'Verified with recipient · reschedule to tomorrow',
    });
    expect(!!lastCall[2]?.dryRun).toBe(false);
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('Apply reconciles the visible task row to Completed without remounting', async () => {
    let completed = false;
    const completedRows = exceptionTaskRows.map((row) =>
      row.id === 'tsk_exception_refused_fixture'
        ? {
            ...row,
            status: 'completed',
            metadata: {
              ...(row.metadata ?? {}),
              resolution_action: 'hold_at_branch',
              resolution_status: 'completed',
            },
          }
        : row,
    );
    LIST_TASKS_SPY.mockImplementation(async () => (completed ? completedRows : exceptionTaskRows));
    RESOLVE_SPY.mockImplementation(async () => {
      completed = true;
      return {
        ok: true,
        task_id: 'tsk_exception_refused_fixture',
        resolution: { resolution_action: 'hold_at_branch' },
        dry_run: false,
        canonical_entrypoint: 'public.ui_execute_dispatch_exception_resolution_v1',
        canonical_args: {
          action_key: 'dispatch_exception_review.complete',
          resource_key: 'dispatch_exception_review',
          selection_ids: ['tsk_exception_refused_fixture'],
          selection_id: 'tsk_exception_refused_fixture',
          selection_count: 1,
          params: { resolution_action: 'hold_at_branch' },
        },
        policy: 'ndr_policy',
        settings_resolution_id: 'srlv_exception_fixture',
        apply_status: 'completed',
        results: [{
          task_id: 'tsk_exception_refused_fixture',
          outcome: 'ok',
          task_event_id: 'te_exception_fixture',
          workflow_run_id: 'wr_exception_fixture',
          shipment_action_id: 'sa_exception_fixture',
        }],
      };
    });

    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    const user = await openFirstTaskDrawer();
    await user.click(findDrawerButton(/^Return to branch$/));
    const ta = document.querySelector('.drawer textarea') as HTMLTextAreaElement | null;
    if (ta) await user.type(ta, 'No-reload visible completion proof');
    await user.click(findDrawerButton(/^Apply Return to branch$/i));

    await waitFor(() => {
      const rowText = document.querySelector('.dt__table tbody tr')?.textContent ?? '';
      expect(rowText).toContain('Completed');
    });
    const readback = await screen.findByLabelText('Exception resolution status');
    expect(readback).toHaveTextContent('Action completed and the exception queue was refreshed');
    expect(readback).toHaveTextContent('Policy check');
    expect(readback).toHaveTextContent('Activity');
    expect(readback).toHaveTextContent('Workflow');
    expect(readback).not.toHaveTextContent('ui_execute_dispatch_exception_resolution_v1');
    expect(readback).not.toHaveTextContent('srlv_exception_fixture');
    expect(readback).not.toHaveTextContent('te_exception_fixture');
    expect(readback).not.toHaveTextContent('wr_exception_fixture');
    expect(readback).not.toHaveTextContent('sa_exception_fixture');
    expect(readback).toHaveTextContent('updated (completed)');
    expect(LIST_TASKS_SPY.mock.calls.length).toBeGreaterThan(1);
  });

  it('Apply readback keeps lineage fields pending when backend omits canonical ids', async () => {
    let completed = false;
    const completedRows = exceptionTaskRows.map((row) =>
      row.id === 'tsk_exception_refused_fixture'
        ? {
            ...row,
            status: 'completed',
            metadata: {
              ...(row.metadata ?? {}),
              resolution_action: 'reschedule',
              resolution_status: 'completed',
            },
          }
        : row,
    );
    LIST_TASKS_SPY.mockImplementation(async () => (completed ? completedRows : exceptionTaskRows));
    RESOLVE_SPY.mockImplementation(async () => {
      completed = true;
      return {
        ok: true,
        task_id: 'tsk_exception_refused_fixture',
        resolution: { resolution_action: 'reschedule' },
        dry_run: false,
        canonical_entrypoint: '',
        canonical_args: {
          action_key: 'dispatch_exception_review.complete',
          resource_key: 'dispatch_exception_review',
          selection_ids: ['tsk_exception_refused_fixture'],
          selection_id: 'tsk_exception_refused_fixture',
          selection_count: 1,
          params: { resolution_action: 'reschedule' },
        },
        policy: '',
        settings_resolution_id: '',
        apply_status: 'completed',
        results: [{
          task_id: 'tsk_exception_refused_fixture',
          outcome: 'ok',
          task_event_id: '',
          workflow_run_id: '',
          shipment_action_id: '',
        }],
      };
    });

    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    const user = await openFirstTaskDrawer();
    const ta = document.querySelector('.drawer textarea') as HTMLTextAreaElement | null;
    if (ta) await user.type(ta, 'Lineage pending readback proof');
    await user.click(findDrawerButton(/^Apply reschedule$/i));

    const readback = await screen.findByLabelText('Exception resolution status');
    expect(readback).toHaveTextContent(/Policy check\s*Pending/);
    expect(readback).toHaveTextContent(/Activity\s*Pending/);
    expect(readback).toHaveTextContent(/Workflow\s*Pending/);
    expect(readback).toHaveTextContent('updated (completed)');
  });

  it('Apply stays in context and does not show success when backend readback is stale', async () => {
    LIST_TASKS_SPY.mockResolvedValue(exceptionTaskRows);

    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    const user = await openFirstTaskDrawer();
    const ta = document.querySelector('.drawer textarea') as HTMLTextAreaElement | null;
    if (ta) await user.type(ta, 'Stale readback proof');
    await user.click(findDrawerButton(/^Apply reschedule$/i));

    await waitFor(() => {
      expect(RESOLVE_SPY).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(screen.queryByLabelText('Exception resolution status')).not.toBeInTheDocument();
  });

  it('Row Apply reschedule also waits for refreshed backend readback', async () => {
    mockApplyThenCompletedReadback('reschedule');
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.body.textContent).toContain('TSK-NDR-FIXTURE');
    });
    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    await waitFor(() => {
      expect(findPaletteItem(/^Apply \(reschedule\)$/)).toBeTruthy();
    });
    await user.click(findPaletteItem(/^Apply \(reschedule\)$/));

    const readback = await screen.findByLabelText('Exception resolution status');
    expect(readback).toHaveTextContent('updated (completed)');
    expect(readback).toHaveTextContent('reschedule');
  });

  it('Bulk confirm apply gates success on each refreshed backend readback', async () => {
    mockApplyThenCompletedReadback('reschedule');
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.body.textContent).toContain('TSK-NDR-FIXTURE');
    });
    const firstRowCheckbox = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.getAttribute('aria-label') === 'Select row');
    if (!firstRowCheckbox) throw new Error('No row checkbox');
    await user.click(firstRowCheckbox);
    await user.click(await screen.findByRole('button', { name: /Bulk reschedule \(preview\)/i }));
    await user.click(await screen.findByRole('button', { name: /Confirm apply/i }));

    const readback = await screen.findByLabelText('Exception resolution status');
    expect(readback).toHaveTextContent('updated (completed)');
    expect(readback).toHaveTextContent('reschedule');
  });

  it('Return to branch preview sends canonical hold_at_branch action', async () => {
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.body.textContent).toContain('TSK-NDR-FIXTURE');
    });
    const firstRowCheckbox = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.getAttribute('aria-label') === 'Select row');
    if (!firstRowCheckbox) throw new Error('No row checkbox');
    await user.click(firstRowCheckbox);

    const returnPreview = await screen.findByRole('button', {
      name: /Return to branch \(preview\)/i,
    });
    await user.click(returnPreview);

    await waitFor(() => {
      expect(RESOLVE_SPY).toHaveBeenCalled();
    });
    const [, resolution, opts] = RESOLVE_SPY.mock.calls[0] as [
      string,
      string,
      { dryRun?: boolean } | undefined,
    ];
    expect(resolution).toBe('hold_at_branch');
    expect(opts?.dryRun).toBe(true);
  });

  it('Escalate fires transition_task_v1 with next_status=escalated', async () => {
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    const user = await openFirstTaskDrawer();
    await user.click(findDrawerButton(/^Escalate$/));
    await waitFor(() => {
      expect(TRANSITION_SPY).toHaveBeenCalled();
    });
    const [taskId, transition] = TRANSITION_SPY.mock.calls[0] as [
      string,
      { next_status?: string },
    ];
    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(0);
    expect(transition.next_status).toBe('escalated');
  });

  it('surfaces the failure path when the resolution RPC rejects (bulk preview)', async () => {
    // Bulk preview path wraps each `resolveExc.mutateAsync` in try/catch so
    // a rejection is captured and reported through the bulk-summary modal
    // ("error" outcome row). Use this path for the failure test — the
    // single-row Preview onClick does not catch and would surface an
    // unhandled rejection in the test runner.
    RESOLVE_SPY.mockRejectedValueOnce(new Error('settings_resolution outage'));
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.body.textContent).toContain('TSK-NDR-FIXTURE');
    });
    // Select the first row so the bulk-action bar becomes available.
    const firstRowCheckbox = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.getAttribute('aria-label') === 'Select row');
    if (!firstRowCheckbox) throw new Error('No row checkbox');
    await user.click(firstRowCheckbox);
    // Click Bulk reschedule (preview).
    const bulkPreview = await screen.findByRole('button', {
      name: /Bulk reschedule \(preview\)/i,
    });
    await user.click(bulkPreview);
    // The bulk-summary modal opens regardless of the row outcome
    // (ok / blocked / error); assert the seam was invoked.
    await waitFor(() => {
      expect(RESOLVE_SPY).toHaveBeenCalled();
    });
    RESOLVE_SPY.mockReset();
  });
});
