// bank-recon.arabic.test.tsx: the bank reconciliation page renders its own copy in Arabic; account keys, names and amounts stay as data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { BankReconModule } from '@/modules/finance/bank-recon';
import * as api from '@/lib/api';
import { getLookups } from '@/lib/data-source';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/finance';

const realListResource = api.ui_list_resource_v1;
const realListResourceComplete = api.ui_list_resource_complete;
const realResolveSettings = api.resolveSettings;

const bankAccountRows = [
  {
    id: 'ba_ncb_ruh',
    organization_id: 'org_rashed',
    key: 'ncb-ruh-001',
    name: 'NCB Riyadh Operations',
    bank_name: 'NCB',
    currency: 'SAR',
    iban_last4: '8421',
    account_last4: '0921',
    is_active: true,
  },
];

const bankStatementRows = [
  {
    id: 'fe_bs_1',
    organization_id: 'org_rashed',
    event_type: 'bank_statement',
    account_type: 'bank_account',
    account_id: 'ba_ncb_ruh',
    bank_account_key: 'ncb-ruh-001',
    direction: 'in',
    amount: 4820,
    currency: 'SAR',
    occurred_at: '2026-04-25T11:30:00Z',
    attached: false,
  },
];

function listFromRows<T>(rows: T[], opts?: api.ListOpts) {
  const filter = opts?.filter ?? {};
  const filteredRows = rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => {
      if (value == null || value === '') return true;
      return (row as Record<string, unknown>)[key] === value;
    }),
  );
  return Promise.resolve({
    rows: filteredRows,
    total: filteredRows.length,
    page: 0,
    page_size: filteredRows.length,
  });
}

async function waitForLookups(category: string) {
  const deadline = Date.now() + 1000;
  while (getLookups(category).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

beforeEach(async () => {
  await Promise.all([
    waitForLookups('finance_direction'),
    waitForLookups('settlement_status'),
    waitForLookups('bank_recon_match_status'),
    waitForLookups('invoice_status'),
    waitForLookups('settlement_kind'),
    waitForLookups('settlement_scope_type'),
  ]);

  vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
    if (resource === 'bank_accounts') return listFromRows(bankAccountRows, opts);
    if (resource === 'finance_events_bank_statement') return listFromRows(bankStatementRows, opts);
    if (resource === 'bank_recon_matches') return listFromRows([], opts);
    if (resource === 'settlement_batch_summary') return listFromRows([], opts);
    if (resource === 'billing_invoice_directory') return listFromRows([], opts);
    return realListResource(resource, opts);
  });
  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
    if (resource === 'billing_invoice_directory') return listFromRows([], opts);
    return realListResourceComplete(resource, opts);
  });
  vi.spyOn(api, 'resolveSettings').mockImplementation((category, scope) => {
    if (category === 'bank_reconciliation_policy') {
      return Promise.resolve({
        category,
        value: {
          version: 1,
          enabled: true,
          default_bank_account_key: 'ncb-ruh-001',
          bank_statement_event_type: 'bank_statement',
        },
        resolved_from: 'tenant',
        ladder_path: [],
        settings_resolution_id: 'srlv_bank_reconciliation_policy_test',
        override_of: null,
      } as Awaited<ReturnType<typeof api.resolveSettings>>);
    }
    if (category === 'settlement_policy') {
      return Promise.resolve({
        category,
        value: {
          version: 1,
          batch_scopes: ['branch_day', 'driver_shift'],
        },
        resolved_from: 'tenant',
        ladder_path: [],
        settings_resolution_id: 'srlv_settlement_policy_test',
        override_of: null,
      } as Awaited<ReturnType<typeof api.resolveSettings>>);
    }
    return realResolveSettings(category, scope as Record<string, unknown> | undefined);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BankReconModule in Arabic', () => {
  it('renders the header, account cards and account drawer chrome in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankReconModule />, { locale: 'ar', capabilities: ['finance.read', 'finance.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    expect(await screen.findByRole('button', { name: 'حساب بنكي جديد' })).toBeInTheDocument();

    const chrome = [
      ...document.querySelectorAll('.page-header__title-block, .page-header__actions, .card'),
    ];
    expect(chrome.length).toBeGreaterThan(2);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(document.querySelectorAll('.card')[0] as HTMLElement);
    expect(await screen.findByText(ar.bankRecon.account.resolvedPolicy)).toBeInTheDocument();
    const connected = await screen.findByText(ar.bankRecon.account.connected);
    expect(connected.nextElementSibling).not.toBeNull();
    expect(findUntranslated(connected.nextElementSibling as Element)).toEqual([]);
    expect(await screen.findByRole('button', { name: ar.bankRecon.actions.openItems })).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('bankRecon.actions.newAccount')).toBe('New bank account');
    expect(englishT('bankRecon.reasons.tenantAction')).toBe(
      "Switch to this bank account's tenant before changing reconciliation lifecycle.",
    );
    expect(englishT('bankRecon.card.openItems')).toBe('Open items: {n}');
    expect(lookup(ar, 'bankRecon.account.connected')).toBe('السجلات المرتبطة');
    expect(lookup(ar, 'bankRecon.empty.accounts')).toBe('لا توجد حسابات بنكية مهيأة.');
    expect(lookup(ar, 'bankRecon.card.openItems')).toBe('البنود المفتوحة: {n}');
  });
});
