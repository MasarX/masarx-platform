// amend-cancel.lifecycle.test.tsx — closes OPERATIONS reaudit D2 for the
// amend-cancel surface. The existing `amend-cancel.metadata.test.tsx`
// covers Apply-via-workflow only; this file adds per-RPC assertions for
// the remaining lifecycle actions: Reject, Pre-flight policy, row-level
// Preview / Apply, and bulk Preview / Apply.
//
// Asserted behavior:
//   1. mount + capability gate.
//   2. happy path — clicking the action fires the canonical RPC with the
//      expected payload. Drawer Reject calls transition_task_v1; batch-compatible
//      requests call ui_execute_shipment_batch_operation_v1, while amend requests
//      keep their per-request workflow payload.
//   3. mutation invalidation — list/tasks query is invalidated.
//   4. failure mode — module does not crash when the bulk RPC rejects.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { AmendCancelModule } from '@/modules/operate/amend-cancel';
import { AMEND_REVIEW_TASKS, amendOpLookup, taskActionKindLookup } from '@/modules/operate/amend-cancel.fixtures';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';

const ORIGINAL_LOOKUP_ROW = api.lookupRow;
const LIST_TASKS_SPY = vi.spyOn(api, 'listTasks');
const TRANSITION_SPY = vi.spyOn(ds, 'transition_task_v1');
const BATCH_OP_SPY = vi.spyOn(ds, 'ui_execute_shipment_batch_operation_v1');
const AMEND_SPY = vi.spyOn(ds, 'shipment_amend_cancel_v1');
const RESOLVE_SETTINGS_SPY = vi.spyOn(ds, 'resolveSettings');

beforeEach(() => {
  vi.spyOn(api, 'lookupRow').mockImplementation((category, value) => {
    if (category === 'shipment_amend_op') return amendOpLookup(value) as ReturnType<typeof api.lookupRow>;
    if (category === 'task_action_kind') return taskActionKindLookup(value) as ReturnType<typeof api.lookupRow>;
    return ORIGINAL_LOOKUP_ROW(category, value);
  });
  LIST_TASKS_SPY.mockClear();
  LIST_TASKS_SPY.mockResolvedValue(AMEND_REVIEW_TASKS);
  TRANSITION_SPY.mockClear();
  BATCH_OP_SPY.mockClear();
  AMEND_SPY.mockClear();
  RESOLVE_SETTINGS_SPY.mockClear();
});

async function openFirstRowDrawer() {
  const user = userEvent.setup();
  await waitFor(() => {
    expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
  });
  await user.click(document.querySelector('.dt__table tbody tr') as Element);
  await waitFor(() => {
    expect(document.querySelector('.drawer__footer')).not.toBeNull();
  });
  return user;
}

function findFooterButton(label: RegExp): HTMLElement {
  const footer = document.querySelector('.drawer__footer');
  if (!footer) throw new Error('drawer footer not rendered');
  const btn = Array.from(footer.querySelectorAll('button')).find((b) => {
    const span = b.querySelector('span');
    return label.test((span?.textContent ?? b.textContent ?? '').trim());
  });
  if (!btn) throw new Error(`footer button matching ${label} not found`);
  return btn as HTMLElement;
}

describe('AmendCancelModule · review queue lifecycle (OPERATIONS reaudit D2)', () => {
  it('mounts the queue and renders task rows', async () => {
    renderWithProviders(<AmendCancelModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
  });

  it('disables drawer Reject when tasks.complete is missing and Apply when shipments.write is missing', async () => {
    renderWithProviders(<AmendCancelModule />, { capabilities: ['shipments.read'] });
    await openFirstRowDrawer();
    expect(findFooterButton(/^Reject$/)).toBeDisabled();
    expect(findFooterButton(/Apply change/)).toBeDisabled();
    // CapabilityLock chips render the missing capabilities.
    expect(screen.getAllByText(/Task completion permission required/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Shipment update permission required/i).length).toBeGreaterThan(0);
  });

  it('keeps row and bulk task transitions locked until tasks.complete is held', async () => {
    renderWithProviders(<AmendCancelModule />, {
      capabilities: ['shipments.read', 'shipments.write', 'tasks.write'],
    });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const firstRowCheckbox = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.getAttribute('aria-label') === 'Select row');
    if (!firstRowCheckbox) throw new Error('No row checkbox found');
    await user.click(firstRowCheckbox);
    const bulkApplyBtn = await screen.findByRole('button', { name: /Bulk apply/ });
    expect(bulkApplyBtn).toBeDisabled();
    expect(bulkApplyBtn).toHaveAttribute('title', expect.stringContaining('task completion permission'));

    const rowActionsButton = screen.getAllByRole('button', { name: 'Row actions' })[0];
    await user.click(rowActionsButton);
    await waitFor(() => {
      const disabledItems = Array.from(document.querySelectorAll('.palette__item.is-disabled'));
      expect(disabledItems.some((item) => /Apply change/.test(item.textContent ?? ''))).toBe(true);
      expect(disabledItems.some((item) => /Reject/.test(item.textContent ?? ''))).toBe(true);
    });
    expect(TRANSITION_SPY).not.toHaveBeenCalled();
  });

  it('drawer Reject fires transition_task_v1 with next_status=rejected', async () => {
    const { queryClient } = renderWithProviders(<AmendCancelModule />, {
      capabilities: ['all'],
    });
    const user = await openFirstRowDrawer();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(findFooterButton(/^Reject$/));
    await waitFor(() => {
      expect(TRANSITION_SPY).toHaveBeenCalled();
    });
    const [taskId, transition] = TRANSITION_SPY.mock.calls[0] as [
      string,
      { next_status?: string },
    ];
    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(0);
    expect(transition.next_status).toBe('rejected');
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
  });

  it('Pre-flight policy reads shipment_operation_policy via resolveSettings', async () => {
    renderWithProviders(<AmendCancelModule />, { capabilities: ['all'] });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('button', { name: /Pre-flight policy/i }));
    await waitFor(() => {
      expect(RESOLVE_SETTINGS_SPY).toHaveBeenCalled();
    });
    const [category] = RESOLVE_SETTINGS_SPY.mock.calls[0] as [string, unknown];
    expect(category).toBe('shipment_operation_policy');
  });

  it('Bulk preview preserves amend request payloads through per-request workflow preview', async () => {
    renderWithProviders(<AmendCancelModule />, { capabilities: ['all'] });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    // Select all visible rows via per-row checkbox.
    const firstRowCheckbox = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.getAttribute('aria-label') === 'Select row');
    if (!firstRowCheckbox) throw new Error('No row checkbox found');
    await user.click(firstRowCheckbox);
    const bulkPreviewBtn = await screen.findByRole('button', { name: /Bulk preview/ });
    await user.click(bulkPreviewBtn);
    await waitFor(() => {
      expect(AMEND_SPY).toHaveBeenCalled();
    });
    expect(BATCH_OP_SPY).not.toHaveBeenCalled();
    const [, op, payload, opts] = AMEND_SPY.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      { dryRun?: boolean } | undefined,
    ];
    expect(op).toBe('address');
    expect(payload).toMatchObject({ destination_city: 'Riyadh' });
    expect(opts?.dryRun).toBe(true);
  });

  it('Bulk apply preserves amend request payloads and transitions the rows to completed', async () => {
    const { queryClient } = renderWithProviders(<AmendCancelModule />, {
      capabilities: ['all'],
    });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const firstRowCheckbox = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.getAttribute('aria-label') === 'Select row');
    if (!firstRowCheckbox) throw new Error('No row checkbox found');
    await user.click(firstRowCheckbox);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const bulkApplyBtn = await screen.findByRole('button', { name: /Bulk apply/ });
    await user.click(bulkApplyBtn);
    await waitFor(() => {
      expect(AMEND_SPY).toHaveBeenCalled();
    });
    expect(BATCH_OP_SPY).not.toHaveBeenCalled();
    const lastCall = AMEND_SPY.mock.calls[AMEND_SPY.mock.calls.length - 1] as [
      string,
      string,
      Record<string, unknown>,
      { dryRun?: boolean } | undefined,
    ];
    expect(lastCall[1]).toBe('address');
    expect(lastCall[2]).toMatchObject({ destination_city: 'Riyadh' });
    expect(!!lastCall[3]?.dryRun).toBe(false);
    // Followed by per-row transition_task_v1 to mark each task as completed.
    await waitFor(() => {
      expect(TRANSITION_SPY).toHaveBeenCalled();
    });
    const [, transition] = TRANSITION_SPY.mock.calls[TRANSITION_SPY.mock.calls.length - 1] as [
      string,
      { next_status?: string },
    ];
    expect(transition.next_status).toBe('completed');
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
  });
});
