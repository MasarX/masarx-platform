// amend-cancel.metadata.test.tsx — covers CLAIM-OPERATIONS-WIRING (Phase C1)
// canonical seam swap from `task.subject` substring inference to
// `task.metadata.requested_op` reads.
//
// Asserted behavior:
//   1. The Operation column for a seeded amend task (TSK-3001) resolves the
//      canonical metadata.requested_op to its operator-facing lookup label.
//   2. Drawer footer "Apply via workflow engine" forwards the canonical
//      metadata.requested_payload as the RPC payload (NOT empty {}).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { AmendCancelModule } from '@/modules/operate/amend-cancel';
import { AMEND_REVIEW_TASKS, amendOpLookup, taskActionKindLookup } from '@/modules/operate/amend-cancel.fixtures';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';

const ORIGINAL_LOOKUP_ROW = api.lookupRow;
const LIST_TASKS_SPY = vi.spyOn(api, 'listTasks');
const AMEND_SPY = vi.spyOn(ds, 'shipment_amend_cancel_v1');

beforeEach(() => {
  vi.spyOn(api, 'lookupRow').mockImplementation((category, value) => {
    if (category === 'shipment_amend_op') return amendOpLookup(value) as ReturnType<typeof api.lookupRow>;
    if (category === 'task_action_kind') return taskActionKindLookup(value) as ReturnType<typeof api.lookupRow>;
    return ORIGINAL_LOOKUP_ROW(category, value);
  });
  LIST_TASKS_SPY.mockClear();
  LIST_TASKS_SPY.mockResolvedValue(AMEND_REVIEW_TASKS);
  AMEND_SPY.mockClear();
});

describe('AmendCancelModule · canonical metadata reads (CLAIM-OPERATIONS-WIRING)', () => {
  it('renders the Operation chip from metadata.requested_op', async () => {
    renderWithProviders(<AmendCancelModule />, { capabilities: ['all'] });
    // Seeded TSK-3001 carries metadata.requested_op = 'amend_address'.
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll('.dt__table tbody tr'));
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
    // The chip should render the configured operator-facing label, not the raw key.
    const chips = Array.from(document.querySelectorAll('.dt__table tbody .chip'));
    const chipTexts = chips.map((c) => (c.textContent ?? '').trim());
    expect(chipTexts).toContain('Amend address');
    expect(chipTexts).not.toContain('amend_address');
  });

  it('renders the Requested-by from metadata.requested_by', async () => {
    renderWithProviders(<AmendCancelModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll('.dt__table tbody tr'));
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
    // Seeded TSK-3001 carries metadata.requested_by = 'recipient'.
    const cells = Array.from(document.querySelectorAll('.dt__table tbody td'));
    const text = cells.map((c) => (c.textContent ?? '').trim()).join('|');
    expect(text).toMatch(/recipient/);
  });

  it('Apply forwards metadata.requested_payload to shipment_amend_cancel_v1', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AmendCancelModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll('.dt__table tbody tr'));
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
    // Click the first row to open the drawer.
    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    // Drawer body fires its own dry-run on mount; clear the spy before Apply.
    await waitFor(() => {
      expect(AMEND_SPY).toHaveBeenCalled();
    });
    AMEND_SPY.mockClear();
    // Click the apply action in the footer.
    const footer = document.querySelector('.drawer__footer')!;
    const applyBtn = Array.from(footer.querySelectorAll('button')).find((b) =>
      /Apply change/.test(b.textContent ?? ''),
    );
    expect(applyBtn).toBeTruthy();
    await user.click(applyBtn as HTMLElement);
    await waitFor(() => {
      expect(AMEND_SPY).toHaveBeenCalled();
    });
    // Payload (3rd arg) must equal the canonical metadata.requested_payload
    // seeded for TSK-3001 (`{ destination_city: 'Riyadh' }`), NOT empty {}.
    const [, op, payload] = AMEND_SPY.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(op).toBe('address');
    expect(payload).toMatchObject({ destination_city: 'Riyadh' });
  });
});
