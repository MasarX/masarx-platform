// exceptions.arabic.test.tsx: the exceptions (NDR) queue renders its own copy in Arabic; task values and lookup labels stay as data (#302).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as ds from '@/lib/data-source';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/operate-queues';
import { ExceptionsModule } from '@/modules/operate/exceptions';
import {
  exceptionReturnCompleteResource,
  exceptionReturnOperatorIdentity,
  exceptionTaskRows,
} from './__tests__/exceptions-return.fixtures';

const COMPLETE_RESOURCE = ds.ui_list_resource_complete;
// The scope pill is a shared component outside this slice, so only module chips are checked in the pills row.
const chrome = () => [
  ...document.querySelectorAll('.page-header__title-block, .page-header__pills .chip, .dt__table thead'),
];
// "NDR" is the industry acronym the shared modules.exceptions title keeps in Arabic.
const ALLOW = ['NDR'];

describe('ExceptionsModule in Arabic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Same data seams as the trunk lifecycle test.
    vi.spyOn(ds, 'resolve_ndr_branch_next_action_v1').mockResolvedValue('reschedule');
    vi.spyOn(ds, 'listTasks').mockResolvedValue(exceptionTaskRows);
    vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation((resource, opts) =>
      exceptionReturnCompleteResource(resource, opts, COMPLETE_RESOURCE),
    );
  });

  it('renders the header, table headers and drawer section titles in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExceptionsModule />, { identity: exceptionReturnOperatorIdentity, locale: 'ar' });
    await waitFor(() => {
      expect(document.body.textContent).toContain('TSK-NDR-FIXTURE');
    });
    expect(screen.getByText(ar.exceptions.seamChip)).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(1);
    expect(chrome().flatMap((element) => findUntranslated(element, ALLOW))).toEqual([]);

    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer')!;
    expect(drawer.textContent).toContain(ar.exceptions.resolution.options);
    const headings = [...drawer.querySelectorAll('.rail-body h4.eyebrow')];
    expect(headings.map((node) => node.textContent)).toEqual(
      expect.arrayContaining([ar.exceptions.detail.task, ar.exceptions.resolution.options]),
    );
    expect(headings.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('exceptions.denied')).toBe('You do not have permission to view the exceptions queue.');
    expect(englishT('exceptions.readback.done')).toBe('Action completed and the exception queue was refreshed');
    expect(englishT('exceptions.resolution.evidenceHint')).toBe('Evidence required: add notes before apply.');
    expect(englishT('exceptions.actions.bulkReturn')).toBe('Return to branch (preview)');
    expect(ar.exceptions.preview.ready).toBe('المعاينة جاهزة');
    expect(ar.exceptions.actions.applyReschedule).toBe('تطبيق (إعادة الجدولة)');
  });
});
