// disputes.arabic.test.tsx: the disputes page renders its own copy in Arabic; dispute ids, labels and amounts stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as api from '@/lib/api';
import { getLookups } from '@/lib/data-source';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/finance';
import { DisputesModule } from './disputes';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

const realListResource = api.ui_list_resource_v1;
const realCompleteList = api.ui_list_resource_complete;

// Same rows as the trunk test (__tests__/disputes.test.tsx).
const disputeRows = [
  {
    id: 'dsp_880',
    contract_id: 'mctr_702',
    category: 'execution',
    status: 'submitted',
    created_at: '2026-04-23T11:00:00Z',
    metadata: { shipment_ref: 'SHP-9381015', amount_sar: 150 },
  },
  {
    id: 'dsp_879',
    contract_id: 'mctr_702',
    category: 'commercial',
    status: 'resolved',
    created_at: '2026-04-19T14:00:00Z',
    resolution: 'credit',
    metadata: { shipment_ref: 'SHP-9380987', amount_sar: 240 },
  },
];

const disputeDirectoryRows = disputeRows.map((row) => ({
  ...row,
  dispute_id: row.id,
  opened_by_label: 'MasarX Operations',
  counterparty_label: 'Exampledepot',
  opened_by_user_label: 'Finance Operator',
  resolved_by_user_label: row.status === 'resolved' ? 'Finance Lead' : null,
  shipment_ref: row.metadata.shipment_ref,
  amount_sar: row.metadata.amount_sar,
  escalation_count: 0,
  escalation_at: null,
  is_escalated: false,
  is_terminal: row.status === 'resolved',
  age_seconds: 3600,
  age_hours: 1,
}));

function listFromRows<T>(rows: T[], opts?: api.ListOpts) {
  const filter = opts?.filter ?? {};
  const filtered = rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => value == null || value === '' || (row as Record<string, unknown>)[key] === value),
  );
  return Promise.resolve({ rows: filtered, total: filtered.length, page: 0, page_size: filtered.length });
}

async function waitForLookups(category: string) {
  const deadline = Date.now() + 1000;
  while (getLookups(category).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const chrome = () => [
  ...document.querySelectorAll('.page-header__title-block, .page-header__pills .chip, .dt__table thead'),
];

describe('DisputesModule in Arabic', () => {
  beforeEach(async () => {
    await Promise.all([
      waitForLookups('dispute_status'),
      waitForLookups('dispute_kind'),
      waitForLookups('dispute_resolution'),
    ]);
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'marketplace_disputes') return listFromRows(disputeRows, opts);
      if (resource === 'dispute_directory') return listFromRows(disputeDirectoryRows, opts);
      return realListResource(resource, opts);
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'marketplace_disputes') return listFromRows(disputeRows, opts);
      if (resource === 'dispute_directory') return listFromRows(disputeDirectoryRows, opts);
      return realCompleteList(resource, opts);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header, pills, table headers and drawer copy in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DisputesModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => {
      expect(screen.getByText('dsp_880')).toBeInTheDocument();
    });
    expect(screen.getByText(ar.disputes.seamChip)).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(1);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    const row = screen.getByText('dsp_880').closest('tr') as HTMLElement;
    await user.click(within(row).getAllByRole('cell')[1]!);
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent).toContain(ar.disputes.drawer.backing);
    });
    const drawer = document.querySelector('.drawer')!;
    expect(drawer.textContent).toContain(ar.disputes.drawer.contract);
    const sections = [...drawer.querySelectorAll('.card, h4.eyebrow')];
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('disputes.disabled.otherTenant')).toBe("Switch to this dispute's tenant before changing dispute lifecycle.");
    expect(englishT('disputes.disabled.cannotResolve')).toBe('Selected disputes include a status that cannot be resolved.');
    expect(englishT('disputes.actions.markResolved')).toBe('Mark resolved');
    expect(englishT('disputes.modal.rejectDispute')).toBe('Reject dispute');
    expect(ar.disputes.actions.markResolved).toBe('تعليم كمحلول');
    expect(ar.disputes.modal.escalationReason).toBe('سبب التصعيد');
  });
});
