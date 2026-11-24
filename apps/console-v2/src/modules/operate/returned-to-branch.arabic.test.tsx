// returned-to-branch.arabic.test.tsx: the returned-to-branch queue renders its own copy in Arabic; shipment values stay as data (#302).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as ds from '@/lib/data-source';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/operate-queues';
import { ReturnedToBranchModule } from '@/modules/operate/returned-to-branch';
import {
  exceptionReturnListResource,
  exceptionReturnOperatorIdentity,
  returnedToBranchRows,
} from './__tests__/exceptions-return.fixtures';

const LIST_RESOURCE = ds.ui_list_resource_v1;
// The scope pill is a shared component outside this slice, so only module chips are checked in the pills row.
const chrome = () => [
  ...document.querySelectorAll('.page-header__title-block, .page-header__actions, .page-header__pills .chip, .dt__table thead'),
];

describe('ReturnedToBranchModule in Arabic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Same data seams as the trunk lifecycle test.
    vi.spyOn(ds, 'resolve_ndr_branch_next_action_v1').mockResolvedValue('reschedule');
    vi.spyOn(ds.return_to_branch_shipments_v1, 'list').mockResolvedValue(returnedToBranchRows);
    vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation((resource, opts) =>
      exceptionReturnListResource(resource, opts, LIST_RESOURCE),
    );
  });

  it('renders the header, pills, actions, table headers and intake modal title in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReturnedToBranchModule />, { identity: exceptionReturnOperatorIdentity, locale: 'ar' });
    await waitFor(() => {
      expect(document.body.textContent).toContain('RTB-FIXTURE-001');
    });
    expect(screen.getByText(ar.returnedToBranch.seamChip)).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(2);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(screen.getByRole('button', { name: new RegExp(ar.returnedToBranch.intakeScan) }));
    const title = await waitFor(() => {
      const node = document.querySelector('.modal__title');
      expect(node).not.toBeNull();
      return node!;
    });
    expect(title.textContent).toBe(ar.returnedToBranch.intake.title);
    expect(findUntranslated(title)).toEqual([]);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('returnedToBranch.seamChip')).toBe('Returned shipments queue');
    expect(englishT('returnedToBranch.actions.reschedule')).toBe('Reschedule delivery');
    expect(englishT('returnedToBranch.readback.done')).toBe('Action completed and the returned-to-branch queue was refreshed');
    expect(ar.returnedToBranch.intake.recordScan).toBe('تسجيل المسح');
    expect(ar.returnedToBranch.reschedule.apply).toBe('تطبيق إعادة الجدولة');
  });
});
