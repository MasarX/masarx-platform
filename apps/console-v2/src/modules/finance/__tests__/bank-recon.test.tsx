// bank-recon.test.tsx — covers BankReconModule wiring through Phase B5
// canonical RPCs (CLAIM-FINANCE-WIRING / Phase C4).
//
// Asserts mutation-wiring contract:
//   • Mount + accounts grid renders rows from `bank_accounts`.
//   • Try-match button on the Open-items drawer fires `bank_recon_match_v1`
//     with the canonical payload `{ bank_statement_event_id,
//     bank_statement_occurred_at, resource_type, resource_id, matched_amount,
//     currency, match_reason }` after the operator selects the statement
//     line and settlement_batch target.
//   • Manage matches drawer captures a visible unmatch reason and fires
//     `bank_recon_unmatch_v1` with `{ bank_recon_match_id, unmatch_reason }`.
//   • Capability gate `finance.write` disables match/unmatch when missing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { BankReconModule } from '../bank-recon';
import * as api from '@/lib/api';
import { getLookups } from '@/lib/data-source';

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
  {
    id: 'ba_stc_pay',
    organization_id: 'org_rashed',
    key: 'stc-clr-002',
    name: 'STC Pay Clearing',
    bank_name: 'STC Pay',
    currency: 'SAR',
    iban_last4: '7012',
    account_last4: '7012',
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
  {
    id: 'fe_bs_2',
    organization_id: 'org_rashed',
    event_type: 'bank_statement',
    account_type: 'bank_account',
    account_id: 'ba_ncb_ruh',
    bank_account_key: 'ncb-ruh-001',
    direction: 'in',
    amount: 2110,
    currency: 'SAR',
    occurred_at: '2026-04-25T11:30:00Z',
    attached: true,
  },
];

const bankReconMatchRows = [
  {
    id: 'brm_test_active_1',
    organization_id: 'org_rashed',
    bank_statement_event_id: 'fe_bs_2',
    resource_type: 'settlement_batch',
    resource_id: 'sb_4520',
    matched_amount: 2110,
    currency: 'SAR',
    status: 'matched',
  },
];

const branchRows = [
  {
    id: 'br_riyadh_main',
    organization_id: 'org_rashed',
    code: 'ruh-main',
    name: 'Riyadh Main',
    is_active: true,
  },
];

const settlementBatchSummaryRows = [
  {
    id: 'sb_4519',
    organization_id: 'org_rashed',
    kind: 'cod',
    scope_type: 'driver_shift',
    expected_amount: 6240,
    collected_amount: 4180,
    currency: 'SAR',
    status: 'locked',
  },
  {
    id: 'sb_4521',
    organization_id: 'org_rashed',
    kind: 'cod',
    scope_type: 'driver_shift',
    expected_amount: 4820,
    collected_amount: 4820,
    currency: 'SAR',
    status: 'open',
  },
];

const billingInvoiceRows = [
  {
    id: 'inv_paid_bank_recon_1',
    organization_id: 'org_rashed',
    invoice_number: 'INV-BANK-RECON-1',
    client_label: 'Rashed Retail',
    total: 4820,
    total_amount: 4820,
    amount_paid: 4820,
    amount_due: 0,
    currency: 'SAR',
    status: 'paid',
    payment_status: 'paid',
    paid_at: '2026-04-25T11:25:00Z',
  },
  {
    id: 'inv_issued_bank_recon_1',
    organization_id: 'org_rashed',
    invoice_number: 'INV-BANK-RECON-ISSUED',
    client_label: 'Rashed Retail',
    total: 4820,
    total_amount: 4820,
    amount_paid: 0,
    amount_due: 4820,
    currency: 'SAR',
    status: 'issued',
    payment_status: 'issued',
    paid_at: null,
  },
];

const workflowRunDirectoryRows = [
  {
    id: 'wfr_test_bank_recon_1',
    workflow_status: 'running',
    workflow_template_key: 'bank_deposit_reconciliation_v2',
    template_name: 'bank_deposit_reconciliation_v2',
    correlation_id: 'cor_test_1',
  },
];

const workflowRunStepRows = [
  {
    id: 'wfs_test_bank_recon_1',
    workflow_run_id: 'wfr_test_bank_recon_1',
    label: 'Validate bank deposit window',
    status: 'pending',
    sequence: 1,
  },
];

const domainEventRows = [
  {
    id: 'de_test_bank_recon_1',
    event_type: 'workflow.run.started',
    resource_type: 'workflow_run',
    resource_id: 'wfr_test_bank_recon_1',
    workflow_run_id: 'wfr_test_bank_recon_1',
    correlation_id: 'cor_test_1',
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

function renderBankRecon(capabilities = ['finance.read', 'finance.write']) {
  return renderWithProviders(<BankReconModule />, { capabilities });
}

async function waitForLookups(category: string) {
  const deadline = Date.now() + 1000;
  while (getLookups(category).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
    if (resource === 'bank_accounts') {
      return listFromRows(bankAccountRows, opts);
    }
    if (resource === 'finance_events_bank_statement') {
      return listFromRows(bankStatementRows, opts);
    }
    if (resource === 'bank_recon_matches') {
      return listFromRows(bankReconMatchRows, opts);
    }
    if (resource === 'settlement_batch_summary') {
      return listFromRows(settlementBatchSummaryRows, opts);
    }
    if (resource === 'billing_invoice_directory') {
      return listFromRows(billingInvoiceRows, opts);
    }
    if (resource === 'branches') {
      return listFromRows(branchRows, opts);
    }
    if (resource === 'workflow_run_directory') {
      return listFromRows(workflowRunDirectoryRows, opts);
    }
    if (resource === 'workflow_run_steps') {
      return listFromRows(workflowRunStepRows, opts);
    }
    if (resource === 'domain_events') {
      return listFromRows(domainEventRows, opts);
    }
    return realListResource(resource, opts);
  });
  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
    if (resource === 'billing_invoice_directory') {
      return listFromRows(billingInvoiceRows, opts);
    }
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

describe('BankReconModule (CLAIM-FINANCE-WIRING — Phase B5/C4)', () => {
  it('mounts with accounts grid populated from bank_accounts', async () => {
    renderBankRecon();
    // Accounts cards render with `eyebrow` text from `account.key.toUpperCase()`.
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
  });

  it('resolves reconciliation policies through the active tenant scope used by Configuration', async () => {
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(api.resolveSettings).toHaveBeenCalledWith(
        'bank_reconciliation_policy',
        expect.objectContaining({
          tenant: expect.objectContaining({ id: 'org_rashed' }),
          organization_id: 'org_rashed',
        }),
      );
    });
    expect(api.resolveSettings).toHaveBeenCalledWith(
      'bank_recon_policy',
      expect.objectContaining({
        tenant: expect.objectContaining({ id: 'org_rashed' }),
        organization_id: 'org_rashed',
      }),
    );
  });

  it('disables Try-match button when only finance.read is held', async () => {
    const user = userEvent.setup();
    renderBankRecon(['finance.read']);
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    expect(
      await screen.findByRole('button', { name: /New bank account.*Finance update permission required/i }),
    ).toBeDisabled();
    expect(
      await screen.findByRole('button', { name: /Ingest statement.*Finance update permission required/i }),
    ).toBeDisabled();
    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    // Account drawer opens; click "Open items"
    const openItems = await screen.findByRole('button', { name: 'Open items' });
    await user.click(openItems);
    const tryMatch = await screen.findByRole('button', {
      name: /Try match.*Finance update permission required/i,
    });
    expect(tryMatch).toBeDisabled();
  });

  it('keeps cross-tenant bank reconciliation actions inspectable but not mutable', async () => {
    const matchSpy = vi.spyOn(api, 'bank_recon_match_v1');
    const unmatchSpy = vi.spyOn(api, 'bank_recon_unmatch_v1');
    const workflowSpy = vi.spyOn(api, 'start_workflow_run');
    const crossTenantAccounts = [
      {
        ...bankAccountRows[0]!,
        organization_id: 'org_other_tenant',
      },
    ];
    const crossTenantStatements = bankStatementRows.map((row) => ({
      ...row,
      organization_id: 'org_other_tenant',
    }));
    const crossTenantMatches = bankReconMatchRows.map((row) => ({
      ...row,
      organization_id: 'org_other_tenant',
    }));

    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource, opts) => {
      if (resource === 'bank_accounts') return listFromRows(crossTenantAccounts, opts);
      if (resource === 'finance_events_bank_statement') return listFromRows(crossTenantStatements, opts);
      if (resource === 'bank_recon_matches') return listFromRows(crossTenantMatches, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementBatchSummaryRows, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(billingInvoiceRows, opts);
      return realListResource(resource, opts);
    });

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(screen.getByText('NCB Riyadh Operations')).toBeInTheDocument();
    });

    const tenantReason = "Switch to this bank account's tenant before changing reconciliation lifecycle.";
    const ingestButton = await screen.findByRole('button', { name: 'Ingest statement' });
    expect(ingestButton).toBeDisabled();
    expect(ingestButton).toHaveAttribute('title', "Switch to a bank account's tenant before ingesting statements.");
    await user.click(ingestButton);
    expect(screen.queryByTestId('bank-statement-ingest-form')).not.toBeInTheDocument();

    await user.click(screen.getByText('NCB Riyadh Operations').closest('.card') as HTMLElement);
    const runButton = await screen.findByRole('button', { name: 'Run reconciliation' });
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAttribute('title', tenantReason);
    await user.click(runButton);
    expect(screen.queryByTestId('bank-recon-workflow-start-form')).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Open items' }));
    const tryMatch = await screen.findByRole('button', { name: 'Try match' });
    expect(tryMatch).toBeDisabled();
    expect(tryMatch).toHaveAttribute('title', tenantReason);
    await user.click(tryMatch);

    const openItemsDialog = await screen.findByRole('dialog', { name: /Open items/i });
    await user.click(within(openItemsDialog).getByRole('button', { name: /^Close$/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Open items/i })).not.toBeInTheDocument();
    });
    await user.click(screen.getByText('NCB Riyadh Operations').closest('.card') as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Manage matches' }));
    const unmatchForm = await screen.findByTestId('bank-recon-unmatch-form');
    const unmatchSubmit = within(unmatchForm).getByRole('button', { name: 'Unmatch selected match' });
    expect(unmatchSubmit).toBeDisabled();
    expect(unmatchSubmit).toHaveAttribute('title', tenantReason);
    await user.selectOptions(
      within(unmatchForm).getByRole('combobox', { name: 'Active match' }),
      'brm_test_active_1',
    );
    await user.type(within(unmatchForm).getByLabelText('Unmatch reason'), 'tenant mismatch proof');
    expect(unmatchSubmit).toBeDisabled();
    expect(unmatchSubmit).toHaveAttribute('title', tenantReason);
    await user.click(unmatchSubmit);

    expect(matchSpy).not.toHaveBeenCalled();
    expect(unmatchSpy).not.toHaveBeenCalled();
    expect(workflowSpy).not.toHaveBeenCalled();
  });

  it('human-click first account setup reads the new bank account back without reload', async () => {
    let liveAccounts: Array<Record<string, unknown>> = [];
    const listSpy = vi.mocked(api.ui_list_resource_v1);
    listSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'bank_accounts') return listFromRows(liveAccounts, opts);
      if (resource === 'finance_events_bank_statement') return listFromRows([], opts);
      if (resource === 'bank_recon_matches') return listFromRows([], opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementBatchSummaryRows, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(billingInvoiceRows, opts);
      return realListResource(resource, opts);
    });
    listSpy.mockClear();

    const createSpy = vi.spyOn(api, 'ui_create_bank_account_v1').mockImplementation(async (args) => {
      const row = {
        id: 'ba_live_click_created',
        organization_id: 'org_rashed',
        key: args.key,
        name: args.name,
        bank_name: args.bank_name,
        currency: args.currency,
        iban_last4: args.iban_last4,
        account_last4: args.account_last4,
        is_active: true,
      };
      liveAccounts = [row];
      return {
        ok: true,
        bank_account_id: row.id,
        key: String(row.key),
        organization_id: 'org_rashed',
        correlation_id: 'cor_bank_account_click',
      } as Awaited<ReturnType<typeof api.ui_create_bank_account_v1>>;
    });

    const user = userEvent.setup();
    renderBankRecon();
    await screen.findByText('No bank accounts configured.');
    const pathBefore = window.location.pathname;

    await user.click(screen.getAllByRole('button', { name: 'New bank account' })[0]!);
    const form = await screen.findByTestId('bank-account-setup-form');
    await user.type(within(form).getByLabelText('Account key'), 'main-clearing');
    await user.type(within(form).getByLabelText('Name'), 'Main Clearing Account');
    await user.type(within(form).getByLabelText('Bank'), 'Saudi Bank');
    await user.type(within(form).getByLabelText('Currency'), 'sar');
    await user.type(within(form).getByLabelText('IBAN last4'), '1234');
    await user.type(within(form).getByLabelText('Account last4'), '9876');
    await user.click(within(form).getByRole('button', { name: 'Create bank account' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(createSpy.mock.calls[0]![0]).toMatchObject({
      organization_id: 'org_rashed',
      key: 'main-clearing',
      name: 'Main Clearing Account',
      bank_name: 'Saudi Bank',
      currency: 'SAR',
      iban_last4: '1234',
      account_last4: '9876',
      metadata: { source: 'console_v2_bank_recon_setup' },
    });
    await waitFor(() => {
      expect(screen.queryByTestId('bank-account-setup-form')).not.toBeInTheDocument();
      expect(screen.getAllByText('Main Clearing Account').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Connected records')).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'bank_accounts').length,
    ).toBeGreaterThan(1);
  });

  it('creates bank accounts in the active tenant scope for platform operators', async () => {
    let liveAccounts: Array<Record<string, unknown>> = [];
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource, opts) => {
      if (resource === 'bank_accounts') return listFromRows(liveAccounts, opts);
      if (resource === 'finance_events_bank_statement') return listFromRows([], opts);
      if (resource === 'bank_recon_matches') return listFromRows([], opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementBatchSummaryRows, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(billingInvoiceRows, opts);
      return realListResource(resource, opts);
    });

    const createSpy = vi.spyOn(api, 'ui_create_bank_account_v1').mockImplementation(async (args) => {
      const row = {
        id: 'ba_platform_active_scope',
        organization_id: args.organization_id,
        key: args.key,
        name: args.name,
        bank_name: args.bank_name,
        currency: args.currency,
        iban_last4: args.iban_last4,
        account_last4: args.account_last4,
        is_active: true,
      };
      liveAccounts = [row];
      return {
        ok: true,
        bank_account_id: row.id,
        key: String(row.key),
        organization_id: String(row.organization_id),
        correlation_id: 'cor_bank_account_active_scope',
      } as Awaited<ReturnType<typeof api.ui_create_bank_account_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<BankReconModule />, {
      capabilities: ['finance.read', 'finance.write'],
      identity: {
        capabilities: ['finance.read', 'finance.write'],
        user: { organization_id: 'org_platform_home', access_scope_type: 'platform' },
        scope: { tenant: { id: 'org_rashed', label: 'First Tenant', rank: 2 } },
      },
    });
    await screen.findByText('No bank accounts configured.');

    await user.click(screen.getAllByRole('button', { name: 'New bank account' })[0]!);
    const form = await screen.findByTestId('bank-account-setup-form');
    await user.type(within(form).getByLabelText('Account key'), 'tenant-clearing');
    await user.type(within(form).getByLabelText('Name'), 'Tenant Clearing Account');
    await user.type(within(form).getByLabelText('Bank'), 'Saudi Bank');
    await user.type(within(form).getByLabelText('Currency'), 'sar');
    await user.click(within(form).getByRole('button', { name: 'Create bank account' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(createSpy.mock.calls[0]![0]).toMatchObject({
      organization_id: 'org_rashed',
      key: 'tenant-clearing',
      name: 'Tenant Clearing Account',
    });
    await waitFor(() => {
      expect(screen.getAllByText('Tenant Clearing Account').length).toBeGreaterThan(0);
    });
  });

  it('Ingest statement records a bank statement line through the browser-safe RPC', async () => {
    const spy = vi.spyOn(api, 'ui_record_bank_statement_event_v1').mockResolvedValue({
      ok: true,
      finance_event_id: 'fe_bank_stmt_test',
      created: true,
      correlation_id: 'cor_test',
    } as Awaited<ReturnType<typeof api.ui_record_bank_statement_event_v1>>);

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });

    await user.click(await screen.findByRole('button', { name: 'Ingest statement' }));
    const form = await screen.findByTestId('bank-statement-ingest-form');
    await user.type(within(form).getByLabelText('Amount'), '125.75');
    await user.clear(within(form).getByLabelText('Statement reference'));
    await user.type(within(form).getByLabelText('Statement reference'), 'stmt-bank-1');
    await user.type(within(form).getByLabelText('Description'), 'bank transfer');
    await user.click(within(form).getByRole('button', { name: 'Record statement' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toMatchObject({
      bank_account_id: expect.any(String),
      bank_account_key: expect.any(String),
      direction: 'in',
      amount: 125.75,
      currency: expect.any(String),
      idempotency_key: expect.stringContaining('stmt-bank-1'),
      metadata: {
        statement_reference: 'stmt-bank-1',
        description: 'bank transfer',
      },
    });
    expect(Number.isNaN(Date.parse(payload.occurred_at))).toBe(false);
  });

  it('human-click ingest statement flow reads the new open item back without reload', async () => {
    let liveStatements: Array<Record<string, unknown>> = bankStatementRows.map((row) => ({ ...row }));
    const listSpy = vi.mocked(api.ui_list_resource_v1);
    listSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'bank_accounts') return listFromRows(bankAccountRows, opts);
      if (resource === 'finance_events_bank_statement') return listFromRows(liveStatements, opts);
      if (resource === 'bank_recon_matches') return listFromRows(bankReconMatchRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementBatchSummaryRows, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(billingInvoiceRows, opts);
      return realListResource(resource, opts);
    });
    listSpy.mockClear();

    const ingestSpy = vi.spyOn(api, 'ui_record_bank_statement_event_v1').mockImplementation(async (args) => {
      const row = {
        id: 'fe_bs_live_click_new',
        organization_id: 'org_rashed',
        event_type: 'bank_statement',
        account_type: 'bank_account',
        account_id: args.bank_account_id,
        bank_account_key: args.bank_account_key,
        direction: args.direction,
        amount: args.amount,
        currency: args.currency,
        occurred_at: args.occurred_at,
        attached: false,
      };
      liveStatements = [row, ...liveStatements];
      return {
        ok: true,
        finance_event_id: row.id,
        created: true,
        correlation_id: 'cor_live_click',
      } as Awaited<ReturnType<typeof api.ui_record_bank_statement_event_v1>>;
    });

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    const pathBefore = window.location.pathname;

    await user.click(await screen.findByRole('button', { name: 'Ingest statement' }));
    const form = await screen.findByTestId('bank-statement-ingest-form');
    await user.type(within(form).getByLabelText('Amount'), '987.65');
    await user.type(within(form).getByLabelText('Statement reference'), 'stmt-live-click');
    await user.type(within(form).getByLabelText('Description'), 'live click readback');
    await user.click(within(form).getByRole('button', { name: 'Record statement' }));

    await waitFor(() => {
      expect(ingestSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('bank-statement-ingest-form')).not.toBeInTheDocument();
      expect(screen.getByText('fe_bs_live_click_new')).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'finance_events_bank_statement').length,
    ).toBeGreaterThan(1);
  });

  it('Try-match requires explicit statement line and settlement_batch target selection', async () => {
    const spy = vi.spyOn(api, 'bank_recon_match_v1');

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    const openItems = await screen.findByRole('button', { name: 'Open items' });
    await user.click(openItems);

    const statementSelect = await screen.findByRole('combobox', {
      name: 'Statement line',
    });
    const targetSelect = await screen.findByRole('combobox', {
      name: 'Reconciliation target',
    });
    const tryMatch = await screen.findByRole('button', { name: 'Try match' });

    expect(statementSelect).toHaveValue('');
    expect(targetSelect).toHaveValue('');
    expect(tryMatch).toBeDisabled();
    expect(tryMatch).toHaveAttribute('title', 'Select a statement line before matching.');
    await user.click(tryMatch);
    expect(spy).not.toHaveBeenCalled();

    await user.selectOptions(targetSelect, 'settlement_batch:sb_4519');
    expect(tryMatch).toBeDisabled();
    expect(tryMatch).toHaveAttribute('title', 'Select a statement line before matching.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('Try-match explains when an account has no open statement lines', async () => {
    const spy = vi.spyOn(api, 'bank_recon_match_v1');

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(1);
    });

    const cards = document.querySelectorAll('.card');
    await user.click(cards[1] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Open items' }));

    expect(await screen.findByText('No open statement lines.')).toBeInTheDocument();
    const tryMatch = await screen.findByRole('button', { name: 'Try match' });
    expect(tryMatch).toBeDisabled();
    expect(tryMatch).toHaveAttribute(
      'title',
      'No open statement lines are available for this account.',
    );
    await user.click(tryMatch);
    expect(spy).not.toHaveBeenCalled();
  });

  it('Try-match blocks settlement targets whose expected amount does not match the statement line', async () => {
    const spy = vi.spyOn(api, 'bank_recon_match_v1');

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Open items' }));
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Statement line' }),
      'fe_bs_1',
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Reconciliation target' }),
      'settlement_batch:sb_4519',
    );
    await user.click(await screen.findByRole('button', { name: 'Try match' }));

    expect(spy).not.toHaveBeenCalled();
  });

  it('Try-match fails closed when settlement target status has no canonical working lifecycle', async () => {
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'bank_accounts') return listFromRows(bankAccountRows, opts);
      if (resource === 'finance_events_bank_statement') return listFromRows(bankStatementRows, opts);
      if (resource === 'bank_recon_matches') return listFromRows(bankReconMatchRows, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(billingInvoiceRows, opts);
      if (resource === 'settlement_batch_summary') {
        return listFromRows(
          [
            {
              id: 'sb_unknown_status',
              organization_id: 'org_rashed',
              kind: 'cod',
              scope_type: 'driver_shift',
              expected_amount: 4820,
              collected_amount: 4820,
              currency: 'SAR',
              status: 'unknown_status',
            },
          ],
          opts,
        );
      }
      return realListResource(resource, opts);
    });
    const spy = vi.spyOn(api, 'bank_recon_match_v1');

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Open items' }));

    const statementSelect = await screen.findByRole('combobox', {
      name: 'Statement line',
    });
    const targetSelect = await screen.findByRole('combobox', {
      name: 'Reconciliation target',
    });
    await user.selectOptions(statementSelect, 'fe_bs_1');

    expect(targetSelect).toBeEnabled();
    expect(
      screen.queryByRole('option', { name: /sb_unknown_status/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Billing invoice INV-BANK-RECON-1/i }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Try match' })).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Try-match fires bank_recon_match_v1 with operator-selected canonical target + invalidates resources', async () => {
    const spy = vi.spyOn(api, 'bank_recon_match_v1').mockResolvedValue({
      ok: true,
      bank_recon_match_id: 'brm_test_1',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
    } as Awaited<ReturnType<typeof api.bank_recon_match_v1>>);

    const user = userEvent.setup();
    const { queryClient } = renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    const invSpy = vi.spyOn(queryClient, 'invalidateQueries');

    // Open the first account (NCB-RUH has open items per seed).
    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    const openItems = await screen.findByRole('button', { name: 'Open items' });
    await user.click(openItems);
    const statementSelect = await screen.findByRole('combobox', {
      name: 'Statement line',
    });
    const targetSelect = await screen.findByRole('combobox', {
      name: 'Reconciliation target',
    });
    await screen.findByRole('option', { name: /sb_4521/ });
    await user.selectOptions(statementSelect, 'fe_bs_1');
    await user.selectOptions(targetSelect, 'settlement_batch:sb_4521');
    const tryMatch = await screen.findByRole('button', { name: 'Try match' });
    await user.click(tryMatch);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('bank_statement_event_id');
    expect(payload).toHaveProperty('bank_statement_occurred_at');
    expect(payload).toHaveProperty('resource_type');
    expect(payload).toHaveProperty('resource_id');
    expect(payload).toHaveProperty('matched_amount');
    expect(payload).toHaveProperty('currency');
    expect(typeof payload.bank_statement_event_id).toBe('string');
    expect(payload.bank_statement_event_id).toBe('fe_bs_1');
    expect(payload.resource_type).toBe('settlement_batch');
    expect(payload.resource_id).toBe('sb_4521');
    // Cache invalidation: bank_accounts + finance_events_bank_statement +
    // bank_recon_matches refetch on success.
    await waitFor(() => {
      const calls = invSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('bank_accounts'))).toBe(true);
    });
  });

  it('human-click match removes the backend-matched statement from open items without reload', async () => {
    let liveMatches: Array<Record<string, unknown>> = bankReconMatchRows.map((row) => ({
      ...row,
    }));
    const listSpy = vi.mocked(api.ui_list_resource_v1);
    listSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'bank_accounts') return listFromRows(bankAccountRows, opts);
      if (resource === 'finance_events_bank_statement') return listFromRows(bankStatementRows, opts);
      if (resource === 'bank_recon_matches') return listFromRows(liveMatches, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementBatchSummaryRows, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(billingInvoiceRows, opts);
      return realListResource(resource, opts);
    });
    listSpy.mockClear();
    const matchSpy = vi.spyOn(api, 'bank_recon_match_v1').mockImplementation(async (args) => {
      liveMatches = [
        {
          id: 'brm_live_click_matched',
          organization_id: 'org_rashed',
          bank_statement_event_id: args.bank_statement_event_id,
          resource_type: args.resource_type,
          resource_id: args.resource_id,
          matched_amount: args.matched_amount,
          currency: args.currency,
          status: 'matched',
        },
        ...liveMatches,
      ];
      return {
        ok: true,
        bank_recon_match_id: 'brm_live_click_matched',
        correlation_id: 'cor_live_click_matched',
        settings_resolution_id: 'srlv_live_click_matched',
      } as Awaited<ReturnType<typeof api.bank_recon_match_v1>>;
    });

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    const pathBefore = window.location.pathname;

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Open items' }));
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Statement line' }),
      'fe_bs_1',
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Reconciliation target' }),
      'settlement_batch:sb_4521',
    );
    await user.click(await screen.findByRole('button', { name: 'Try match' }));

    await waitFor(() => {
      expect(matchSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByText(/fe_bs_1 - in/i)).not.toBeInTheDocument();
      expect(screen.getByText('No open statement lines.')).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'bank_recon_matches').length,
    ).toBeGreaterThan(1);
    expect(
      vi
        .mocked(api.ui_list_resource_complete)
        .mock.calls.some(([resource]) => resource === 'billing_invoice_directory'),
    ).toBe(true);
  });

  // W11-1 / W8-4 — paired projection RPC contract assertion.
  it('human-click match can reconcile a paid billing invoice target without disrupting settlement matching', async () => {
    let liveMatches: Array<Record<string, unknown>> = bankReconMatchRows.map((row) => ({
      ...row,
    }));
    const listSpy = vi.mocked(api.ui_list_resource_v1);
    listSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'bank_accounts') return listFromRows(bankAccountRows, opts);
      if (resource === 'finance_events_bank_statement') return listFromRows(bankStatementRows, opts);
      if (resource === 'bank_recon_matches') return listFromRows(liveMatches, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementBatchSummaryRows, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(billingInvoiceRows, opts);
      return realListResource(resource, opts);
    });
    listSpy.mockClear();
    const matchSpy = vi.spyOn(api, 'bank_recon_match_v1').mockImplementation(async (args) => {
      liveMatches = [
        {
          id: 'brm_live_invoice_matched',
          organization_id: 'org_rashed',
          bank_statement_event_id: args.bank_statement_event_id,
          resource_type: args.resource_type,
          resource_id: args.resource_id,
          matched_amount: args.matched_amount,
          currency: args.currency,
          status: 'matched',
        },
        ...liveMatches,
      ];
      return {
        ok: true,
        bank_recon_match_id: 'brm_live_invoice_matched',
        correlation_id: 'cor_live_invoice_matched',
        settings_resolution_id: 'srlv_live_invoice_matched',
      } as Awaited<ReturnType<typeof api.bank_recon_match_v1>>;
    });

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    const pathBefore = window.location.pathname;

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Open items' }));
    const targetSelect = await screen.findByRole('combobox', {
      name: 'Reconciliation target',
    });
    expect(await screen.findByRole('option', { name: /Settlement batch sb_4521/i })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /Billing invoice INV-BANK-RECON-1/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /INV-BANK-RECON-ISSUED/i })).not.toBeInTheDocument();

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Statement line' }),
      'fe_bs_1',
    );
    await user.selectOptions(targetSelect, 'billing_invoice:inv_paid_bank_recon_1');
    await user.click(await screen.findByRole('button', { name: 'Try match' }));

    await waitFor(() => {
      expect(matchSpy).toHaveBeenCalledTimes(1);
    });
    expect(matchSpy.mock.calls[0]![0]).toMatchObject({
      bank_statement_event_id: 'fe_bs_1',
      resource_type: 'billing_invoice',
      resource_id: 'inv_paid_bank_recon_1',
      matched_amount: 4820,
      currency: 'SAR',
    });
    await waitFor(() => {
      expect(screen.queryByText(/fe_bs_1 - in/i)).not.toBeInTheDocument();
      expect(screen.getByText('No open statement lines.')).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'bank_recon_matches').length,
    ).toBeGreaterThan(1);
  });

  it('Manage matches captures a visible unmatch reason and reads active matches back without reload', async () => {
    let liveMatches: Array<Record<string, unknown>> = bankReconMatchRows.map((row) => ({
      ...row,
    }));
    const listSpy = vi.mocked(api.ui_list_resource_v1);
    listSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'bank_accounts') return listFromRows(bankAccountRows, opts);
      if (resource === 'finance_events_bank_statement') return listFromRows(bankStatementRows, opts);
      if (resource === 'bank_recon_matches') return listFromRows(liveMatches, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementBatchSummaryRows, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(billingInvoiceRows, opts);
      return realListResource(resource, opts);
    });
    listSpy.mockClear();
    const unmatchSpy = vi.spyOn(api, 'bank_recon_unmatch_v1').mockImplementation(async (args) => {
      liveMatches = liveMatches.map((row) =>
        row.id === args.bank_recon_match_id ? { ...row, status: 'unmatched' } : row,
      );
      return {
        ok: true,
        bank_recon_match_id: args.bank_recon_match_id,
        status: 'unmatched',
        correlation_id: 'cor_unmatch_click',
        settings_resolution_id: 'srlv_unmatch_click',
      } as Awaited<ReturnType<typeof api.bank_recon_unmatch_v1>>;
    });

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    const pathBefore = window.location.pathname;

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Manage matches' }));
    const form = await screen.findByTestId('bank-recon-unmatch-form');
    expect(within(form).getByText('brm_test_active_1')).toBeInTheDocument();
    const submit = within(form).getByRole('button', { name: 'Unmatch selected match' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('title', 'Select an active match before unmatching.');

    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Active match' }),
      'brm_test_active_1',
    );
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('title', 'Enter an unmatch reason before submitting.');
    await user.type(
      within(form).getByLabelText('Unmatch reason'),
      'Statement belongs to a different settlement batch',
    );
    await user.click(submit);

    await waitFor(() => {
      expect(unmatchSpy).toHaveBeenCalledTimes(1);
    });
    expect(unmatchSpy.mock.calls[0]![0]).toMatchObject({
      bank_recon_match_id: 'brm_test_active_1',
      unmatch_reason: 'Statement belongs to a different settlement batch',
    });
    await waitFor(() => {
      expect(within(form).getByText('No active matches for this account.')).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'bank_recon_matches').length,
    ).toBeGreaterThan(1);
  });

  it('unmatching a billing invoice match reopens the statement and invoice target without reload', async () => {
    let liveMatches: Array<Record<string, unknown>> = [
      {
        id: 'brm_invoice_active_1',
        organization_id: 'org_rashed',
        bank_statement_event_id: 'fe_bs_1',
        resource_type: 'billing_invoice',
        resource_id: 'inv_paid_bank_recon_1',
        matched_amount: 4820,
        currency: 'SAR',
        status: 'matched',
      },
    ];
    const listSpy = vi.mocked(api.ui_list_resource_v1);
    listSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'bank_accounts') return listFromRows(bankAccountRows, opts);
      if (resource === 'finance_events_bank_statement') return listFromRows(bankStatementRows, opts);
      if (resource === 'bank_recon_matches') return listFromRows(liveMatches, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementBatchSummaryRows, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(billingInvoiceRows, opts);
      return realListResource(resource, opts);
    });
    listSpy.mockClear();
    const unmatchSpy = vi.spyOn(api, 'bank_recon_unmatch_v1').mockImplementation(async (args) => {
      liveMatches = liveMatches.map((row) =>
        row.id === args.bank_recon_match_id
          ? { ...row, status: 'unmatched', unmatch_reason: args.unmatch_reason }
          : row,
      );
      return {
        ok: true,
        bank_recon_match_id: args.bank_recon_match_id,
        status: 'unmatched',
        correlation_id: 'cor_invoice_unmatch_click',
        settings_resolution_id: 'srlv_invoice_unmatch_click',
      } as Awaited<ReturnType<typeof api.bank_recon_unmatch_v1>>;
    });

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    const pathBefore = window.location.pathname;

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Open items' }));
    expect(screen.queryByRole('option', { name: /fe_bs_1 - in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Billing invoice INV-BANK-RECON-1/i })).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Close'));
    await user.click(cards[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Manage matches' }));
    const form = await screen.findByTestId('bank-recon-unmatch-form');
    expect(within(form).getByText('brm_invoice_active_1')).toBeInTheDocument();
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Active match' }),
      'brm_invoice_active_1',
    );
    await user.type(
      within(form).getByLabelText('Unmatch reason'),
      'Invoice payment was linked to the wrong bank statement',
    );
    await user.click(within(form).getByRole('button', { name: 'Unmatch selected match' }));

    await waitFor(() => {
      expect(unmatchSpy).toHaveBeenCalledTimes(1);
    });
    expect(unmatchSpy.mock.calls[0]![0]).toMatchObject({
      bank_recon_match_id: 'brm_invoice_active_1',
      unmatch_reason: 'Invoice payment was linked to the wrong bank statement',
    });
    await waitFor(() => {
      expect(within(form).getByText('No active matches for this account.')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Close'));
    await user.click(cards[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Open items' }));
    expect(await screen.findByRole('option', { name: /fe_bs_1 - in/i })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /Billing invoice INV-BANK-RECON-1/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'bank_recon_matches').length,
    ).toBeGreaterThan(1);
    expect(
      vi
        .mocked(api.ui_list_resource_complete)
        .mock.calls.some(([resource]) => resource === 'billing_invoice_directory'),
    ).toBe(true);
  });

  it('cards consume compute_bank_account_balance_v1 (paired RPC shipped W8-4)', async () => {
    const spy = vi.spyOn(api, 'compute_bank_account_balance_v1');
    renderBankRecon(['finance.read']);
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    // Each rendered BankAccountCard owns its own useBankAccountBalance(id)
    // hook → exactly one call per visible account, with the canonical args.
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    const firstCall = spy.mock.calls[0]![0]!;
    expect(firstCall).toHaveProperty('bank_account_id');
    expect(typeof firstCall.bank_account_id).toBe('string');
    expect(firstCall.bank_account_id.length).toBeGreaterThan(0);
  });

  // W11-1 — settlement_batch_summary view is read for reconciliation targets.
  it('reads settlement_batch_summary as the reconciliation target seam', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    renderBankRecon(['finance.read']);
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    const calls = listSpy.mock.calls.map((c) => c[0]);
    expect(calls).toContain('settlement_batch_summary');
  });

  // W39 closure (REAUDIT5B FINANCE NEW P2) — "Run reconciliation" drawer
  // footer Button now wires through the canonical public-callable
  // workflow-start seam `api.start_workflow_run` (server-asserted
  // `workflow_runs.write`) targeting the canonical
  // `bank_deposit_reconciliation_v2` template id
  // `99990000-0000-0000-0000-000000570004`. This test asserts the
  // canonical args land at the api boundary; previously the button
  // emitted only a toast simulation.
  it('Run reconciliation captures required workflow context before starting bank_deposit_reconciliation_v2', async () => {
    const swrSpy = vi
      .spyOn(api, 'start_workflow_run')
      .mockResolvedValue({
        ok: true,
        workflow_run_id: 'wfr_test_bank_recon_1',
        workflow_template_id: '99990000-0000-0000-0000-000000570004',
        workflow_status: 'pending',
        dry_run: false,
        idempotency_key: 'idemp_test_1',
        correlation_id: 'cor_test_1',
        started_at: new Date().toISOString(),
        canonical_entrypoint: 'progress_workflow_run',
      } as Awaited<ReturnType<typeof api.start_workflow_run>>);

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });

    // Open the first account drawer.
    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    const runRecon = await screen.findByRole('button', {
      name: /Run reconciliation/i,
    });
    await user.click(runRecon);
    const form = await screen.findByTestId('bank-recon-workflow-start-form');
    const submit = within(form).getByRole('button', { name: 'Start reconciliation' });
    expect(submit).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText('Kind'), 'deposit');
    await user.selectOptions(within(form).getByLabelText('Scope'), 'branch_day');
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute(
      'title',
      'Select a branch before starting branch-day reconciliation.',
    );
    await user.selectOptions(within(form).getByLabelText('Branch'), 'br_riyadh_main');
    await user.click(within(form).getByRole('button', { name: 'Start reconciliation' }));

    await waitFor(() => {
      expect(swrSpy).toHaveBeenCalledTimes(1);
    });
    const [templateId, context] = swrSpy.mock.calls[0]!;
    expect(templateId).toBe('99990000-0000-0000-0000-000000570004');
    expect(context).toMatchObject({
      bank_account_id: expect.any(String),
      bank_account_key: 'ncb-ruh-001',
      kind: 'deposit',
      scope_type: 'branch_day',
      branch_id: 'br_riyadh_main',
      subject_type: 'branch',
      subject_id: 'br_riyadh_main',
      window_start_at: expect.stringMatching(/T00:00:00\.000Z$/),
      window_end_at: expect.stringMatching(/T23:59:59\.999Z$/),
    });
    expect(await screen.findByText('Workflow run context')).toBeInTheDocument();
    expect(screen.getByText('wfr_test_bank_recon_1')).toBeInTheDocument();
    expect(screen.getByText('bank_deposit_reconciliation_v2')).toBeInTheDocument();
    expect(screen.getByText('Request trail')).toBeInTheDocument();
    expect(screen.getByText('Recorded')).toBeInTheDocument();
    expect(screen.queryByText('cor_test_1')).not.toBeInTheDocument();
    expect(screen.getByText('ncb-ruh-001')).toBeInTheDocument();
    expect(screen.getByText(/Validate bank deposit window - pending/i)).toBeInTheDocument();
    expect(screen.getByText('workflow.run.started')).toBeInTheDocument();
  });

  it('Run reconciliation only offers settlement scopes allowed by policy and bank_deposit_reconciliation_v2', async () => {
    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: /Run reconciliation/i }));

    const form = await screen.findByTestId('bank-recon-workflow-start-form');
    const scope = within(form).getByLabelText('Scope') as HTMLSelectElement;
    const options = Array.from(scope.options).map((option) => option.value);
    expect(options).toContain('branch_day');
    expect(options).not.toContain('driver_shift');
    expect(options).not.toContain('accounting_period');
    expect(options).not.toContain('client_cycle');
  });

  it('disables Run reconciliation when canonical bank_reconciliation_policy is disabled', async () => {
    vi.mocked(api.resolveSettings).mockImplementation((category, scope) => {
      if (category === 'bank_reconciliation_policy') {
        return Promise.resolve({
          category,
          value: {
            version: 1,
            enabled: false,
            default_bank_account_key: null,
            bank_statement_event_type: 'bank_statement',
          },
          resolved_from: 'tenant',
          ladder_path: [],
          settings_resolution_id: 'srlv_bank_reconciliation_policy_disabled_test',
          override_of: null,
        } as Awaited<ReturnType<typeof api.resolveSettings>>);
      }
      return realResolveSettings(category, scope as Record<string, unknown> | undefined);
    });
    const startWorkflowSpy = vi.spyOn(api, 'start_workflow_run');

    const user = userEvent.setup();
    renderBankRecon();
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);
    const runRecon = await screen.findByRole('button', {
      name: /Run reconciliation/i,
    });

    expect(runRecon).toBeDisabled();
    expect(
      await screen.findByText(/Bank reconciliation workflow policy is disabled/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId('bank-recon-policy-config-link')).toHaveAttribute(
      'href',
      expect.stringContaining('/platform/config?category=bank_reconciliation_policy'),
    );
    await user.click(runRecon);

    expect(screen.queryByTestId('bank-recon-workflow-start-form')).not.toBeInTheDocument();
    expect(startWorkflowSpy).not.toHaveBeenCalled();
  });

  it('keeps bank reconciliation write actions inert when only finance.read is held', async () => {
    const ingestSpy = vi
      .spyOn(api, 'ui_record_bank_statement_event_v1')
      .mockResolvedValue({
        ok: true,
        finance_event_id: 'fe_denied_should_not_run',
        created: true,
        correlation_id: 'cor_denied_should_not_run',
      } as Awaited<ReturnType<typeof api.ui_record_bank_statement_event_v1>>);
    const matchSpy = vi
      .spyOn(api, 'bank_recon_match_v1')
      .mockResolvedValue({
        ok: true,
        bank_recon_match_id: 'brm_denied_should_not_run',
        correlation_id: 'cor_denied_should_not_run',
        settings_resolution_id: 'srlv_denied_should_not_run',
      } as Awaited<ReturnType<typeof api.bank_recon_match_v1>>);
    const unmatchSpy = vi
      .spyOn(api, 'bank_recon_unmatch_v1')
      .mockResolvedValue({
        ok: true,
        bank_recon_match_id: 'brm_denied_should_not_run',
        status: 'unmatched',
        correlation_id: 'cor_denied_should_not_run',
        settings_resolution_id: 'srlv_denied_should_not_run',
      } as Awaited<ReturnType<typeof api.bank_recon_unmatch_v1>>);
    const startWorkflowSpy = vi
      .spyOn(api, 'start_workflow_run')
      .mockResolvedValue({
        ok: true,
        workflow_run_id: 'wfr_denied_should_not_run',
        workflow_template_id: '99990000-0000-0000-0000-000000570004',
        workflow_status: 'pending',
        dry_run: false,
        idempotency_key: 'idemp_denied_should_not_run',
        correlation_id: 'cor_denied_should_not_run',
        started_at: new Date().toISOString(),
        canonical_entrypoint: 'progress_workflow_run',
      } as Awaited<ReturnType<typeof api.start_workflow_run>>);

    const user = userEvent.setup();
    renderBankRecon(['finance.read']);
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });

    const ingest = await screen.findByRole('button', {
      name: /Ingest statement.*Finance update permission required/i,
    });
    expect(ingest).toBeDisabled();
    await user.click(ingest);
    expect(ingestSpy).not.toHaveBeenCalled();

    const cards = document.querySelectorAll('.card');
    await user.click(cards[0] as HTMLElement);

    const runRecon = await screen.findByRole('button', {
      name: /Run reconciliation.*Finance update permission required/i,
    });
    const manageMatches = await screen.findByRole('button', {
      name: /Manage matches.*Finance update permission required/i,
    });
    expect(runRecon).toBeDisabled();
    expect(manageMatches).toBeDisabled();
    await user.click(runRecon);
    await user.click(manageMatches);
    expect(startWorkflowSpy).not.toHaveBeenCalled();
    expect(unmatchSpy).not.toHaveBeenCalled();

    await user.click(await screen.findByRole('button', { name: 'Open items' }));
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Statement line' }),
      'fe_bs_1',
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Reconciliation target' }),
      'settlement_batch:sb_4519',
    );
    const tryMatch = await screen.findByRole('button', {
      name: /Try match.*Finance update permission required/i,
    });
    expect(tryMatch).toBeDisabled();
    await user.click(tryMatch);
    expect(matchSpy).not.toHaveBeenCalled();
  });
});
