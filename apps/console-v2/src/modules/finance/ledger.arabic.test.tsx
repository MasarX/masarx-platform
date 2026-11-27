// ledger.arabic.test.tsx: the finance ledger renders its own copy in Arabic; account ids, event ids and amounts stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as api from '@/lib/api';
import { englishT, fill } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/finance';
import shellAr from '@/lib/seed-raw/i18n/areas/ar/shell';
import { LedgerModule } from './ledger';

const realListResource = api.ui_list_resource_v1;
const realCompleteList = api.ui_list_resource_complete;

// Same rows as the trunk ledger test: one unlinked COD event (reversible) and one settlement-linked pair.
const ledgerRows = [
  {
    id: 'fel_1101',
    occurred_at: '2026-04-25T11:30:00Z',
    account_id: 'cod_collected_clearing',
    direction: 'in',
    amount: 2110,
    event_type: 'cod_collected',
    metadata: {},
  },
  {
    id: 'fel_1099',
    occurred_at: '2026-04-25T10:30:00Z',
    account_id: 'client_examplemarket_ksa_receivable',
    direction: 'out',
    amount: 184220,
    event_type: 'billing',
    settlement_batch_id: 'sb_4518',
    metadata: { batch_id: 'sb_4518' },
  },
];

function listFromRows<T>(rows: T[], opts?: api.ListOpts) {
  const filter = opts?.filter ?? {};
  const filteredRows = rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => value == null || value === '' || (row as Record<string, unknown>)[key] === value),
  );
  return Promise.resolve({ rows: filteredRows, total: filteredRows.length, page: 0, page_size: filteredRows.length });
}

const chrome = () => [...document.querySelectorAll('.page-header__title-block, .dt__table thead')];

beforeEach(() => {
  localStorage.removeItem('demo-v2.view.finance_events_ledger');
  window.history.pushState(null, '', '/');
  vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) =>
    resource === 'finance_events_ledger' ? listFromRows(ledgerRows, opts) : realListResource(resource, opts),
  );
  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) =>
    resource === 'finance_events_ledger' ? listFromRows(ledgerRows, opts) : realCompleteList(resource, opts),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState(null, '', '/');
});

describe('LedgerModule in Arabic', () => {
  it('renders the header, table headers and reversal form in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LedgerModule />, { locale: 'ar', capabilities: ['finance.read', 'finance.write'] });
    await waitFor(() => {
      expect(screen.getByText('cod_collected_clearing')).toBeInTheDocument();
    });
    expect(screen.getByText(ar.ledger.seamChip)).toBeInTheDocument();
    expect(screen.getByText(ar.ledger.balance.sumDebit)).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(1);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    const kebabs = await screen.findAllByRole('button', { name: shellAr.shell.table.rowActions });
    await user.click(kebabs[0]!);
    const option = await screen.findByRole('option', { name: new RegExp(`^${ar.ledger.actions.reverse}`) });
    await user.click(option);
    const dialog = await screen.findByRole('dialog', { name: fill(ar.ledger.reversal.title, { id: 'fel_1101' }) });
    expect(dialog.textContent).toContain(ar.ledger.reversal.intro);
    const form = [...dialog.querySelectorAll('.modal__header, .modal__body')];
    expect(form.length).toBeGreaterThan(0);
    expect(form.flatMap((element) => findUntranslated(element, ['fel_1101']))).toEqual([]);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('ledger.reversal.title')).toBe('Reverse ledger event - {id}');
    expect(englishT('ledger.reversal.reasonMissing')).toBe('Enter a reversal reason before submitting.');
    expect(englishT('ledger.disabled.otherTenant')).toBe("Switch to this ledger row's tenant before reversing.");
    expect(englishT('ledger.confirmed.title')).toBe('Reversal confirmed');
    expect(ar.ledger.actions.exportLedger).toBe('تصدير دفتر الأستاذ');
    expect(ar.ledger.confirmed.title).toBe('تم تأكيد العكس');
  });
});
