// exceptions.ndr-recommend.test.tsx — covers CLAIM-OPERATIONS-WIRING (Phase C1)
// canonical wiring of:
//   1. resolve_ndr_branch_next_action_v1 RPC -> per-row "Recommended" chip
//   2. task_events read seam moved from api.seed.taskEvents to
//      complete ui_list_resource_v1-backed reads (AttemptsTab + TaskEventsTab)
//
// Asserted behavior:
//   1. Module mount fires `resolve_ndr_branch_next_action_v1` for tasks whose
//      subject carries a recognizable exception reason (refused / address /
//      cod discrepancy / failed delivery).
//   2. Opening a task drawer + clicking the Attempts tab fires
//      the complete list facade for task_events with task_id filter.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ExceptionsModule } from '@/modules/operate/exceptions';
import * as ds from '@/lib/data-source';
import {
  exceptionReturnCompleteResource,
  exceptionReturnOperatorIdentity,
  exceptionTaskRows,
} from './exceptions-return.fixtures';

const NDR_SPY = vi.spyOn(ds, 'resolve_ndr_branch_next_action_v1');
const LIST_SPY = vi.spyOn(ds, 'ui_list_resource_complete');
const LIST_TASKS_SPY = vi.spyOn(ds, 'listTasks');
const COMPLETE_RESOURCE = ds.ui_list_resource_complete;

beforeEach(() => {
  NDR_SPY.mockClear();
  NDR_SPY.mockResolvedValue('reschedule');
  LIST_SPY.mockClear();
  LIST_SPY.mockImplementation((resource, opts) =>
    exceptionReturnCompleteResource(resource, opts, COMPLETE_RESOURCE),
  );
  LIST_TASKS_SPY.mockClear();
  LIST_TASKS_SPY.mockResolvedValue(exceptionTaskRows);
});

describe('ExceptionsModule · NDR recommendation + task_events wiring', () => {
  it('fires resolve_ndr_branch_next_action_v1 for rows with a known reason', async () => {
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    await waitFor(() => {
      expect(NDR_SPY).toHaveBeenCalled();
    });
    // First call args carry the canonical organization_id + reason fields.
    const firstArgs = NDR_SPY.mock.calls[0]?.[0] as
      | { organization_id?: string; dispatch_exception_reason?: string }
      | undefined;
    expect(firstArgs?.organization_id).toBeTruthy();
    expect(firstArgs?.dispatch_exception_reason).toBeTruthy();
  });

  it('renders a Recommended chip for at least one row', async () => {
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll('.dt__table tbody tr'));
      expect(rows.some((row) => /TSK-NDR-FIXTURE/.test(row.textContent ?? ''))).toBe(true);
    });
    // Wait for an NDR recommendation chip to render — value is one of
    // { reschedule | customer_pickup | cancel | retry | hold }.
    await waitFor(() => {
      const chips = Array.from(document.querySelectorAll('.dt__table tbody .chip'))
        .map((c) => (c.textContent ?? '').trim());
      const hasRec = chips.some((t) => /reschedule|customer_pickup|cancel|retry|hold/.test(t));
      expect(hasRec).toBe(true);
    });
  });

  it('Attempts tab fires the complete list facade for task_events with task_id filter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity });
    await waitFor(() => {
      expect(document.body.textContent).toContain('TSK-NDR-FIXTURE');
    });
    // Open the first task drawer.
    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    // Click the Attempts tab (label "Attempts").
    const tabBtn = Array.from(document.querySelectorAll('.drawer button, .drawer [role="tab"]'))
      .find((el) => /Attempts/i.test((el.textContent ?? '').trim()));
    expect(tabBtn).toBeTruthy();
    await user.click(tabBtn as HTMLElement);
    await waitFor(() => {
      const calls = LIST_SPY.mock.calls.map((c) => c[0]);
      expect(calls).toContain('task_events');
    });
    // task_id filter is forwarded.
    const teCall = LIST_SPY.mock.calls.find((c) => (c as unknown[])[0] === 'task_events');
    expect(teCall).toBeTruthy();
    const opts = (teCall as unknown[])[1] as { filter?: { task_id?: string } } | undefined;
    expect(opts?.filter?.task_id).toBeTruthy();
  });
});
