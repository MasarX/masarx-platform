// settlements.arabic.test.tsx: the settlements board and batch drawer render their own copy in Arabic; batch ids, kinds and lookup labels stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as api from '@/lib/api';
import { getLookups } from '@/lib/data-source';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/finance';
import { SettlementsModule } from './settlements';

const realCompleteList = api.ui_list_resource_complete;

// Same rows as the trunk settlements test, trimmed to what the board renders.
const settlementBatchRows = [
  { id: 'sb_4521', organization_id: 'org_rashed', kind: 'cod', scope_type: 'driver_shift', status: 'open', updated_at: '2026-04-25T11:48:00Z' },
  { id: 'sb_4518', organization_id: 'org_rashed', kind: 'cod', scope_type: 'client_cycle', status: 'locked', updated_at: '2026-04-25T10:48:00Z' },
];
const settlementSummaryRows = settlementBatchRows.map((row, index) => ({
  ...row,
  expected_amount: [4820, 3250][index] ?? 0,
  collected_amount: [4820, 3200][index] ?? 0,
  remitted_amount: [0, 3000][index] ?? 0,
  variance_flag: index === 1,
  posted_at: null,
}));

function listFromRows<T>(rows: T[], opts?: api.ListOpts) {
  const filter = opts?.filter ?? {};
  const filteredRows = rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => value == null || value === '' || (row as Record<string, unknown>)[key] === value),
  );
  return Promise.resolve({ rows: filteredRows, total: filteredRows.length, page: 0, page_size: filteredRows.length });
}

async function waitForLookups(category: string) {
  const deadline = Date.now() + 1000;
  while (getLookups(category).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('SettlementsModule in Arabic', () => {
  beforeEach(async () => {
    await Promise.all([
      waitForLookups('settlement_status'),
      waitForLookups('settlement_batch_transition_action'),
      waitForLookups('settlement_kind'),
      waitForLookups('settlement_scope_type'),
    ]);
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'settlement_batches') return listFromRows(settlementBatchRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementSummaryRows, opts);
      return realCompleteList(resource, opts);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header, board and batch drawer copy in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, { locale: 'ar', capabilities: ['all'] });
    const batchId = await screen.findByText('sb_4521');
    expect(screen.getByRole('button', { name: ar.settlements.create.action })).toBeInTheDocument();
    expect(screen.getByText(ar.settlements.seamChip)).toBeInTheDocument();
    const chrome = [
      ...document.querySelectorAll('.page-header__title-block, .page-header__actions, .page-header__pills .chip, .kanban'),
    ];
    expect(chrome.length).toBeGreaterThan(3);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(batchId.closest('.kanban__card') as HTMLElement);
    expect(await screen.findByText(ar.settlements.backing.title)).toBeInTheDocument();
    const drawer = [...document.querySelectorAll('.drawer .card, .drawer h4.eyebrow')];
    expect(drawer.length).toBeGreaterThan(2);
    expect(drawer.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('settlements.reasons.approveNotAllowed')).toBe('This settlement status does not allow approval.');
    expect(englishT('settlements.reasons.otherTenant')).toBe("Switch to this settlement batch's tenant before changing settlement lifecycle.");
    expect(englishT('settlements.backing.summaryValue')).toBe('Settlement summary');
    expect(englishT('settlements.reject.submit')).toBe('Reject batch');
    expect(ar.settlements.reject.reason).toBe('سبب الرفض');
    expect(ar.settlements.create.submit).toBe('فتح الدفعة');
  });
});
