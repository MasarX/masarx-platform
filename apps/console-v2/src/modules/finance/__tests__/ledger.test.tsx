import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { LedgerModule } from '../ledger';
import * as api from '@/lib/api';

const realListResource = api.ui_list_resource_v1;
const realCompleteList = api.ui_list_resource_complete;
const realGetResource = api.ui_get_resource_v1;
const emptyScopedClientId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
const emptyScopedPartnerId = '22222222-2222-4222-8222-222222222222';

const settlementRows = [
  {
    id: 'sb_4518',
    scope_type: 'client',
    client_id: 'cl_exampleparcel_ksa',
    subject_type: 'client',
    subject_id: 'cl_exampleparcel_ksa',
  },
  {
    id: 'sb_4517',
    scope_type: 'partner',
    partner_id: 'mpp_exampledepot',
    participant_id: 'mpp_exampledepot',
    supplier_participant_profile_id: 'mpp_exampledepot',
    subject_type: 'partner',
    subject_id: 'mpp_exampledepot',
  },
];

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
    client_id: 'cl_exampleparcel_ksa',
    settlement_batch_id: 'sb_4518',
    metadata: { batch_id: 'sb_4518' },
  },
  {
    id: 'fel_1098',
    occurred_at: '2026-04-25T10:30:00Z',
    account_id: 'revenue_billable_services',
    direction: 'in',
    amount: 184220,
    event_type: 'billing',
    client_id: 'cl_exampleparcel_ksa',
    settlement_batch_id: 'sb_4518',
    metadata: { batch_id: 'sb_4518' },
  },
  {
    id: 'fel_1097',
    occurred_at: '2026-04-24T18:00:00Z',
    account_id: 'partner_exampledepot_payable',
    direction: 'out',
    amount: 92140,
    event_type: 'payout',
    partner_id: 'mpp_exampledepot',
    participant_id: 'mpp_exampledepot',
    supplier_participant_profile_id: 'mpp_exampledepot',
    settlement_batch_id: 'sb_4517',
    metadata: { batch_id: 'sb_4517' },
  },
  {
    id: 'fel_1096',
    occurred_at: '2026-04-24T18:00:00Z',
    account_id: 'cash_disbursed',
    direction: 'in',
    amount: 92140,
    event_type: 'payout',
    partner_id: 'mpp_exampledepot',
    participant_id: 'mpp_exampledepot',
    supplier_participant_profile_id: 'mpp_exampledepot',
    settlement_batch_id: 'sb_4517',
    metadata: { batch_id: 'sb_4517' },
  },
];

const clientRows = [
  { id: 'cl_exampleparcel_ksa', name: 'Exampleparcel KSA', status: 'active' },
  { id: emptyScopedClientId, name: 'Live Empty Ledger Client', status: 'active' },
];

const partnerRows = [
  { id: 'mpp_exampledepot', name: 'Exampledepot', display_name: 'Exampledepot', status: 'approved' },
  { id: emptyScopedPartnerId, display_name: 'Live Empty Ledger Partner', status: 'approved' },
];

const nilUuid = '00000000-0000-0000-0000-000000000000';

function listFromRows<T>(rows: T[], opts?: api.ListOpts) {
  const filter = opts?.filter ?? {};
  const filteredRows = rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => {
      if (value == null || value === '') return true;
      if ((key === 'client_id' || key === 'sender_id') && value === nilUuid) {
        return (row as Record<string, unknown>).client_id === 'cl_exampleparcel_ksa';
      }
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

function renderLedger(capabilities = ['finance.read', 'finance.write']) {
  return renderWithProviders(<LedgerModule />, { capabilities });
}

beforeEach(() => {
  localStorage.removeItem('demo-v2.view.finance_events_ledger');
  window.history.pushState(null, '', '/');

  vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
    if (resource === 'finance_events_ledger') {
      return listFromRows(ledgerRows, opts);
    }
    if (resource === 'settlement_batch_summary') {
      return listFromRows(settlementRows, opts);
    }
    return realListResource(resource, opts);
  });

  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
    if (resource === 'finance_events_ledger') {
      return listFromRows(ledgerRows, opts);
    }
    if (resource === 'settlement_batch_summary') {
      return listFromRows(settlementRows, opts);
    }
    return realCompleteList(resource, opts);
  });

  vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
    if (resource === 'clients') {
      return clientRows.find((row) => row.id === id) ?? null;
    }
    if (resource === 'marketplace_participants') {
      return partnerRows.find((row) => row.id === id) ?? null;
    }
    return realGetResource(resource, id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState(null, '', '/');
});

describe('LedgerModule COD/finance closeout actions', () => {
  it('per-row "Reverse" fires ui_reverse_finance_event_v1 with reason and event lineage', async () => {
    const spy = vi.spyOn(api, 'ui_reverse_finance_event_v1').mockResolvedValue({
      ok: true,
      finance_event_id: 'fe_reverse_test',
      reversed_finance_event_id: 'fel_1101',
      correlation_id: 'cor_test_reverse_1',
    } as Awaited<ReturnType<typeof api.ui_reverse_finance_event_v1>>);
    const promptSpy = vi.spyOn(window, 'prompt');

    const user = userEvent.setup();
    renderLedger();
    await waitFor(() => {
      expect(document.querySelectorAll('table').length).toBeGreaterThan(0);
      expect(screen.getByText('cod_collected_clearing')).toBeInTheDocument();
    });
    expect(screen.getAllByText('In').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Out').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2,110/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Direction unavailable')).not.toBeInTheDocument();

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /^Reverse/i }));

    const dialog = await screen.findByRole('dialog', { name: /Reverse ledger event - fel_1101/i });
    const reason = within(dialog).getByLabelText(/Reason/i);
    const submit = within(dialog).getByRole('button', { name: /Reverse event/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('title', 'Enter a reversal reason before submitting.');
    await user.type(reason, 'operator reversal reason');
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('Reversal confirmed')).toBeInTheDocument();
    expect(screen.getByText('fe_reverse_test')).toBeInTheDocument();
    expect(spy.mock.calls[0]![0]).toMatchObject({
      finance_event_id: 'fel_1101',
      finance_occurred_at: '2026-04-25T11:30:00Z',
      reason: 'operator reversal reason',
    });
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('keeps the operator on Ledger and shows reversal readback without reload', async () => {
    window.history.pushState(null, '', '/finance/ledger');
    let reversed = false;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      if (resource !== 'finance_events_ledger') return realListResource(resource, opts);
      return listFromRows(
        reversed
          ? [
              {
                id: 'fe_reverse_readback_1',
                occurred_at: '2026-05-17T07:45:00Z',
                account_id: 'cod_collected_clearing',
                direction: 'out',
                amount: 2110,
                event_type: 'adjustment',
                metadata: {
                  reverses_finance_event_id: 'fel_1101',
                  reversal_reason: 'duplicate ledger event',
                },
              },
              ...ledgerRows,
            ]
          : ledgerRows,
        opts,
      );
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      if (resource !== 'finance_events_ledger') return realCompleteList(resource, opts);
      return listFromRows(
        reversed
          ? [
              {
                id: 'fe_reverse_readback_1',
                occurred_at: '2026-05-17T07:45:00Z',
                account_id: 'cod_collected_clearing',
                direction: 'out',
                amount: 2110,
                event_type: 'adjustment',
                metadata: {
                  reverses_finance_event_id: 'fel_1101',
                  reversal_reason: 'duplicate ledger event',
                },
              },
              ...ledgerRows,
            ]
          : ledgerRows,
        opts,
      );
    });
    vi.spyOn(api, 'ui_reverse_finance_event_v1').mockImplementation(async () => {
      reversed = true;
      return {
        ok: true,
        finance_event_id: 'fe_reverse_readback_1',
        reversed_finance_event_id: 'fel_1101',
        correlation_id: 'cor_reverse_readback_1',
      } as Awaited<ReturnType<typeof api.ui_reverse_finance_event_v1>>;
    });

    const user = userEvent.setup();
    renderLedger();

    expect(await screen.findByText('cod_collected_clearing')).toBeInTheDocument();
    expect(screen.queryByText('fe_reverse_readback_1')).not.toBeInTheDocument();

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    await user.click(await screen.findByRole('option', { name: /^Reverse/i }));

    const dialog = await screen.findByRole('dialog', { name: /Reverse ledger event - fel_1101/i });
    await user.type(within(dialog).getByLabelText(/Reason/i), 'duplicate ledger event');
    await user.click(within(dialog).getByRole('button', { name: /Reverse event/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Reverse ledger event/i })).not.toBeInTheDocument();
      expect(screen.getByText('Reversal confirmed')).toBeInTheDocument();
      expect(screen.getByText('fe_reverse_readback_1')).toBeInTheDocument();
      expect(screen.getByText('adjustment')).toBeInTheDocument();
      expect(screen.getAllByText('cod_collected_clearing').length).toBeGreaterThanOrEqual(2);
    });
    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[1]!);
    const originalReverseOption = await screen.findByRole('option', { name: /^Reverse/i });
    expect(originalReverseOption).toHaveAttribute('aria-disabled', 'true');
    expect(originalReverseOption).toHaveTextContent(/already has a recorded reversal/i);
    expect(window.location.pathname).toBe('/finance/ledger');
  });

  it('keeps Reverse disabled when backend reversal readback exists outside the visible table rows', async () => {
    const reversalRow = {
      id: 'fe_reverse_hidden_from_filter',
      occurred_at: '2026-05-17T07:45:00Z',
      account_id: 'cod_collected_clearing',
      direction: 'out',
      amount: 2110,
      event_type: 'adjustment',
      metadata: {
        reverses_finance_event_id: 'fel_1101',
        reversal_reason: 'duplicate ledger event',
      },
    };
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'finance_events_ledger') return listFromRows(ledgerRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      return realListResource(resource, opts);
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'finance_events_ledger') return listFromRows([reversalRow, ...ledgerRows], opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      return realCompleteList(resource, opts);
    });
    const spy = vi.spyOn(api, 'ui_reverse_finance_event_v1');

    const user = userEvent.setup();
    renderLedger();

    await waitFor(() => {
      expect(screen.getByText('cod_collected_clearing')).toBeInTheDocument();
    });
    expect(screen.queryByText('fe_reverse_hidden_from_filter')).not.toBeInTheDocument();

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    const reverseOption = await screen.findByRole('option', { name: /^Reverse/i });
    expect(reverseOption).toHaveAttribute('aria-disabled', 'true');
    expect(reverseOption).toHaveTextContent(/already has a recorded reversal/i);
    await user.click(reverseOption);

    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps per-row Reverse inert when only finance.read is held', async () => {
    const spy = vi.spyOn(api, 'ui_reverse_finance_event_v1');

    const user = userEvent.setup();
    renderLedger(['finance.read']);
    await waitFor(() => {
      expect(screen.getByText('cod_collected_clearing')).toBeInTheDocument();
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const reverseOption = await screen.findByRole('option', { name: /^Reverse/i });
    expect(reverseOption).toHaveAttribute('aria-disabled', 'true');
    expect(reverseOption).toHaveTextContent(/Finance update/i);
    await user.click(reverseOption);

    expect(spy).not.toHaveBeenCalled();
  });

  it('exports selected ledger rows as CSV while keeping read-only Reverse inert', async () => {
    const reverseSpy = vi.spyOn(api, 'ui_reverse_finance_event_v1');
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const createObjectUrlSpy = vi.fn((_blob: Blob) => 'blob:ledger-export-test');
    const revokeObjectUrlSpy = vi.fn();
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const originalRequestAnimationFrame = window.requestAnimationFrame;

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrlSpy,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrlSpy,
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });

    try {
      const user = userEvent.setup();
      renderLedger(['finance.read']);
      await waitFor(() => {
        expect(screen.getByText('cod_collected_clearing')).toBeInTheDocument();
      });

      await user.click(screen.getAllByLabelText('Select row')[0]!);
      expect(screen.getByText('1 selected')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Export ledger/i }));

      expect(anchorClickSpy).toHaveBeenCalledTimes(1);
      expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
      const csvBlob = createObjectUrlSpy.mock.calls[0]![0] as Blob;
      const csv = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Unable to read ledger CSV blob'));
        reader.readAsText(csvBlob);
      });
      expect(csv).toContain(
        'id,occurred_at,account_id,direction,amount,event_type,batch_id',
      );
      expect(csv).toContain(
        'fel_1101,2026-04-25T11:30:00Z,cod_collected_clearing,in,2110,cod_collected,',
      );
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:ledger-export-test');

      await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
      const reverseOption = await screen.findByRole('option', { name: /^Reverse/i });
      expect(reverseOption).toHaveAttribute('aria-disabled', 'true');
      expect(reverseOption).toHaveTextContent(/Finance update/i);
      await user.click(reverseOption);

      expect(reverseSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: originalRequestAnimationFrame,
      });
    }
  });

  it('keeps Reverse disabled for settlement-linked ledger events', async () => {
    const spy = vi.spyOn(api, 'ui_reverse_finance_event_v1');

    const user = userEvent.setup();
    renderLedger();
    await waitFor(() => {
      expect(screen.getByText('client_examplemarket_ksa_receivable')).toBeInTheDocument();
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[1]!);
    const reverseOption = await screen.findByRole('option', { name: /^Reverse/i });
    expect(reverseOption).toHaveAttribute('aria-disabled', 'true');
    expect(reverseOption).toHaveTextContent(/settlement batch workflow/i);
    await user.click(reverseOption);

    expect(spy).not.toHaveBeenCalled();
  });

  it('uses the active tenant scope for ledger row action eligibility', async () => {
    const spy = vi.spyOn(api, 'ui_reverse_finance_event_v1').mockResolvedValue({
      ok: true,
      finance_event_id: 'fe_active_tenant_reverse',
      reversed_finance_event_id: 'fel_active_tenant_1',
      correlation_id: 'cor_active_tenant_reverse',
    } as Awaited<ReturnType<typeof api.ui_reverse_finance_event_v1>>);
    const activeTenantRows = [
      {
        id: 'fel_active_tenant_1',
        occurred_at: '2026-04-26T08:00:00Z',
        organization_id: 'org_rashed',
        account_id: 'cod_collected_clearing',
        direction: 'in',
        amount: 2110,
        event_type: 'cod_collected',
        metadata: {},
      },
    ];
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'finance_events_ledger') return listFromRows(activeTenantRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      return realListResource(resource, opts);
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'finance_events_ledger') return listFromRows(activeTenantRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<LedgerModule />, {
      capabilities: ['finance.read', 'finance.write'],
      identity: {
        capabilities: ['finance.read', 'finance.write'],
        user: { organization_id: 'org_platform_home', access_scope_type: 'platform' },
        scope: { tenant: { id: 'org_rashed', label: 'First Tenant', rank: 2 } },
      },
    });

    await waitFor(() => {
      expect(screen.getByText('cod_collected_clearing')).toBeInTheDocument();
    });
    expect(await screen.findByTitle('Resolved from tenant scope')).toBeInTheDocument();

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    const reverseOption = await screen.findByRole('option', { name: /^Reverse/i });
    expect(reverseOption).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(reverseOption);

    const dialog = await screen.findByRole('dialog', { name: /Reverse ledger event - fel_active_tenant_1/i });
    expect(dialog).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/i), 'active tenant reversal reason');
    await user.click(within(dialog).getByRole('button', { name: /Reverse event/i }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]![0]).toMatchObject({
      organization_id: 'org_rashed',
      finance_event_id: 'fel_active_tenant_1',
      finance_occurred_at: '2026-04-26T08:00:00Z',
      reason: 'active tenant reversal reason',
    });
  });

  it('keeps Reverse disabled when the ledger row belongs to a different tenant than the active operator scope', async () => {
    const spy = vi.spyOn(api, 'ui_reverse_finance_event_v1');
    const crossTenantRows = [
      {
        id: 'fel_cross_tenant_1',
        occurred_at: '2026-04-26T08:00:00Z',
        organization_id: 'org_other_tenant',
        account_id: 'cod_collected_clearing',
        direction: 'in',
        amount: 2110,
        event_type: 'cod_collected',
        metadata: {},
      },
    ];
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'finance_events_ledger') return listFromRows(crossTenantRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      return realListResource(resource, opts);
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'finance_events_ledger') return listFromRows(crossTenantRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderLedger();
    await waitFor(() => {
      expect(screen.getByText('cod_collected_clearing')).toBeInTheDocument();
    });

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    const reverseOption = await screen.findByRole('option', { name: /^Reverse/i });
    expect(reverseOption).toHaveAttribute('aria-disabled', 'true');
    expect(reverseOption).toHaveTextContent(/Switch to this ledger row's tenant before reversing/i);
    await user.click(reverseOption);

    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps Reverse disabled for ledger rows that are already reversal events', async () => {
    const spy = vi.spyOn(api, 'ui_reverse_finance_event_v1');
    const reversalLedgerRows = [
      {
        id: 'fel_reverse_1',
        occurred_at: '2026-04-26T08:00:00Z',
        account_id: 'reversal_clearing',
        direction: 'out',
        amount: 2110,
        event_type: 'adjustment',
        metadata: {
          reversal: true,
          reverses_finance_event_id: 'fel_1101',
          reversal_reason: 'duplicate ledger event',
        },
      },
      ...ledgerRows,
    ];
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'finance_events_ledger') return listFromRows(reversalLedgerRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      return realListResource(resource, opts);
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'finance_events_ledger') return listFromRows(reversalLedgerRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(settlementRows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderLedger();
    await waitFor(() => {
      expect(screen.getByText('reversal_clearing')).toBeInTheDocument();
    });

    const row = screen.getByText('reversal_clearing').closest('tr') as HTMLElement | null;
    expect(row).not.toBeNull();
    await user.click(within(row!).getByRole('button', { name: /Row actions/ }));
    const reverseOption = await screen.findByRole('option', { name: /^Reverse/i });
    expect(reverseOption).toHaveAttribute('aria-disabled', 'true');
    expect(reverseOption).toHaveTextContent(/already a reversal event/i);
    await user.click(reverseOption);

    expect(spy).not.toHaveBeenCalled();
  });

  it('scopes ledger rows from client query params through settlement batch lineage', async () => {
    window.history.pushState(null, '', '/finance/ledger?client=cl_exampleparcel_ksa');

    renderLedger();

    await waitFor(() => {
      expect(screen.getByText('Scoped client Exampleparcel KSA')).toBeInTheDocument();
      expect(screen.getByText('client_examplemarket_ksa_receivable')).toBeInTheDocument();
      expect(screen.getAllByText('sb_4518').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('partner_exampledepot_payable')).not.toBeInTheDocument();
    expect(screen.queryByText('sb_4517')).not.toBeInTheDocument();
  });

  it('resolves the scoped client label from clients when the ledger scope is empty', async () => {
    window.history.pushState(null, '', `/finance/ledger?client=${emptyScopedClientId}`);

    renderLedger();

    await waitFor(() => {
      expect(screen.getByText('Scoped client Live Empty Ledger Client')).toBeInTheDocument();
    });
    expect(screen.queryByText('client_examplemarket_ksa_receivable')).not.toBeInTheDocument();
    expect(screen.queryByText('partner_exampledepot_payable')).not.toBeInTheDocument();
  });

  it('keeps scoped ledger readable when client label readback is denied', async () => {
    vi.mocked(api.ui_get_resource_v1).mockImplementation(async (resource, id) => {
      if (resource === 'clients') {
        throw Object.assign(new Error('Capability denied: clients.read'), {
          code: 'capability_denied',
          capability: 'clients.read',
        });
      }
      return realGetResource(resource, id);
    });
    window.history.pushState(null, '', `/finance/ledger?client=${emptyScopedClientId}`);

    renderLedger(['finance.read']);

    await waitFor(() => {
      expect(screen.getByText('Scoped client selected client')).toBeInTheDocument();
    });
    expect(screen.queryByText('client_examplemarket_ksa_receivable')).not.toBeInTheDocument();
  });

  it('scopes ledger rows from partner query params through settlement batch lineage', async () => {
    window.history.pushState(null, '', '/finance/ledger?partner=mpp_exampledepot');

    renderLedger();

    await waitFor(() => {
      expect(screen.getByText('Scoped partner Exampledepot')).toBeInTheDocument();
      expect(screen.getByText('partner_exampledepot_payable')).toBeInTheDocument();
      expect(screen.getAllByText('sb_4517').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('client_examplemarket_ksa_receivable')).not.toBeInTheDocument();
    expect(screen.queryByText('sb_4518')).not.toBeInTheDocument();
  });

  it('resolves the scoped partner label from marketplace participants when the ledger scope is empty', async () => {
    window.history.pushState(null, '', `/finance/ledger?partner=${emptyScopedPartnerId}`);

    renderLedger();

    await waitFor(() => {
      expect(screen.getByText('Scoped partner Live Empty Ledger Partner')).toBeInTheDocument();
    });
    expect(screen.queryByText('client_examplemarket_ksa_receivable')).not.toBeInTheDocument();
    expect(screen.queryByText('partner_exampledepot_payable')).not.toBeInTheDocument();
  });
});
