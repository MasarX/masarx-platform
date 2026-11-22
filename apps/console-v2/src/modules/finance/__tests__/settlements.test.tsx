// settlements.test.tsx — covers SettlementsModule wiring through Phase B5
// canonical RPCs (CLAIM-FINANCE-WIRING / Phase C4).
//
// Asserts mutation-wiring contract:
//   • Mount + kanban renders rows from `settlement_batches`.
//   • Approve button on a Locked card fires `apply_settlement_v1` with the
//     canonical payload `{ settlement_batch_id }` and invalidates
//     `qk.list('settlement_batches')` on success.
//   • Reject button fires `reject_settlement_v1` with `{ settlement_batch_id,
//     rejection_reason }` after operator supplies a reason.
//   • Capability gate `settlements.write` disables Approve / Reject when missing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { SettlementsModule } from '../settlements';
import * as api from '@/lib/api';
import { getLookups } from '@/lib/data-source';

const realCompleteList = api.ui_list_resource_complete;
const realGetResource = api.ui_get_resource_v1;
const emptyScopedClientId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
const emptyScopedPartnerId = '22222222-2222-4222-8222-222222222222';

const settlementBatchRows = [
  {
    id: 'sb_4521',
    organization_id: 'org_rashed',
    kind: 'cod',
    scope_type: 'driver_shift',
    status: 'open',
    updated_at: '2026-04-25T11:48:00Z',
  },
  {
    id: 'sb_4518',
    organization_id: 'org_rashed',
    kind: 'cod',
    scope_type: 'client_cycle',
    client_id: 'cl_exampleparcel_ksa',
    sender_id: 'sender_exampleparcel_ksa',
    status: 'locked',
    updated_at: '2026-04-25T10:48:00Z',
  },
  {
    id: 'sb_4517',
    organization_id: 'org_rashed',
    kind: 'cod',
    scope_type: 'partner_cycle',
    partner_id: 'mpp_exampledepot',
    status: 'approved',
    updated_at: '2026-04-25T09:48:00Z',
  },
];

const settlementSummaryRows = settlementBatchRows.map((row, index) => ({
  ...row,
  expected_amount: [4820, 3250, 8100][index] ?? 0,
  collected_amount: [4820, 3200, 8100][index] ?? 0,
  remitted_amount: [0, 3000, 8100][index] ?? 0,
  variance_flag: index === 1,
  posted_at: null,
}));

const branchRows = [
  { id: 'br_riyadh', organization_id: 'org_rashed', code: 'RUH', name: 'Riyadh branch', is_active: true },
  { id: 'br_other', organization_id: 'org_other', code: 'RUH', name: 'Other tenant branch', is_active: true },
];

const clientRows = [
  { id: 'cl_retail', organization_id: 'org_rashed', name: 'First Tenant Retail Client', status: 'active' },
  { id: 'cl_exampleparcel_ksa', organization_id: 'org_rashed', name: 'Exampleparcel KSA', status: 'active' },
  { id: emptyScopedClientId, organization_id: 'org_rashed', name: 'Live Empty Settlement Client', status: 'active' },
];

const partnerRows = [
  { id: 'mpp_exampledepot', name: 'Exampledepot', display_name: 'Exampledepot', status: 'approved' },
  { id: emptyScopedPartnerId, display_name: 'Live Empty Settlement Partner', status: 'approved' },
];

const driverRows = [
  {
    id: 'drv_profile_1',
    organization_id: 'org_rashed',
    user_id: 'usr_driver_1',
    user_full_name: 'Khalid Al-Otaibi',
    driver_code: 'DRV-001',
    is_active: true,
    status: 'active',
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

function renderSettlements(capabilities = ['settlements.read', 'settlements.write']) {
  return renderWithProviders(<SettlementsModule />, { capabilities });
}

async function waitForLookups(category: string) {
  const deadline = Date.now() + 1000;
  while (getLookups(category).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  await Promise.all([
    waitForLookups('settlement_status'),
    waitForLookups('settlement_batch_transition_action'),
    waitForLookups('settlement_kind'),
    waitForLookups('settlement_scope_type'),
  ]);

  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
    if (resource === 'settlement_batches') {
      return listFromRows(settlementBatchRows, opts);
    }
    if (resource === 'settlement_batch_summary') {
      return listFromRows(settlementSummaryRows, opts);
    }
    if (resource === 'branches') return listFromRows(branchRows, opts);
    if (resource === 'clients') return listFromRows(clientRows, opts);
    if (resource === 'drivers') return listFromRows(driverRows, opts);
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

describe('SettlementsModule (CLAIM-FINANCE-WIRING — Phase B5/C4)', () => {
  it('mounts with kanban populated from settlement_batches', async () => {
    renderSettlements();
    await waitFor(() => {
      // W11-1: kanban now renders the canonical settlement_batches.id
      // (sb_*) instead of the legacy `batch_id` (BAT-*) FE alias.
      expect(screen.getAllByText(/sb_/).length).toBeGreaterThan(0);
    });
  });

  it('uses the active tenant scope for settlement policy and operator context', async () => {
    const settingsSpy = vi.spyOn(api, 'resolveSettings');

    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
      identity: {
        capabilities: ['settlements.read', 'settlements.write'],
        user: { organization_id: 'org_platform_home', access_scope_type: 'platform' },
        scope: { tenant: { id: 'org_rashed', label: 'First Tenant', rank: 2 } },
      },
    });

    await waitFor(() => {
      expect(screen.getAllByText(/sb_/).length).toBeGreaterThan(0);
    });
    expect(await screen.findByTitle('Resolved from tenant scope')).toBeInTheDocument();
    expect(settingsSpy).toHaveBeenCalledWith(
      'settlement_policy',
      expect.objectContaining({
        organization_id: 'org_rashed',
        tenant: expect.objectContaining({ id: 'org_rashed' }),
      }),
    );
  });

  it('disables Approve + Reject when only settlements.read is held', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, { capabilities: ['settlements.read'] });
    await waitFor(() => {
      // W11-1: kanban now renders the canonical settlement_batches.id
      // (sb_*) instead of the legacy `batch_id` (BAT-*) FE alias.
      expect(screen.getAllByText(/sb_/).length).toBeGreaterThan(0);
    });
    // Click any locked-stage card to open the drawer (kanban__card -> openCardDrawer).
    const cards = document.querySelectorAll('.kanban__card');
    expect(cards.length).toBeGreaterThan(0);
    await user.click(cards[0] as HTMLElement);
    const approveBtn = await screen.findByRole('button', {
      name: /Approve.*Settlement update permission required/i,
    });
    expect(approveBtn).toBeDisabled();
    const rejectBtn = screen.getByRole('button', {
      name: /Reject.*Settlement update permission required/i,
    });
    expect(rejectBtn).toBeDisabled();
  });

  it('keeps settlement create action inert when settlements.write is missing', async () => {
    const createSpy = vi.spyOn(api, 'ui_create_settlement_batch_v1').mockResolvedValue({
      ok: true,
      settlement_batch_id: 'sb_denied_create',
      settlement_event_id: 'se_denied_create',
      correlation_id: 'cor_denied',
      status: 'open',
      version: 1,
    } as Awaited<ReturnType<typeof api.ui_create_settlement_batch_v1>>);

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, { capabilities: ['settlements.read'] });

    const newBatchButton = await screen.findByRole('button', {
      name: /New batch.*Settlement update permission required/i,
    });
    expect(newBatchButton).toBeDisabled();
    await user.click(newBatchButton);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('keeps cross-tenant settlement lifecycle actions inspectable but not mutable', async () => {
    const transitionSpy = vi.spyOn(api, 'ui_transition_settlement_batch_v1');
    const applySpy = vi.spyOn(api, 'apply_settlement_v1');
    const rejectSpy = vi.spyOn(api, 'reject_settlement_v1');
    const crossTenantRows = [
      {
        id: 'sb_cross_tenant',
        organization_id: 'org_other_tenant',
        kind: 'cod',
        scope_type: 'driver_shift',
        status: 'open',
        updated_at: '2026-04-25T11:48:00Z',
      },
    ];
    const crossTenantSummary = crossTenantRows.map((row) => ({
      ...row,
      expected_amount: 100,
      collected_amount: 100,
      remitted_amount: 0,
      variance_flag: false,
      posted_at: null,
    }));
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'settlement_batches') return listFromRows(crossTenantRows, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(crossTenantSummary, opts);
      if (resource === 'branches') return listFromRows(branchRows, opts);
      if (resource === 'clients') return listFromRows(clientRows, opts);
      if (resource === 'drivers') return listFromRows(driverRows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    const batchId = await screen.findByText('sb_cross_tenant');
    await user.click(batchId.closest('.kanban__card') as HTMLElement);

    const tenantReason = "Switch to this settlement batch's tenant before changing settlement lifecycle.";
    const lockBtn = await screen.findByRole('button', { name: 'Lock' });
    const approveBtn = await screen.findByRole('button', { name: 'Approve' });
    const rejectBtn = await screen.findByRole('button', { name: 'Reject' });
    for (const button of [lockBtn, approveBtn, rejectBtn]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', tenantReason);
      await user.click(button);
    }

    expect(screen.queryByRole('dialog', { name: /Reject settlement batch/i })).not.toBeInTheDocument();
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
    expect(rejectSpy).not.toHaveBeenCalled();
  });

  it('keeps Approve disabled while a settlement is still open', async () => {
    const spy = vi.spyOn(api, 'apply_settlement_v1');
    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    const openBatchId = await screen.findByText('sb_4521');
    const openCard = openBatchId.closest('.kanban__card');
    expect(openCard).toBeTruthy();

    await user.click(openCard as HTMLElement);
    const approveBtn = await screen.findByRole('button', { name: 'Approve' });
    expect(approveBtn).toBeDisabled();
    expect(approveBtn).toHaveAttribute(
      'title',
      'This settlement status does not allow approval.',
    );
    await user.click(approveBtn);

    expect(spy).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Lock' })).toBeEnabled();
  });

  it('Approve fires apply_settlement_v1 from locked settlements with the canonical payload + invalidates settlement_batches', async () => {
    const spy = vi.spyOn(api, 'apply_settlement_v1').mockResolvedValue({
      ok: true,
      settlement_batch_id: 'batch_test_1',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      version: 2,
      status: 'approved',
    } as Awaited<ReturnType<typeof api.apply_settlement_v1>>);
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.kanban__card').length).toBeGreaterThan(0);
    });
    const invSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const lockedBatchId = await screen.findByText('sb_4518');
    const lockedCard = lockedBatchId.closest('.kanban__card');
    expect(lockedCard).toBeTruthy();
    await user.click(lockedCard as HTMLElement);
    const approveBtn = await screen.findByRole('button', { name: 'Approve' });
    expect(approveBtn).toBeEnabled();
    await user.click(approveBtn);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('settlement_batch_id');
    expect(typeof payload.settlement_batch_id).toBe('string');
    // Cache invalidation: list('settlement_batches') refetches.
    await waitFor(() => {
      const calls = invSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('settlement_batches'))).toBe(true);
    });
  });

  it('Reject captures a visible reason then fires reject_settlement_v1 with canonical payload', async () => {
    const spy = vi.spyOn(api, 'reject_settlement_v1').mockResolvedValue({
      ok: true,
      settlement_batch_id: 'batch_test_2',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      version: 2,
      status: 'canceled',
    } as Awaited<ReturnType<typeof api.reject_settlement_v1>>);

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.kanban__card').length).toBeGreaterThan(0);
    });
    const cards = document.querySelectorAll('.kanban__card');
    await user.click(cards[0] as HTMLElement);
    const rejectBtn = await screen.findByRole('button', { name: 'Reject' });
    await user.click(rejectBtn);
    const reasonInput = await screen.findByLabelText('Rejection reason');
    await user.type(reasonInput, 'Variance over threshold');
    await user.click(screen.getByRole('button', { name: 'Reject batch' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('settlement_batch_id');
    expect(payload.rejection_reason).toBe('Variance over threshold');
  });

  it('Reject without a reason stays disabled and does not fire RPC', async () => {
    const spy = vi.spyOn(api, 'reject_settlement_v1');

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.kanban__card').length).toBeGreaterThan(0);
    });
    const cards = document.querySelectorAll('.kanban__card');
    await user.click(cards[0] as HTMLElement);
    const rejectBtn = await screen.findByRole('button', { name: 'Reject' });
    await user.click(rejectBtn);

    const submitButton = await screen.findByRole('button', { name: 'Reject batch' });
    expect(submitButton).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('human-click reject shows backend status reason in the same drawer without reload', async () => {
    let liveBatches: Array<Record<string, unknown>> = settlementBatchRows.map((row) => ({ ...row }));
    let liveSummary: Array<Record<string, unknown>> = settlementSummaryRows.map((row) => ({ ...row }));
    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'settlement_batches') return listFromRows(liveBatches, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(liveSummary, opts);
      if (resource === 'branches') return listFromRows(branchRows, opts);
      if (resource === 'clients') return listFromRows(clientRows, opts);
      if (resource === 'drivers') return listFromRows(driverRows, opts);
      return realCompleteList(resource, opts);
    });
    completeSpy.mockClear();

    const rejectSpy = vi.spyOn(api, 'reject_settlement_v1').mockImplementation(async (args) => {
      liveBatches = liveBatches.map((row) =>
        row.id === args.settlement_batch_id
          ? { ...row, status: 'canceled', status_reason: args.rejection_reason }
          : row,
      );
      liveSummary = liveSummary.map((row) =>
        row.id === args.settlement_batch_id ? { ...row, status: 'canceled' } : row,
      );
      return {
        ok: true,
        settlement_batch_id: args.settlement_batch_id,
        correlation_id: 'cor_live_click_reject',
        settings_resolution_id: 'srlv_live_click_reject',
        status: 'canceled',
        version: 2,
      } as Awaited<ReturnType<typeof api.reject_settlement_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    const openBatchId = await screen.findByText('sb_4521');
    const openCard = openBatchId.closest('.kanban__card');
    expect(openCard).toBeTruthy();
    const pathBefore = window.location.pathname;
    await user.click(openCard as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const submitButton = await screen.findByRole('button', { name: 'Reject batch' });
    expect(submitButton).toBeDisabled();
    await user.type(await screen.findByLabelText('Rejection reason'), 'Variance over threshold');
    await user.click(submitButton);

    await waitFor(() => {
      expect(rejectSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('Status reason')).toBeInTheDocument();
      expect(screen.getByText('Variance over threshold')).toBeInTheDocument();
      expect(screen.getAllByText('Canceled').length).toBeGreaterThan(0);
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'settlement_batches').length,
    ).toBeGreaterThan(1);
  });

  it('keeps Reject disabled after a settlement is approved', async () => {
    const spy = vi.spyOn(api, 'reject_settlement_v1');

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    const approvedBatchId = await screen.findByText('sb_4517');
    const approvedCard = approvedBatchId.closest('.kanban__card');
    expect(approvedCard).toBeTruthy();

    await user.click(approvedCard as HTMLElement);
    const rejectBtn = await screen.findByRole('button', { name: 'Reject' });
    expect(rejectBtn).toBeDisabled();
    expect(rejectBtn).toHaveAttribute(
      'title',
      'This settlement status does not allow rejection.',
    );
    await user.click(rejectBtn);

    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Reject settlement batch/i })).not.toBeInTheDocument();
  });

  it('New batch fires ui_create_settlement_batch_v1 with canonical payload', async () => {
    const spy = vi.spyOn(api, 'ui_create_settlement_batch_v1').mockResolvedValue({
      ok: true,
      settlement_batch_id: 'sb_test_new',
      settlement_event_id: 'se_test_new',
      correlation_id: 'cor_test',
      status: 'open',
      version: 1,
    } as Awaited<ReturnType<typeof api.ui_create_settlement_batch_v1>>);

    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.kanban__card').length).toBeGreaterThan(0);
    });
    const invSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(screen.getByRole('button', { name: 'New batch' }));
    const openButton = await screen.findByRole('button', { name: 'Open batch' });
    expect(openButton).toBeDisabled();
    const driverPicker = screen.getByLabelText('Driver');
    await waitFor(() => expect(driverPicker).toBeEnabled());
    await user.selectOptions(driverPicker, 'usr_driver_1');
    await user.click(openButton);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toMatchObject({
      subject_type: 'driver',
      subject_id: 'usr_driver_1',
      metadata: { source: 'console-v2/finance/settlements' },
    });
    expect(payload.scope_type).toBeTruthy();
    expect(payload.window_start_at).toMatch(/T00:00:00\.000Z$/);
    await waitFor(() => {
      const calls = invSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('settlement_batches'))).toBe(true);
      expect(calls.some((c) => c.includes('settlement_batch_summary'))).toBe(true);
    });
  });

  it('New batch scope context is row-driven and changes required picker with scope type', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.kanban__card').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('button', { name: 'New batch' }));
    expect(await screen.findByLabelText('Driver')).toBeInTheDocument();
    expect(screen.queryByLabelText('Client')).not.toBeInTheDocument();

    const scopePicker = screen.getByLabelText('Scope');
    await user.selectOptions(scopePicker, 'client_cycle');
    await waitFor(() => expect(scopePicker).toHaveValue('client_cycle'));
    const clientPicker = screen.getByLabelText('Client');
    expect(clientPicker).toBeInTheDocument();
    expect(screen.queryByLabelText('Driver')).not.toBeInTheDocument();

    await waitFor(() => expect(clientPicker).toBeEnabled());
    await user.selectOptions(clientPicker, 'cl_retail');
    const openButton = await screen.findByRole('button', { name: 'Open batch' });
    expect(openButton).toBeEnabled();
  });

  it('New batch branch context is scoped to the active tenant before opening', async () => {
    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockClear();

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.kanban__card').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('button', { name: 'New batch' }));
    const scopePicker = screen.getByLabelText('Scope');
    await user.selectOptions(scopePicker, 'branch_day');
    await waitFor(() => expect(scopePicker).toHaveValue('branch_day'));
    const branchPicker = screen.getByLabelText('Branch');
    await waitFor(() => expect(branchPicker).toBeEnabled());

    expect(branchPicker).toHaveTextContent('Riyadh branch - RUH');
    expect(branchPicker).not.toHaveTextContent('Other tenant branch');
    expect(
      completeSpy.mock.calls.some(
        ([resource, opts]) =>
          resource === 'branches' &&
          (opts?.filter as Record<string, unknown> | undefined)?.organization_id === 'org_rashed',
      ),
    ).toBe(true);

    await user.selectOptions(branchPicker, 'br_riyadh');
    expect(await screen.findByRole('button', { name: 'Open batch' })).toBeEnabled();
  });

  it('New batch only offers scope types allowed by settlement_policy.batch_scopes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.kanban__card').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('button', { name: 'New batch' }));
    const scopePicker = (await screen.findByLabelText('Scope')) as HTMLSelectElement;
    const values = Array.from(scopePicker.options).map((option) => option.value);

    expect(values).toContain('driver_shift');
    expect(values).toContain('branch_day');
    expect(values).toContain('client_cycle');
    expect(values).not.toContain('accounting_period');
  });

  it('human-click new batch flow reads the opened batch back into the same board without reload', async () => {
    let liveBatches: Array<Record<string, unknown>> = settlementBatchRows.map((row) => ({ ...row }));
    let liveSummary: Array<Record<string, unknown>> = settlementSummaryRows.map((row) => ({ ...row }));

    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'settlement_batches') return listFromRows(liveBatches, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(liveSummary, opts);
      if (resource === 'branches') return listFromRows(branchRows, opts);
      if (resource === 'clients') return listFromRows(clientRows, opts);
      if (resource === 'drivers') return listFromRows(driverRows, opts);
      return realCompleteList(resource, opts);
    });
    completeSpy.mockClear();

    const createSpy = vi.spyOn(api, 'ui_create_settlement_batch_v1').mockImplementation(async (args) => {
      const openedAt = '2026-05-16T11:00:00Z';
      const batch = {
        id: 'sb_live_click_new',
        organization_id: 'org_rashed',
        kind: args.kind,
        scope_type: args.scope_type,
        status: 'open',
        subject_type: args.subject_type,
        subject_id: args.subject_id,
        updated_at: openedAt,
        metadata: { source: 'human_click_readback_test' },
      };
      const summary = {
        ...batch,
        expected_amount: 0,
        collected_amount: 0,
        remitted_amount: 0,
        variance_flag: false,
        posted_at: null,
      };
      liveBatches = [batch, ...liveBatches];
      liveSummary = [summary, ...liveSummary];
      return {
        ok: true,
        settlement_batch_id: batch.id,
        settlement_event_id: 'se_live_click_new',
        correlation_id: 'cor_live_click',
        status: 'open',
        version: 1,
      } as Awaited<ReturnType<typeof api.ui_create_settlement_batch_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.kanban__card').length).toBeGreaterThan(0);
    });
    const pathBefore = window.location.pathname;

    await user.click(await screen.findByRole('button', { name: 'New batch' }));
    await screen.findByLabelText('Kind');
    await screen.findByLabelText('Scope');
    const driverPicker = screen.getByLabelText('Driver');
    await waitFor(() => expect(driverPicker).toBeEnabled());
    await user.selectOptions(driverPicker, 'usr_driver_1');
    await user.click(await screen.findByRole('button', { name: 'Open batch' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(createSpy.mock.calls[0]![0]).toMatchObject({
      subject_type: 'driver',
      subject_id: 'usr_driver_1',
    });
    await waitFor(() => {
      expect(screen.getAllByText('sb_live_click_new').length).toBeGreaterThan(0);
    });
    const createdDrawer = await screen.findByRole('dialog', { name: 'sb_live_click_new' });
    expect(within(createdDrawer).getByText('Status')).toBeInTheDocument();
    expect(within(createdDrawer).getAllByText('Open').length).toBeGreaterThan(0);
    expect(within(createdDrawer).getByText('Operational backing')).toBeInTheDocument();
    expect(within(createdDrawer).getByText('Settlement summary')).toBeInTheDocument();
    expect(within(createdDrawer).getByText('Settlement workflow')).toBeInTheDocument();
    expect(within(createdDrawer).getByRole('button', { name: 'Lock' })).toBeEnabled();
    expect(within(createdDrawer).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(within(createdDrawer).getByRole('button', { name: 'Reject' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Open batch' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'settlement_batch_summary').length,
    ).toBeGreaterThan(1);
  });

  it('human-click transition keeps the batch drawer open with backend readback without reload', async () => {
    let liveBatches: Array<Record<string, unknown>> = settlementBatchRows.map((row) => ({ ...row }));
    let liveSummary: Array<Record<string, unknown>> = settlementSummaryRows.map((row) => ({ ...row }));
    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'settlement_batches') return listFromRows(liveBatches, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(liveSummary, opts);
      if (resource === 'branches') return listFromRows(branchRows, opts);
      if (resource === 'clients') return listFromRows(clientRows, opts);
      if (resource === 'drivers') return listFromRows(driverRows, opts);
      return realCompleteList(resource, opts);
    });
    completeSpy.mockClear();

    const transitionSpy = vi.spyOn(api, 'ui_transition_settlement_batch_v1').mockImplementation(async (args) => {
      liveBatches = liveBatches.map((row) =>
        row.id === args.settlement_batch_id ? { ...row, status: args.to_status } : row,
      );
      liveSummary = liveSummary.map((row) =>
        row.id === args.settlement_batch_id ? { ...row, status: args.to_status } : row,
      );
      return {
        ok: true,
        settlement_batch_id: args.settlement_batch_id,
        settlement_event_id: 'se_live_click_lock',
        correlation_id: 'cor_live_click_lock',
        status: args.to_status,
        version: 2,
      } as Awaited<ReturnType<typeof api.ui_transition_settlement_batch_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    const openBatchId = await screen.findByText('sb_4521');
    const openCard = openBatchId.closest('.kanban__card');
    expect(openCard).toBeTruthy();
    const pathBefore = window.location.pathname;
    await user.click(openCard as HTMLElement);
    expect(await screen.findByText('Operational backing')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Lock' }));

    await waitFor(() => {
      expect(transitionSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('Operational backing')).toBeInTheDocument();
      expect(screen.getAllByText('sb_4521').length).toBeGreaterThan(0);
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'settlement_batch_summary').length,
    ).toBeGreaterThan(1);
  });

  it('human-click approve keeps the locked batch drawer open with backend readback without reload', async () => {
    let liveBatches: Array<Record<string, unknown>> = settlementBatchRows.map((row) => ({ ...row }));
    let liveSummary: Array<Record<string, unknown>> = settlementSummaryRows.map((row) => ({ ...row }));
    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'settlement_batches') return listFromRows(liveBatches, opts);
      if (resource === 'settlement_batch_summary') return listFromRows(liveSummary, opts);
      if (resource === 'branches') return listFromRows(branchRows, opts);
      if (resource === 'clients') return listFromRows(clientRows, opts);
      if (resource === 'drivers') return listFromRows(driverRows, opts);
      return realCompleteList(resource, opts);
    });
    completeSpy.mockClear();

    const applySpy = vi.spyOn(api, 'apply_settlement_v1').mockImplementation(async (args) => {
      liveBatches = liveBatches.map((row) =>
        row.id === args.settlement_batch_id ? { ...row, status: 'approved' } : row,
      );
      liveSummary = liveSummary.map((row) =>
        row.id === args.settlement_batch_id ? { ...row, status: 'approved' } : row,
      );
      return {
        ok: true,
        settlement_batch_id: args.settlement_batch_id,
        correlation_id: 'cor_live_click_apply',
        settings_resolution_id: 'srlv_live_click_apply',
        status: 'approved',
        version: 2,
      } as Awaited<ReturnType<typeof api.apply_settlement_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    const lockedBatchId = await screen.findByText('sb_4518');
    const lockedCard = lockedBatchId.closest('.kanban__card');
    expect(lockedCard).toBeTruthy();
    const pathBefore = window.location.pathname;
    await user.click(lockedCard as HTMLElement);
    expect(await screen.findByText('Operational backing')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(applySpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('Operational backing')).toBeInTheDocument();
      expect(screen.getAllByText('sb_4518').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Approved').length).toBeGreaterThan(0);
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'settlement_batch_summary').length,
    ).toBeGreaterThan(1);
  });

  it('Configured settlement transition fires ui_transition_settlement_batch_v1', async () => {
    const spy = vi.spyOn(api, 'ui_transition_settlement_batch_v1').mockResolvedValue({
      ok: true,
      settlement_batch_id: 'sb_4521',
      settlement_event_id: 'se_test_lock',
      correlation_id: 'cor_test',
      status: 'locked',
      version: 2,
    } as Awaited<ReturnType<typeof api.ui_transition_settlement_batch_v1>>);

    const user = userEvent.setup();
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read', 'settlements.write'],
    });
    const openBatchId = await screen.findByText('sb_4521');
    const openCard = openBatchId.closest('.kanban__card');
    expect(openCard).toBeTruthy();
    await user.click(openCard as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Lock' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]![0]).toMatchObject({
      settlement_batch_id: 'sb_4521',
      to_status: 'locked',
      payload: {
        action_key: 'lock',
        source: 'console-v2/finance/settlements',
      },
    });
  });

  // W11-1 / W8-4 — paired view contract assertion.
  it('reads derived totals from settlement_batch_summary (paired view shipped W8-4)', async () => {
    // Spy the canonical resource list facade so we observe BOTH the canonical
    // settlement_batches read AND the paired view read fired by the module.
    const listSpy = vi.mocked(api.ui_list_resource_complete);
    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.kanban__card').length).toBeGreaterThan(0);
    });
    const calls = listSpy.mock.calls.map((c) => c[0]);
    expect(calls).toContain('settlement_batches');
    expect(calls).toContain('settlement_batch_summary');
  });

  it('scopes the board from client query params and shows scoped context', async () => {
    window.history.pushState(null, '', '/finance/settlements?client=cl_exampleparcel_ksa');

    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read'],
    });

    await waitFor(() => {
      expect(screen.getByText('Scoped client Exampleparcel KSA')).toBeInTheDocument();
      expect(screen.getByText('sb_4518')).toBeInTheDocument();
    });
    expect(screen.queryByText('sb_4517')).not.toBeInTheDocument();
    expect(screen.queryByText('sb_4521')).not.toBeInTheDocument();
  });

  it('resolves the scoped client label from clients when the settlement scope is empty', async () => {
    window.history.pushState(null, '', `/finance/settlements?client=${emptyScopedClientId}`);

    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read'],
    });

    await waitFor(() => {
      expect(screen.getByText('Scoped client Live Empty Settlement Client')).toBeInTheDocument();
    });
    expect(screen.queryByText('sb_4518')).not.toBeInTheDocument();
    expect(screen.queryByText('sb_4517')).not.toBeInTheDocument();
  });

  it('keeps scoped settlements readable when client label readback is denied', async () => {
    vi.mocked(api.ui_get_resource_v1).mockImplementation(async (resource, id) => {
      if (resource === 'clients') {
        throw Object.assign(new Error('Capability denied: clients.read'), {
          code: 'capability_denied',
          capability: 'clients.read',
        });
      }
      return realGetResource(resource, id);
    });
    window.history.pushState(null, '', `/finance/settlements?client=${emptyScopedClientId}`);

    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read'],
    });

    await waitFor(() => {
      expect(screen.getByText('Scoped client selected client')).toBeInTheDocument();
    });
    expect(screen.queryByText('sb_4518')).not.toBeInTheDocument();
  });

  it('scopes the board from partner query params and shows scoped context', async () => {
    window.history.pushState(null, '', '/finance/settlements?partner=mpp_exampledepot');

    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read'],
    });

    await waitFor(() => {
      expect(screen.getByText('Scoped partner Exampledepot')).toBeInTheDocument();
      expect(screen.getByText('sb_4517')).toBeInTheDocument();
    });
    expect(screen.queryByText('sb_4518')).not.toBeInTheDocument();
    expect(screen.queryByText('sb_4521')).not.toBeInTheDocument();
  });

  it('resolves the scoped partner label from marketplace participants when the settlement scope is empty', async () => {
    window.history.pushState(null, '', `/finance/settlements?partner=${emptyScopedPartnerId}`);

    renderWithProviders(<SettlementsModule />, {
      capabilities: ['settlements.read'],
    });

    await waitFor(() => {
      expect(screen.getByText('Scoped partner Live Empty Settlement Partner')).toBeInTheDocument();
    });
    expect(screen.queryByText('sb_4517')).not.toBeInTheDocument();
    expect(screen.queryByText('sb_4518')).not.toBeInTheDocument();
  });
});
