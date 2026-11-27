// amend-cancel.arabic.test.tsx: the amend & cancel review queue renders its own copy in Arabic; request values stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as api from '@/lib/api';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/operate-queues';
import { AmendCancelModule, canUseBatchForRequests } from '@/modules/operate/amend-cancel';
import { AMEND_REVIEW_TASKS, amendOpLookup, taskActionKindLookup } from '@/modules/operate/amend-cancel.fixtures';

const ORIGINAL_LOOKUP_ROW = api.lookupRow;
// The scope pill is a shared component outside this slice, so only module chips are checked in the pills row.
const chrome = () => [
  ...document.querySelectorAll('.page-header__title-block, .page-header__actions, .page-header__pills .chip, .dt__table thead'),
];

describe('AmendCancelModule in Arabic', () => {
  beforeEach(() => {
    // Same lookup fixtures as the trunk test.
    vi.spyOn(api, 'lookupRow').mockImplementation((category, value) => {
      if (category === 'shipment_amend_op') return amendOpLookup(value) as ReturnType<typeof api.lookupRow>;
      if (category === 'task_action_kind') return taskActionKindLookup(value) as ReturnType<typeof api.lookupRow>;
      return ORIGINAL_LOOKUP_ROW(category, value);
    });
    vi.spyOn(api, 'listTasks').mockResolvedValue(AMEND_REVIEW_TASKS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header, pills, actions and table headers in Arabic', async () => {
    renderWithProviders(<AmendCancelModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(screen.getByText(ar.amendCancel.seamChip)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(ar.amendCancel.preflight) })).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(2);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('amendCancel.seamChip')).toBe('Workflow-backed review queue');
    expect(englishT('amendCancel.preflight')).toBe('Pre-flight policy');
    expect(englishT('amendCancel.actions.bulkApply')).toBe('Bulk apply');
    expect(ar.amendCancel.columns.requestedBy).toBe('مقدّم الطلب');
    expect(ar.amendCancel.denied).toBe('ليست لديك صلاحية لعرض قائمة التعديل والإلغاء.');
    const arT = (path: string) =>
      path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], ar) as string;
    expect(canUseBatchForRequests([], arT)).toEqual({ ok: false, reason: ar.amendCancel.batch.missing });
  });
});
