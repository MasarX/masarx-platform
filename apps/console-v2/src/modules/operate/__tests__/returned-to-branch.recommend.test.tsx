// returned-to-branch.recommend.test.tsx — covers CLAIM-OPERATIONS-WIRING
// (Phase C1) recommendation chip per row sourced from
// `resolve_ndr_branch_next_action_v1`.
//
// Asserted behavior:
//   1. Module mount fires `resolve_ndr_branch_next_action_v1` for visible
//      returned-to-branch rows (with organization_id forwarded from scope).
//   2. The chip text reflects one of the canonical action labels.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { ReturnedToBranchModule } from '@/modules/operate/returned-to-branch';
import * as ds from '@/lib/data-source';
import {
  exceptionReturnOperatorIdentity,
  returnedToBranchRows,
} from './exceptions-return.fixtures';

const NDR_SPY = vi.spyOn(ds, 'resolve_ndr_branch_next_action_v1');
const RETURN_LIST_SPY = vi.spyOn(ds.return_to_branch_shipments_v1, 'list');

beforeEach(() => {
  NDR_SPY.mockClear();
  NDR_SPY.mockResolvedValue('reschedule');
  RETURN_LIST_SPY.mockClear();
  RETURN_LIST_SPY.mockResolvedValue(returnedToBranchRows);
});

describe('ReturnedToBranchModule · canonical NDR recommendation (Phase C1)', () => {
  it('fires resolve_ndr_branch_next_action_v1 for visible rows', async () => {
    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity });
    await waitFor(() => {
      expect(NDR_SPY).toHaveBeenCalled();
    });
    const args = NDR_SPY.mock.calls[0]?.[0] as
      | { organization_id?: string; shipment_action_type?: string; service_type?: string }
      | undefined;
    expect(args?.organization_id).toBeTruthy();
    // The shipment_action_type is the canonical seam used for return-to-branch.
    expect(args?.shipment_action_type).toBe('return_to_branch_intake');
  });

  it('renders a recommended chip with one of the canonical labels', async () => {
    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity });
    await waitFor(() => {
      const chips = Array.from(document.querySelectorAll('.dt__table tbody .chip'))
        .map((c) => (c.textContent ?? '').trim());
      const hasRec = chips.some((t) => /reschedule|customer_pickup|cancel|retry|hold/.test(t));
      expect(hasRec).toBe(true);
    });
  });
});
