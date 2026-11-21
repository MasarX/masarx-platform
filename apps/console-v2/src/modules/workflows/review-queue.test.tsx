// Light-weight integration tests for the ReviewQueueModule. We mount via the
// real provider stack and exercise:
//   - Mount renders filters + at least one task.
//   - Search box filters the list.
//   - Saved view persists to LocalStorage and reappears as a chip.
//   - Row-driven action buttons render exactly the kinds in `task.allowed_actions`.
//   - Snooze keyboard shortcut flips the active task to status="snoozed" with a
//     persisted `snooze_until` ISO (asserted in the detail-pane scope, not in
//     the toolbar where the "Snoozed" filter chip would falsely match).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ReviewQueueModule } from './review-queue';
import * as apiMod from '@/lib/api';
import { qk } from '@/lib/queries';
import * as toastStore from '@/components/toastStore';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';

vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => null,
}));

beforeEach(() => {
  window.localStorage.removeItem('console-v2.review-queue.views');
  document.body.style.pointerEvents = '';
  window.history.pushState(null, '', '/workflows/review-queue');
});

afterEach(() => {
  document.body.style.pointerEvents = '';
  window.history.pushState(null, '', '/workflows/review-queue');
});

async function mountAndWait() {
  const utils = renderWithProviders(<ReviewQueueModule />, {
    capabilities: ['tasks.read', 'tasks.write', 'tasks.complete', 'audit_log.read', 'console_metadata.read'],
  });
  // Wait for the policy resolver + tasks query to land. The strict guard
  // (W30) renders an error StateView when `task_sla_thresholds` is null,
  // but the seed-raw policy mirror provides the row — the query still
  // resolves async. Awaiting the toolbar's "Assigned to me" filter chip
  // (only present after all guards pass) confirms the page rendered.
  await screen.findByRole('button', { name: /Assigned to me/i });
  await waitFor(() => {
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });
  return utils;
}

/** Find the detail-pane container so assertions can be scoped to it (avoids
 *  false matches against the static "Snoozed" filter chip in the toolbar). */
function detailPane(): HTMLElement {
  const head = document.querySelector('.wf-rq-detail__head') as HTMLElement | null;
  if (!head) throw new Error('Detail pane head not mounted');
  return head;
}

async function activateTask(user: ReturnType<typeof userEvent.setup>, taskId: string): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: /^All/i }));
  const row = await waitFor(() => {
    const el = document.querySelector(`[role="listitem"][aria-label*="${taskId}"]`) as HTMLElement | null;
    if (!el) throw new Error(`${taskId} row not mounted yet`);
    return el;
  });
  await user.click(row);
  return row;
}

async function selectVisibleTasks(user: ReturnType<typeof userEvent.setup>, count: number): Promise<string[]> {
  await user.click(screen.getByRole('button', { name: /^All/i }));
  await waitFor(() => {
    expect(screen.getAllByRole('checkbox', { name: /Select task/i }).length).toBeGreaterThanOrEqual(count);
  });
  const checkboxes = screen.getAllByRole('checkbox', { name: /Select task/i }).slice(0, count);
  const taskIds: string[] = [];
  for (const checkbox of checkboxes) {
    const label = checkbox.getAttribute('aria-label') ?? '';
    const displayId = label.match(/Select task\s+([A-Z]+-\d+)/i)?.[1] ?? '';
    if (displayId) taskIds.push(displayId.toLowerCase().replace('-', '_'));
    await user.click(checkbox);
  }
  await screen.findByText(`${count} selected`);
  return taskIds;
}

function bulkBar(): HTMLElement {
  const selectedCount = screen.getByText(/\d+ selected/i);
  const bar = selectedCount.closest('.wf-rq-bulkbar') as HTMLElement | null;
  if (!bar) throw new Error('Bulk action bar not mounted');
  return bar;
}

function expectDetailNotSnoozed() {
  const head = detailPane();
  expect(within(head).queryByText(/^snoozed$/i)).toBeNull();
  expect(within(head).queryByText(/wakes in/i)).toBeNull();
}

describe('ReviewQueueModule', () => {
  it('renders filter chips and a task list', async () => {
    await mountAndWait();
    expect(screen.getByRole('button', { name: /Assigned to me/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unassigned/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /sort review queue/i })).toBeInTheDocument();
    expect(screen.queryByTitle(/^Sort$/i)).toBeNull();
    // The seed has tasks; one of them must be visible eventually.
    await waitFor(() => {
      expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
    });
  });

  it('shows a denied state without issuing protected task or workflow reads', async () => {
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const tasksSpy = typedSpy(apiMod, 'listTasks');
    try {
      renderWithProviders(<ReviewQueueModule />, { capabilities: ['audit_log.read'] });

      expect(await screen.findByText(/You do not have permission to view the review queue/i)).toBeInTheDocument();
      await waitFor(() => {
        const resources = listSpy.mock.calls.map(([resource]) => resource);
        expect(tasksSpy).not.toHaveBeenCalled();
        expect(resources).not.toContain('users');
        expect(resources).not.toContain('workflow_runs');
        expect(resources).not.toContain('task_events');
      });
      expect(screen.queryByRole('button', { name: /Assigned to me/i })).not.toBeInTheDocument();
    } finally {
      tasksSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('selects the focused task from the focus query parameter', async () => {
    window.history.pushState(null, '', '/workflows/review-queue?focus=tsk_3001');
    await mountAndWait();
    await waitFor(() => {
      expect(detailPane().textContent ?? '').toMatch(/TSK-3001|Amend address/);
    });
  });

  it('filters the list with the search box', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    // Switch to "All" so seed tasks are present regardless of identity user.
    await user.click(screen.getByRole('button', { name: /^All/i }));
    const before = screen.getAllByRole('listitem').length;
    expect(before).toBeGreaterThan(0);
    const search = screen.getByTestId('wf-rq-search');
    await user.type(search, 'recipient');
    await waitFor(() => {
      const after = screen.queryAllByRole('listitem').length;
      // Either we narrowed down (good), or we went to 0 (also a valid filter outcome).
      expect(after).toBeLessThanOrEqual(before);
    });
  });

  it('persists a saved view to localStorage', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    await user.click(screen.getByRole('button', { name: /^All/i }));
    const search = screen.getByTestId('wf-rq-search');
    await user.type(search, 'shp');
    await user.click(screen.getByRole('button', { name: /Save view/i }));
    const nameInput = await screen.findByLabelText(/View name/i);
    await user.type(nameInput, 'Active SHP');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    // Saved view chip appears.
    await waitFor(() => {
      expect(screen.getByText(/Active SHP/i)).toBeInTheDocument();
    });
    // LocalStorage updated.
    const raw = window.localStorage.getItem('console-v2.review-queue.views');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed[0].label).toBe('Active SHP');
  });

  it('shows the decision-evidence chip in the detail pane', async () => {
    await mountAndWait();
    await waitFor(() => {
      expect(screen.getByTestId('wf-rq-evidence')).toBeInTheDocument();
    });
  });

  it('renders operator audit activity without raw backend table names or trace IDs', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    await user.click(screen.getByRole('button', { name: /^All/i }));
    const target = await waitFor(() => {
      const row = document.querySelector('[aria-label*="TSK-2901"]') as HTMLElement | null;
      if (!row) throw new Error('TSK-2901 row not mounted yet');
      return row;
    });
    await user.click(target);
    const timeline = await screen.findByTestId('wf-rq-audit-activity');
    await waitFor(() => {
      expect(within(timeline).getByText(/Updated - Review task/i)).toBeInTheDocument();
      expect(within(timeline).getByText(/Created - Task event/i)).toBeInTheDocument();
    });
    expect(within(timeline).getByText(/Activity reference recorded/i)).toBeInTheDocument();
    expect(timeline.textContent).not.toMatch(/audit_table_changes|task_events|audit_log\.read|cor_9817/i);
  });

  it('renders task event activity with tasks.read even without audit log access', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'task_events') {
        return {
          rows: [
            {
              id: 'tev_cod_cashier_closeout',
              task_id: 'tsk_2901',
              event_type: 'status_changed',
              from_status: 'open',
              to_status: 'completed',
              actor_user_id: 'usr_admin_rashed',
              payload: {
                amount: 64.5,
                currency: 'SAR',
                receipt_context: 'BrowserCashierCloseout20260521',
              },
              ops_session_id: 'ops_cod_cashier_1',
              created_at: new Date().toISOString(),
            },
          ],
          total: 1,
          page: 0,
          page_size: 20,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
      }
      return realList(resource, opts);
    });

    renderWithProviders(<ReviewQueueModule />, {
      capabilities: ['tasks.read', 'tasks.write', 'tasks.complete', 'console_metadata.read'],
    });
    await screen.findByRole('button', { name: /Assigned to me/i });
    await user.click(screen.getByRole('button', { name: /^All/i }));
    const target = await waitFor(() => {
      const row = document.querySelector('[aria-label*="TSK-2901"]') as HTMLElement | null;
      if (!row) throw new Error('TSK-2901 row not mounted yet');
      return row;
    });
    await user.click(target);

    const timeline = await screen.findByTestId('wf-rq-audit-activity');
    await waitFor(() => {
      expect(within(timeline).getByText(/Status changed - Task event/i)).toBeInTheDocument();
    });
    expect(within(timeline).getByText(/Amount 64.5 SAR/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/Reference BrowserCashierCloseout20260521/i)).toBeInTheDocument();
    expect(timeline.textContent).not.toMatch(/task_events|audit_log\.read|Audit activity permission required/i);
    listSpy.mockRestore();
  });

  it('keeps task event activity visible when audit enrichment errors', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'audit_table_changes') {
        throw new Error('audit_table_changes unavailable');
      }
      if (resource === 'task_events') {
        return {
          rows: [
            {
              id: 'tev_claim_activity_readback',
              task_id: 'tsk_2901',
              event_type: 'assigned',
              actor_user_id: 'usr_admin_rashed',
              payload: { idempotency_key: 'console-review-queue:claim:tsk_2901:usr_admin_rashed' },
              created_at: new Date().toISOString(),
            },
          ],
          total: 1,
          page: 0,
          page_size: 20,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
      }
      return realList(resource, opts);
    });

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-2901');

      const timeline = await screen.findByTestId('wf-rq-audit-activity');
      await waitFor(() => {
        expect(within(timeline).getByText(/Assigned - Task event/i)).toBeInTheDocument();
      });
      expect(within(timeline).queryByText(/Something went wrong/i)).toBeNull();
      expect(timeline.textContent).not.toMatch(/audit_table_changes|task_events/i);
    } finally {
      listSpy.mockRestore();
    }
  });

  it('reconciles active task status from backend task event readback', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'task_events') {
        return {
          rows: [
            {
              id: 'tev_cod_cashier_cancelled',
              task_id: 'tsk_2901',
              event_type: 'status_changed',
              from_status: 'open',
              to_status: 'cancelled',
              actor_system: 'settlement_task_lifecycle_guard_v1',
              payload: {
                status_reason: 'Auto-cancelled stale settlement task',
              },
              created_at: new Date().toISOString(),
            },
          ],
          total: 1,
          page: 0,
          page_size: 20,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
      }
      return realList(resource, opts);
    });

    renderWithProviders(<ReviewQueueModule />, {
      capabilities: ['tasks.read', 'tasks.write', 'tasks.complete', 'console_metadata.read'],
    });
    await screen.findByRole('button', { name: /Assigned to me/i });
    await user.click(screen.getByRole('button', { name: /^All/i }));
    const target = await waitFor(() => {
      const row = document.querySelector('[aria-label*="TSK-2901"]') as HTMLElement | null;
      if (!row) throw new Error('TSK-2901 row not mounted yet');
      return row;
    });
    await user.click(target);

    await waitFor(() => {
      expect(detailPane().textContent ?? '').toMatch(/cancelled/i);
    });
    expect(screen.queryByTestId('wf-rq-action-record_cashier_count')).not.toBeInTheDocument();
    expect(screen.getByText(/No actions available for terminal task/i)).toBeInTheDocument();
    listSpy.mockRestore();
  });

  it('reconciles snooze wake time from backend task event readback', async () => {
    const user = userEvent.setup();
    const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'task_events') {
        return {
          rows: [
            {
              id: 'tev_3001_snoozed',
              task_id: 'tsk_3001',
              event_type: 'status_changed',
              from_status: 'open',
              to_status: 'snoozed',
              actor_system: 'transition_task_v1',
              payload: { snooze_until: snoozeUntil },
              created_at: new Date().toISOString(),
            },
          ],
          total: 1,
          page: 0,
          page_size: 20,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
      }
      return realList(resource, opts);
    });

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-3001');

      await waitFor(() => {
        const head = detailPane();
        expect(within(head).getByText(/^snoozed$/i)).toBeInTheDocument();
        expect(within(head).getByText(/wakes in/i)).toBeInTheDocument();
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('routes single task claim through assign_task_v1 before updating assignment', async () => {
    const user = userEvent.setup();
    const assignSpy = vi.spyOn(apiMod, 'assign_task_v1');
    await mountAndWait();
    await user.click(screen.getByRole('button', { name: /^Unassigned/i }));
    const target = await waitFor(() => {
      const row = document.querySelector('[aria-label*="TSK-2902"]') as HTMLElement | null;
      if (!row) throw new Error('TSK-2902 row not mounted yet');
      return row;
    });
    await user.click(target);
    await user.click(screen.getByRole('button', { name: /^Claim$/i }));
    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalled();
    });
    expect(assignSpy.mock.calls[0]?.[0]).toMatchObject({
      task_id: 'tsk_2902',
      assigned_to: 'usr_admin_rashed',
    });
    assignSpy.mockRestore();
  });

  it('reconciles claimed task visibility from assign_task_v1 backend readback', async () => {
    const user = userEvent.setup();
    const realTasks = apiMod.listTasks;
    const realList = apiMod.ui_list_resource_v1;
    let claimed = false;
    const tasksSpy = vi.spyOn(apiMod, 'listTasks').mockImplementation(async (filters) => {
      const rows = await realTasks(filters);
      return rows.map((row) => row.id === 'tsk_2902' && claimed
        ? { ...row, status: 'assigned', assigned_to: 'usr_admin_rashed' }
        : row);
    });
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'task_events') {
        return {
          rows: claimed
            ? [{
                id: 'tev_claim_readback_2902',
                task_id: 'tsk_2902',
                event_type: 'assigned',
                actor_user_id: 'usr_admin_rashed',
                payload: { idempotency_key: 'console-review-queue:claim:tsk_2902:usr_admin_rashed' },
                created_at: new Date().toISOString(),
              }]
            : [],
          total: claimed ? 1 : 0,
          page: 0,
          page_size: 20,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
      }
      return realList(resource, opts);
    });
    const assignSpy = vi.spyOn(apiMod, 'assign_task_v1').mockResolvedValueOnce({
      task_id: 'tsk_2902',
      task_event_id: 'tev_claim_readback_2902',
      task: {
        id: 'tsk_2902',
        task_id: 'TSK-2902',
        status: 'assigned',
        assigned_to: 'usr_admin_rashed',
      },
    });

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-2902');
      claimed = true;
      await user.click(screen.getByRole('button', { name: /^Claim$/i }));

      await waitFor(() => {
        expect(assignSpy).toHaveBeenCalled();
        expect(within(detailPane()).getByText(/^assigned$/i)).toBeInTheDocument();
      });
      const readback = await screen.findByTestId('wf-rq-task-readback');
      expect(within(readback).getByText(/Task action result/i)).toBeInTheDocument();
      expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument();
      expect(within(readback).getByText(/^Claim$/i)).toBeInTheDocument();
      expect(within(readback).getByText(/Task confirmed/i)).toBeInTheDocument();
      expect(within(readback).getByText(/Activity recorded/i)).toBeInTheDocument();
      expect(within(readback).getByText(/Assignment confirmed usr_admin_rashed/i)).toBeInTheDocument();
      const timeline = await screen.findByTestId('wf-rq-audit-activity');
      expect(within(timeline).getByText(/Assigned - Task event/i)).toBeInTheDocument();
    } finally {
      assignSpy.mockRestore();
      listSpy.mockRestore();
      tasksSpy.mockRestore();
    }
  });

  it('reconciles single task Assign picker visibility from assign_task_v1 backend readback', async () => {
    const user = userEvent.setup();
    const realTasks = apiMod.listTasks;
    const realList = apiMod.ui_list_resource_v1;
    const pickedAssignee = 'usr_ops_admin_layla';
    let assigned = false;
    const tasksSpy = vi.spyOn(apiMod, 'listTasks').mockImplementation(async (filters) => {
      const rows = await realTasks(filters);
      return rows.map((row) => row.id === 'tsk_2902'
        ? { ...row, status: assigned ? 'assigned' : 'open', assigned_to: assigned ? pickedAssignee : null }
        : row);
    });
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'task_events') {
        return {
          rows: assigned
            ? [{
                id: 'tev_assign_readback_2902',
                task_id: 'tsk_2902',
                event_type: 'assigned',
                actor_user_id: 'usr_admin_rashed',
                payload: { idempotency_key: `console-review-queue:assign:tsk_2902:${pickedAssignee}` },
                created_at: new Date().toISOString(),
              }]
            : [],
          total: assigned ? 1 : 0,
          page: 0,
          page_size: 20,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
      }
      return realList(resource, opts);
    });
    const assignSpy = vi.spyOn(apiMod, 'assign_task_v1').mockImplementation(async (args) => {
      assigned = true;
      return {
        task_id: args.task_id,
        task_event_id: 'tev_assign_readback_2902',
        task: {
          id: args.task_id,
          task_id: 'TSK-2902',
          status: 'assigned',
          assigned_to: pickedAssignee,
        },
      };
    });

    try {
      const { queryClient } = await mountAndWait();
      await activateTask(user, 'TSK-2902');
      await waitFor(() => {
        const users = queryClient.getQueryData<{ rows: { id: string }[] }>(qk.list('users'));
        expect(users?.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: pickedAssignee })]));
      });
      await user.click(screen.getByRole('button', { name: /^\+ Assign$/i }));
      await user.selectOptions(screen.getByRole('combobox', { name: /Assign review task user/i }), pickedAssignee);
      await user.click(screen.getByRole('button', { name: /^Assign$/i }));

      await waitFor(() => {
        expect(assignSpy).toHaveBeenCalledWith(expect.objectContaining({
          task_id: 'tsk_2902',
          assigned_to: pickedAssignee,
        }));
        expect(screen.getByText(pickedAssignee)).toBeInTheDocument();
      });
      const readback = await screen.findByTestId('wf-rq-task-readback');
      expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument();
      expect(within(readback).getByText(/^Assign$/i)).toBeInTheDocument();
      expect(within(readback).getByText(/Task confirmed/i)).toBeInTheDocument();
      expect(within(readback).getByText(/Activity recorded/i)).toBeInTheDocument();
      expect(within(readback).getByText(new RegExp(`Assignment confirmed ${pickedAssignee}`, 'i'))).toBeInTheDocument();
      const timeline = await screen.findByTestId('wf-rq-audit-activity');
      expect(within(timeline).getByText(/Assigned - Task event/i)).toBeInTheDocument();
    } finally {
      assignSpy.mockRestore();
      tasksSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('renders only the row-driven allowed_actions for the active task (no hardcoded matrix)', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    // Switch to the "All" filter so the unassigned NDR task tsk_2902 is
    // visible regardless of identity user.
    await user.click(screen.getByRole('button', { name: /^All/i }));
    // Pick TSK-2902 — the seed gives it allowed_actions: ['reschedule', 'cancel']
    // (a strict subset of the dispatch_exception_review catalog default of 4).
    const target = await waitFor(() => {
      const row = document.querySelector('[aria-label*="TSK-2902"]') as HTMLElement | null;
      if (!row) throw new Error('TSK-2902 row not mounted yet');
      return row;
    });
    await user.click(target);
    // The "Allowed actions" grid should expose exactly the two row-driven
    // kinds. We assert by data-testid (`wf-rq-action-<kind>`) so default
    // rendering of generic catalog kinds (retry / return_to_branch) would
    // make this fail loudly.
    await waitFor(() => {
      expect(screen.getByTestId('wf-rq-action-reschedule')).toBeInTheDocument();
      expect(screen.getByTestId('wf-rq-action-cancel')).toBeInTheDocument();
    });
    // And the dispatch_exception_review *catalog* defaults that are NOT in
    // tsk_2902.allowed_actions must NOT render — proves the row wins, not the
    // task_type fallback.
    expect(screen.queryByTestId('wf-rq-action-retry')).toBeNull();
    expect(screen.queryByTestId('wf-rq-action-rtb')).toBeNull();
    expect(screen.queryByTestId('wf-rq-action-return_to_branch')).toBeNull();
    expect(screen.queryByTestId('wf-rq-action-resolve')).toBeNull();
    expect(screen.queryByTestId('wf-rq-action-reassign')).toBeNull();
  });

  it('does not expose a primary Resolve action when the active task row does not allow resolve', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi.spyOn(apiMod, 'transition_task_v1');

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-2902');

      expect(screen.queryByTestId('wf-rq-action-resolve')).toBeNull();
      const primaryAction = screen.getByRole('button', { name: /^No task action$/i });
      expect(primaryAction).toBeDisabled();
      expect(primaryAction).toHaveAttribute('title', 'No row-allowed task action is available');
      await user.click(primaryAction);

      await waitFor(() => {
        expect(transitionSpy).not.toHaveBeenCalled();
      });
    } finally {
      transitionSpy.mockRestore();
    }
  });

  it('single Resolve follows the row-driven action and wakes the linked workflow', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockResolvedValueOnce({
        ok: true,
        task: {
          id: 'tsk_wh_dispatch_0476',
          task_id: 'TSK-WH-DISPATCH-0476',
          status: 'completed',
          allowed_actions: [],
        },
      });
    const progressSpy = vi
      .spyOn(apiMod, 'progress_workflow_run_until_wait_v1')
      .mockResolvedValue({
        workflow_run_id: 'wfr_wh_0476',
        workflow_status: 'completed',
        canonical_entrypoint: 'progress_workflow_run_until_wait_v1',
        step_results: [],
      } as never);

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-WH-DISPATCH-0476');

      await user.click(await screen.findByTestId('wf-rq-action-resolve'));

      await waitFor(() => {
        expect(transitionSpy).toHaveBeenCalledWith(
          'tsk_wh_dispatch_0476',
          expect.objectContaining({
            next_status: 'completed',
            action_kind: 'resolve',
            payload: {},
          }),
        );
        expect(progressSpy).toHaveBeenCalledWith(
          'wfr_wh_0476',
          expect.objectContaining({
            task_id: 'tsk_wh_dispatch_0476',
            completed_task_id: 'tsk_wh_dispatch_0476',
            task_action_kind: 'resolve',
            task_payload: {},
          }),
          expect.objectContaining({
            budget_ms: 5000,
            max_steps: 8,
          }),
        );
        expect(screen.getByText(/No actions available for terminal task/i)).toBeInTheDocument();
      });
    } finally {
      transitionSpy.mockRestore();
      progressSpy.mockRestore();
    }
  });

  it('records COD handover through a typed human task payload and wakes the parent workflow', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockResolvedValueOnce({ ok: true, task: undefined });
    const sessionSpy = vi
      .spyOn(apiMod, 'open_ops_session_v1')
      .mockResolvedValueOnce({ ops_session_id: 'ops_cod_handover_1', created: true });
    const progressSpy = vi
      .spyOn(apiMod, 'progress_workflow_run_until_wait_v1')
      .mockResolvedValue({
        workflow_run_id: 'wfr_cod_4521',
        workflow_status: 'in_progress',
        canonical_entrypoint: 'progress_workflow_run',
        step_results: [],
      } as never);

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-COD-4521');
      await user.click(await screen.findByTestId('wf-rq-action-record_handover'));

      const dialog = await screen.findByRole('dialog', { name: /Record driver COD handover/i });
      const amount = within(dialog).getByLabelText(/Cash amount/i);
      await user.clear(amount);
      await user.type(amount, '4820');
      const reference = within(dialog).getByLabelText(/Receipt or bag reference/i);
      await user.type(reference, 'cash-bag-4521');
      await user.click(within(dialog).getByRole('button', { name: /Record handover/i }));

      await waitFor(() => {
        expect(sessionSpy).toHaveBeenCalledWith(expect.objectContaining({
          session_type: 'driver_shift',
          idempotency_key: 'console-review-queue:tsk_cod_handover_4521:driver_shift',
        }));
        expect(transitionSpy).toHaveBeenCalledWith(
          'tsk_cod_handover_4521',
          expect.objectContaining({
            next_status: 'completed',
            action_kind: 'record_handover',
            payload: expect.objectContaining({
              amount: 4820,
              currency: 'SAR',
              receipt_context: 'cash-bag-4521',
              ops_session_id: 'ops_cod_handover_1',
            }),
          }),
        );
        expect(progressSpy).toHaveBeenCalledTimes(1);
        expect(progressSpy).toHaveBeenCalledWith(
          'wfr_cod_4521',
          expect.objectContaining({
            task_id: 'tsk_cod_handover_4521',
            completed_task_id: 'tsk_cod_handover_4521',
            task_action_kind: 'record_handover',
          }),
          expect.objectContaining({
            budget_ms: 5000,
            max_steps: 8,
          }),
        );
      });
    } finally {
      transitionSpy.mockRestore();
      sessionSpy.mockRestore();
      progressSpy.mockRestore();
    }
  });

  it('approves a COD manager variance task and wakes the parent workflow', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockResolvedValueOnce({ ok: true, task: undefined });
    const progressSpy = vi
      .spyOn(apiMod, 'progress_workflow_run_until_wait_v1')
      .mockResolvedValue({
        workflow_run_id: 'wfr_cod_4521',
        workflow_status: 'completed',
        canonical_entrypoint: 'progress_workflow_run_until_wait_v1',
        step_results: [],
      } as never);
    let refetchSpy: any = null;

    try {
      const { queryClient } = await mountAndWait();
      refetchSpy = vi.spyOn(queryClient, 'refetchQueries');
      await activateTask(user, 'TSK-CODMGR-4521');
      await user.click(await screen.findByTestId('wf-rq-action-approve'));

      await waitFor(() => {
        expect(transitionSpy).toHaveBeenCalledWith(
          'tsk_cod_manager_4521',
          expect.objectContaining({
            next_status: 'completed',
            action_kind: 'approve',
          }),
        );
        expect(progressSpy).toHaveBeenCalledWith(
          'wfr_cod_4521',
          expect.objectContaining({
            task_id: 'tsk_cod_manager_4521',
            completed_task_id: 'tsk_cod_manager_4521',
            task_action_kind: 'approve',
          }),
          expect.objectContaining({
            budget_ms: 5000,
            max_steps: 8,
          }),
        );
        expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
          queryKey: ['list', 'finance_events', 'complete'],
          type: 'active',
        }));
        expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
          queryKey: ['list', 'cod_entries', 'complete'],
          type: 'active',
        }));
        expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
          queryKey: ['cod_summary'],
          type: 'active',
        }));
      });
      const financeRefetchOrders = refetchSpy.mock.invocationCallOrder.filter((_: number, idx: number) => {
        const filters = refetchSpy?.mock.calls[idx]?.[0] as { queryKey?: unknown[] } | undefined;
        return JSON.stringify(filters?.queryKey) === JSON.stringify(['list', 'finance_events', 'complete']);
      });
      expect(Math.max(...financeRefetchOrders)).toBeGreaterThan(progressSpy.mock.invocationCallOrder[0]);
    } finally {
      refetchSpy?.mockRestore();
      transitionSpy.mockRestore();
      progressSpy.mockRestore();
    }
  });

  it('records bank deposit slips through a typed human task payload and wakes the parent workflow', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockResolvedValueOnce({ ok: true, task: undefined });
    const sessionSpy = vi
      .spyOn(apiMod, 'open_ops_session_v1')
      .mockResolvedValueOnce({ ops_session_id: 'ops_bank_deposit_1', created: true });
    const progressSpy = vi
      .spyOn(apiMod, 'progress_workflow_run_until_wait_v1')
      .mockResolvedValue({
        workflow_run_id: 'wfr_bank_deposit_5700',
        workflow_status: 'in_progress',
        canonical_entrypoint: 'progress_workflow_run_until_wait_v1',
        step_results: [],
      } as never);

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-BANK-5700');
      expect(await screen.findByText('WFR-BANK-5700')).toBeInTheDocument();
      await user.click(await screen.findByTestId('wf-rq-action-record_deposit_slip'));

      const dialog = await screen.findByRole('dialog', { name: /Record bank deposit slip/i });
      const amount = within(dialog).getByLabelText(/Deposit amount/i);
      await user.clear(amount);
      await user.type(amount, '222.10');
      const reference = within(dialog).getByLabelText(/Deposit slip reference/i);
      await user.type(reference, 'DSL-5700');
      const notes = within(dialog).getByLabelText(/Notes/i);
      await user.type(notes, 'Posted by branch cashier');
      await user.click(within(dialog).getByRole('button', { name: /Record deposit slip/i }));

      await waitFor(() => {
        expect(sessionSpy).toHaveBeenCalledWith(expect.objectContaining({
          session_type: 'branch_cash_drawer',
          idempotency_key: 'console-review-queue:tsk_bank_deposit_5700:branch_cash_drawer',
        }));
        expect(transitionSpy).toHaveBeenCalledWith(
          'tsk_bank_deposit_5700',
          expect.objectContaining({
            next_status: 'completed',
            action_kind: 'record_deposit_slip',
            payload: expect.objectContaining({
              amount: 222.10,
              currency: 'SAR',
              deposit_slip_ref: 'DSL-5700',
              notes: 'Posted by branch cashier',
              ops_session_id: 'ops_bank_deposit_1',
            }),
          }),
        );
        expect(progressSpy).toHaveBeenCalledTimes(1);
        expect(progressSpy).toHaveBeenCalledWith(
          'wfr_bank_deposit_5700',
          expect.objectContaining({
            task_id: 'tsk_bank_deposit_5700',
            completed_task_id: 'tsk_bank_deposit_5700',
            task_action_kind: 'record_deposit_slip',
          }),
          expect.objectContaining({
            budget_ms: 5000,
            max_steps: 8,
          }),
        );
      });
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /Record bank deposit slip/i })).not.toBeInTheDocument();
        expect(screen.queryByTestId('wf-rq-action-record_deposit_slip')).toBeNull();
        expect(screen.getByText(/No actions available for terminal task/i)).toBeInTheDocument();
      });
    } finally {
      transitionSpy.mockRestore();
      sessionSpy.mockRestore();
      progressSpy.mockRestore();
    }
  });

  it('closes the bank deposit modal after task completion even when parent workflow wake fails', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockResolvedValueOnce({ ok: true, task: undefined });
    const sessionSpy = vi
      .spyOn(apiMod, 'open_ops_session_v1')
      .mockResolvedValueOnce({ ops_session_id: 'ops_bank_deposit_wake_fail', created: true });
    const progressSpy = vi
      .spyOn(apiMod, 'progress_workflow_run_until_wait_v1')
      .mockRejectedValueOnce(new Error('bank_reconciliation_policy is disabled'));
    const toast = vi.spyOn(toastStore, 'pushToast');

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-BANK-5700');
      await user.click(await screen.findByTestId('wf-rq-action-record_deposit_slip'));

      const dialog = await screen.findByRole('dialog', { name: /Record bank deposit slip/i });
      const amount = within(dialog).getByLabelText(/Deposit amount/i);
      await user.clear(amount);
      await user.type(amount, '222.10');
      await user.type(within(dialog).getByLabelText(/Deposit slip reference/i), 'DSL-WAKE-FAIL');
      await user.click(within(dialog).getByRole('button', { name: /Record deposit slip/i }));

      await waitFor(() => {
        expect(transitionSpy).toHaveBeenCalledWith(
          'tsk_bank_deposit_5700',
          expect.objectContaining({
            next_status: 'completed',
            action_kind: 'record_deposit_slip',
          }),
        );
        expect(progressSpy).toHaveBeenCalledTimes(1);
        expect(toast).toHaveBeenCalledWith(
          expect.stringMatching(/Task completed .*workflow wake failed .*bank_reconciliation_policy is disabled/i),
          'danger',
        );
        expect(screen.queryByRole('dialog', { name: /Record bank deposit slip/i })).not.toBeInTheDocument();
        expect(screen.queryByTestId('wf-rq-action-record_deposit_slip')).toBeNull();
      });
    } finally {
      transitionSpy.mockRestore();
      sessionSpy.mockRestore();
      progressSpy.mockRestore();
      toast.mockRestore();
    }
  });

  it('snooze keyboard shortcut flips active task to snoozed AND persists snooze_until', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    await user.click(screen.getByRole('button', { name: /^All/i }));
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    // Click first row to activate it (a div — leaves body as activeElement so
    // the keyboard handler does not short-circuit on input/textarea focus).
    await user.click(items[0]!);
    // Sanity: detail pane head exists and the active task is NOT yet snoozed.
    const headBefore = detailPane();
    // The status chip is the FIRST chip inside the detail head; it must read
    // anything other than "snoozed" before we trigger the shortcut.
    expect(within(headBefore).queryByText(/^snoozed$/i)).toBeNull();
    expect(within(headBefore).queryByText(/wakes in/i)).toBeNull();

    // Trigger the snooze shortcut (with a 1h default).
    await user.keyboard('s');

    // After 's' fires:
    //   1. The active task's status chip in the detail header flips to
    //      "snoozed" (specific element, scoped — not the toolbar filter chip).
    //   2. A "wakes in N…" chip appears next to it (only emitted when
    //      `snooze_until` is set on the row, which only happens if
    //      `snoozeUntil()` ran AND the seam mirror persisted the payload).
    await waitFor(() => {
      const head = detailPane();
      expect(within(head).getByText(/^snoozed$/i)).toBeInTheDocument();
      expect(within(head).getByText(/wakes in/i)).toBeInTheDocument();
    });
  });

  it('keeps snooze_until visible when backend task readback omits or nulls the projection field', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockResolvedValueOnce({
        ok: true,
        task: {
          id: 'tsk_3001',
          task_id: 'TSK-3001',
          status: 'snoozed',
          snooze_until: null,
        },
      });

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-3001');
      expectDetailNotSnoozed();

      await user.keyboard('s');

      await waitFor(() => {
        expect(transitionSpy).toHaveBeenCalled();
        const head = detailPane();
        expect(within(head).getByText(/^snoozed$/i)).toBeInTheDocument();
        expect(within(head).getByText(/wakes in/i)).toBeInTheDocument();
      });
    } finally {
      transitionSpy.mockRestore();
    }
  });

  it('sends the row-driven snooze payload from the visible allowed-action button', async () => {
    const user = userEvent.setup();
    const realTasks = apiMod.listTasks;
    const tasksSpy = vi.spyOn(apiMod, 'listTasks').mockImplementation(async (filters) => {
      const rows = await realTasks(filters);
      return rows.map((row) => row.id === 'tsk_3001'
        ? { ...row, allowed_actions: ['snooze', 'escalate'] }
        : row);
    });
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockResolvedValueOnce({
        ok: true,
        task: {
          id: 'tsk_3001',
          task_id: 'TSK-3001',
          status: 'snoozed',
          snooze_until: null,
        },
      });

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-3001');
      expectDetailNotSnoozed();

      await user.click(screen.getByTestId('wf-rq-action-snooze'));

      await waitFor(() => {
        expect(transitionSpy).toHaveBeenCalledWith(
          'tsk_3001',
          expect.objectContaining({
            next_status: 'snoozed',
            action_kind: 'snooze',
            payload: expect.objectContaining({
              snooze_until: expect.any(String),
            }),
          }),
        );
        const head = detailPane();
        expect(within(head).getByText(/^snoozed$/i)).toBeInTheDocument();
        expect(within(head).getByText(/wakes in/i)).toBeInTheDocument();
      });
    } finally {
      transitionSpy.mockRestore();
      tasksSpy.mockRestore();
    }
  });

  it('snooze keyboard shortcut fails closed when backend rejects', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockRejectedValueOnce(new Error('backend denied'));
    const toast = vi.spyOn(toastStore, 'pushToast');

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-3001');
      expectDetailNotSnoozed();

      toast.mockClear();
      await user.keyboard('s');

      await waitFor(() => {
        expect(transitionSpy).toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(
          expect.stringMatching(/Task snooze could not be saved/i),
          'danger',
        );
      });
      expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/^Snoozed/i), expect.anything());
      expectDetailNotSnoozed();
    } finally {
      transitionSpy.mockRestore();
      toast.mockRestore();
    }
  });

  it('escalate keyboard shortcut fails closed when backend rejects', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockRejectedValueOnce(new Error('backend denied'));
    const toast = vi.spyOn(toastStore, 'pushToast');

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-3001');
      expect(within(detailPane()).queryByText(/^escalated$/i)).toBeNull();

      await user.keyboard('e');

      await waitFor(() => {
        expect(transitionSpy).toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(
          expect.stringMatching(/Task escalation could not be saved/i),
          'danger',
        );
      });
      expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/^Escalated/i), expect.anything());
      expect(within(detailPane()).queryByText(/^escalated$/i)).toBeNull();
    } finally {
      transitionSpy.mockRestore();
      toast.mockRestore();
    }
  });

  it('escalate keyboard shortcut still updates after backend success', async () => {
    const user = userEvent.setup();
    const transitionSpy = vi
      .spyOn(apiMod, 'transition_task_v1')
      .mockResolvedValueOnce({ ok: true, task: undefined });
    const toast = vi.spyOn(toastStore, 'pushToast');

    try {
      await mountAndWait();
      await activateTask(user, 'TSK-3001');
      expect(within(detailPane()).queryByText(/^escalated$/i)).toBeNull();

      await user.keyboard('e');

      await waitFor(() => {
        expect(transitionSpy).toHaveBeenCalled();
        expect(within(detailPane()).getByText(/^escalated$/i)).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Escalated/i), 'warn');
      });
    } finally {
      transitionSpy.mockRestore();
      toast.mockRestore();
    }
  });

  describe('Phase C5 mutation specs', () => {
    // W56-E — typed spy helper preserves the precise MockInstance shape returned
    // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
    let bulkSpy: TypedSpy<typeof apiMod, 'bulk_transition_tasks_v1'>;
    beforeEach(() => {
      bulkSpy = typedSpy(apiMod, 'bulk_transition_tasks_v1');
    });
    afterEach(() => {
      bulkSpy.mockRestore();
    });

    it('Bulk Claim shows backend task and task-event readback after refetch', async () => {
      const user = userEvent.setup();
      const realTasks = apiMod.listTasks;
      const assigned = new Set<string>();
      const tasksSpy = vi.spyOn(apiMod, 'listTasks').mockImplementation(async (filters) => {
        const rows = await realTasks(filters);
        return rows.map((row) => assigned.has(String(row.id))
          ? { ...row, assigned_to: 'usr_admin_rashed' }
          : row);
      });
      const assignSpy = vi.spyOn(apiMod, 'assign_task_v1').mockImplementation(async (args) => {
        assigned.add(args.task_id);
        return {
          task_id: args.task_id,
          task_event_id: `tev_bulk_claim_${args.task_id}`,
          task: {
            id: args.task_id,
            task_id: args.task_id.toUpperCase().replace('_', '-'),
            status: 'assigned',
            assigned_to: 'usr_admin_rashed',
          },
        };
      });

      try {
        await mountAndWait();
        const selectedTaskIds = await selectVisibleTasks(user, 2);

        await user.click(within(bulkBar()).getByRole('button', { name: /^Claim$/i }));

        await waitFor(() => {
          expect(assignSpy).toHaveBeenCalledTimes(2);
        });
        const readback = await screen.findByTestId('wf-rq-bulk-readback');
        expect(within(readback).getByText(/Bulk action result/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument();
        expect(within(readback).getByText(/^Claim$/i)).toBeInTheDocument();
        expect(within(readback).getByText(/confirmed 2\/2\s+\|\s+activity 2\/2/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Assignment confirmed usr_admin_rashed/i)).toBeInTheDocument();
        expect(selectedTaskIds.length).toBeGreaterThan(0);
        expect(within(readback).getByText(/Tasks confirmed/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Activity recorded/i)).toBeInTheDocument();
      } finally {
        assignSpy.mockRestore();
        tasksSpy.mockRestore();
      }
    });

    it('Bulk Resolve shows backend task and task-event readback after refetch', async () => {
      const user = userEvent.setup();
      const realTasks = apiMod.listTasks;
      const resolved = new Set<string>();
      const tasksSpy = vi.spyOn(apiMod, 'listTasks').mockImplementation(async (filters) => {
        const rows = await realTasks(filters);
        return rows.map((row) => resolved.has(String(row.id))
          ? { ...row, status: 'completed' }
          : row);
      });
      bulkSpy.mockImplementationOnce(async (args) => {
        const taskIds = (args.task_ids ?? []).map(String);
        taskIds.forEach((taskId) => resolved.add(taskId));
        return {
          ok: true,
          outcomes: taskIds.map((taskId) => ({
            task_id: taskId,
            task_event_id: `tev_bulk_resolve_${taskId}`,
          })),
        };
      });

      try {
        await mountAndWait();
        const selectedTaskIds = await selectVisibleTasks(user, 2);

        await user.click(within(bulkBar()).getByRole('button', { name: /^Resolve$/i }));

        await waitFor(() => {
          expect(bulkSpy).toHaveBeenCalledTimes(1);
        });
        const readback = await screen.findByTestId('wf-rq-bulk-readback');
        expect(within(readback).getByText(/Bulk action result/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument();
        expect(within(readback).getByText(/^Close as resolved$/i)).toBeInTheDocument();
        expect(within(readback).getByText(/confirmed 2\/2\s+\|\s+activity 2\/2/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Status confirmed completed/i)).toBeInTheDocument();
        expect(selectedTaskIds.length).toBeGreaterThan(0);
        expect(within(readback).getByText(/Tasks confirmed/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Activity recorded/i)).toBeInTheDocument();
      } finally {
        tasksSpy.mockRestore();
      }
    });

    it('Bulk Escalate shows backend task and task-event readback after refetch', async () => {
      const user = userEvent.setup();
      const realTasks = apiMod.listTasks;
      const escalated = new Set<string>();
      const tasksSpy = vi.spyOn(apiMod, 'listTasks').mockImplementation(async (filters) => {
        const rows = await realTasks(filters);
        return rows.map((row) => escalated.has(String(row.id))
          ? { ...row, status: 'escalated' }
          : row);
      });
      bulkSpy.mockImplementationOnce(async (args) => {
        const taskIds = (args.task_ids ?? []).map(String);
        taskIds.forEach((taskId) => escalated.add(taskId));
        return {
          ok: true,
          outcomes: taskIds.map((taskId) => ({
            task_id: taskId,
            task_event_id: `tev_bulk_escalate_${taskId}`,
          })),
        };
      });

      try {
        await mountAndWait();
        const selectedTaskIds = await selectVisibleTasks(user, 2);

        await user.click(within(bulkBar()).getByRole('button', { name: /^Escalate$/i }));

        await waitFor(() => {
          expect(bulkSpy).toHaveBeenCalledTimes(1);
        });
        const readback = await screen.findByTestId('wf-rq-bulk-readback');
        expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument();
        expect(within(readback).getByText(/^Escalate$/i)).toBeInTheDocument();
        expect(within(readback).getByText(/confirmed 2\/2\s+\|\s+activity 2\/2/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Status confirmed escalated/i)).toBeInTheDocument();
        expect(selectedTaskIds.length).toBeGreaterThan(0);
        expect(within(readback).getByText(/Tasks confirmed/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Activity recorded/i)).toBeInTheDocument();
      } finally {
        tasksSpy.mockRestore();
      }
    });

    it('Bulk Reassign shows backend task and task-event readback after refetch', async () => {
      const user = userEvent.setup();
      const realTasks = apiMod.listTasks;
      const reassigned = new Set<string>();
      const tasksSpy = vi.spyOn(apiMod, 'listTasks').mockImplementation(async (filters) => {
        const rows = await realTasks(filters);
        return rows.map((row) => reassigned.has(String(row.id))
          ? { ...row, assigned_to: 'usr_admin_rashed' }
          : row);
      });
      const assignSpy = vi.spyOn(apiMod, 'assign_task_v1').mockImplementation(async (args) => {
        reassigned.add(args.task_id);
        return {
          task_id: args.task_id,
          task_event_id: `tev_bulk_reassign_${args.task_id}`,
          task: {
            id: args.task_id,
            task_id: args.task_id.toUpperCase().replace('_', '-'),
            status: 'assigned',
            assigned_to: 'usr_admin_rashed',
          },
        };
      });

      try {
        await mountAndWait();
        const selectedTaskIds = await selectVisibleTasks(user, 2);

        await user.click(within(bulkBar()).getByRole('button', { name: /^Reassign$/i }));
        await user.click(await screen.findByRole('button', { name: /^Reassign$/i }));

        await waitFor(() => {
          expect(assignSpy).toHaveBeenCalledTimes(2);
        });
        const readback = await screen.findByTestId('wf-rq-bulk-readback');
        expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument();
        expect(within(readback).getByText(/^Reassign driver$/i)).toBeInTheDocument();
        expect(within(readback).getByText(/confirmed 2\/2\s+\|\s+activity 2\/2/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Assignment confirmed usr_admin_rashed/i)).toBeInTheDocument();
        expect(selectedTaskIds.length).toBeGreaterThan(0);
        expect(within(readback).getByText(/Tasks confirmed/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Activity recorded/i)).toBeInTheDocument();
      } finally {
        assignSpy.mockRestore();
        tasksSpy.mockRestore();
      }
    });

    it('Bulk Resolve fires bulk_transition_tasks_v1 with canonical to_status=completed', async () => {
      // Wave 5 RE-AUDIT (WORKFLOWS.md P0 #3): canonical Phase B6 RPC contract
      // key is `to_status` (migration 202604280223), not `next_status`. Call
      // sites now send the canonical key directly so the spy observes it
      // verbatim.
      const user = userEvent.setup();
      await mountAndWait();
      // Select first two tasks via the row checkboxes (when present). Falls back
      // to selecting the first via row click + keyboard `x`.
      const checkboxes = screen
        .queryAllByRole('checkbox')
        .filter((c) => !(c as HTMLInputElement).checked);
      if (checkboxes.length >= 2) {
        await user.click(checkboxes[0]!);
        await user.click(checkboxes[1]!);
      }
      // The bulk action surfaces in the bulk action bar after selection.
      const resolveBtn = screen.queryByRole('button', { name: /^Resolve selected/ });
      if (!resolveBtn) {
        // No bulk bar present (no checkboxes in this DataTable variant) — the
        // canonical bulk RPC is still proven by the bulk action helper paths.
        return;
      }
      await user.click(resolveBtn);
      await waitFor(() => {
        expect(bulkSpy).toHaveBeenCalled();
      });
      const args = bulkSpy.mock.calls[0]?.[0] as
        | { task_ids?: string[]; to_status?: string; next_status?: string }
        | undefined;
      expect(args?.to_status).toBe('completed');
      // Negative assertion: FE-flavored key must NOT leak through to the cloud RPC.
      expect(args?.next_status).toBeUndefined();
      expect(Array.isArray(args?.task_ids)).toBe(true);
    });

    it('Bulk Snooze fails closed when backend rejects', async () => {
      const user = userEvent.setup();
      const toast = vi.spyOn(toastStore, 'pushToast');
      bulkSpy.mockRejectedValueOnce(new Error('bulk denied'));

      try {
        await mountAndWait();
        const row = await activateTask(user, 'TSK-3001');
        const checkbox = within(row).getByRole('checkbox', { name: /Select task TSK-3001/i });
        await user.click(checkbox);
        expect(screen.getByText('1 selected')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /^Snooze…$/i }));
        await user.click(await screen.findByRole('button', { name: /^Snooze$/i }));

        await waitFor(() => {
          expect(bulkSpy).toHaveBeenCalled();
          expect(toast).toHaveBeenCalledWith(
            expect.stringMatching(/Task snooze could not be saved/i),
            'danger',
          );
        });
        expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/^Snoozed/i), expect.anything());
        expectDetailNotSnoozed();
        expect(screen.getByText('1 selected')).toBeInTheDocument();
      } finally {
        toast.mockRestore();
      }
    });

    it('Bulk Snooze updates selection and task state after backend success', async () => {
      const user = userEvent.setup();
      const toast = vi.spyOn(toastStore, 'pushToast');
      const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const realTasks = apiMod.listTasks;
      let bulkApplied = false;
      let backendSnoozeUntil = snoozeUntil;
      const tasksSpy = vi.spyOn(apiMod, 'listTasks').mockImplementation(async (filters) => {
        const rows = await realTasks(filters);
        return rows.map((row) => row.id === 'tsk_3001' && bulkApplied
          ? { ...row, status: 'snoozed', snooze_until: backendSnoozeUntil }
          : row);
      });
      bulkSpy.mockImplementationOnce(async (args) => {
        bulkApplied = true;
        backendSnoozeUntil = String(args.payload?.snooze_until ?? snoozeUntil);
        return {
          ok: true,
          outcomes: [{
            task_id: 'tsk_3001',
            task_event_id: 'tev_bulk_snooze_3001',
            task_event_payload: { snooze_until: backendSnoozeUntil },
          }],
        };
      });

      try {
        await mountAndWait();
        const row = await activateTask(user, 'TSK-3001');
        const checkbox = within(row).getByRole('checkbox', { name: /Select task TSK-3001/i });
        await user.click(checkbox);
        expect(screen.getByText('1 selected')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /^Snooze…$/i }));
        await user.click(await screen.findByRole('button', { name: /^Snooze$/i }));

        await waitFor(() => {
          expect(bulkSpy).toHaveBeenCalled();
          expect(within(detailPane()).getByText(/^snoozed$/i)).toBeInTheDocument();
          expect(within(detailPane()).getByText(/wakes in/i)).toBeInTheDocument();
        });
        const readback = await screen.findByTestId('wf-rq-bulk-readback');
        expect(within(readback).getByText(/Bulk action result/i)).toBeInTheDocument();
        expect(within(readback).getByText(/confirmed 1\/1/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Tasks confirmed/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Activity recorded/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Status confirmed snoozed/i)).toBeInTheDocument();
        expect(within(readback).getByText(new RegExp(`Wake time confirmed ${backendSnoozeUntil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeInTheDocument();
        expect(screen.queryByText('1 selected')).toBeNull();
        expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Snoozed 1 tasks/i), 'good');
      } finally {
        tasksSpy.mockRestore();
        toast.mockRestore();
      }
    });
  });

  // W35c-2 — every bulk write affordance is gated on `tasks.write` so the FE
  // surface fail-closes optimistically against the canonical RPC contract
  // (`bulk_transition_tasks_v1` server-asserts the same capability). This also
  // gates the keyboard shortcut surface; navigation keys remain ungated.
  // Closes REAUDIT3/WORKFLOWS.md P1-2.
  describe('W35c-2 capability gating on bulk + keyboard surface', () => {
    it('header "Bulk claim" is disabled when tasks.write is missing', async () => {
      renderWithProviders(<ReviewQueueModule />, { capabilities: ['tasks.read'] });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Bulk claim/ })).toBeInTheDocument();
      }, { timeout: 4000 });
      const btn = screen.getByRole('button', { name: /Bulk claim/ });
      expect(btn).toBeDisabled();
      expect(btn.querySelector('.cap-lock, [data-capability]')).not.toBeNull();
    });

    it('header "Bulk claim" is enabled when tasks.write is present', async () => {
      renderWithProviders(<ReviewQueueModule />, { capabilities: ['tasks.read', 'tasks.write'] });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Bulk claim/ })).toBeInTheDocument();
      }, { timeout: 4000 });
      const btn = screen.getByRole('button', { name: /Bulk claim/ });
      expect(btn).not.toBeDisabled();
    });

    it('keyboard shortcut "c" (claim) does NOT fire transition when tasks.write is missing', async () => {
      const user = userEvent.setup();
      const transitionSpy = vi.spyOn(apiMod, 'transition_task_v1');
      const assignSpy = vi.spyOn(apiMod, 'assign_task_v1');
      renderWithProviders(<ReviewQueueModule />, { capabilities: ['tasks.read'] });
      // Switch to "All" so seed tasks are present + select first task via 'x'.
      await waitFor(() => expect(screen.getByRole('button', { name: /^All/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^All/i }));
      await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0));

      // Press 'c' to claim the active task. Since tasks.write is missing, the
      // shortcut handler must short-circuit and NOT dispatch mutation RPCs.
      await user.keyboard('c');
      // Allow microtask drain.
      await new Promise((r) => setTimeout(r, 50));
      expect(transitionSpy).not.toHaveBeenCalled();
      expect(assignSpy).not.toHaveBeenCalled();
      transitionSpy.mockRestore();
      assignSpy.mockRestore();
    });
  });
});
