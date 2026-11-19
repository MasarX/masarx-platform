// disputes.test.tsx — covers DisputesModule wiring through Phase B5
// canonical RPCs (CLAIM-FINANCE-WIRING / Phase C4).
//
// Asserts mutation-wiring contract:
//   • Mount + table renders rows from `marketplace_disputes`.
//   • Resolve modal (kind=credit/partial) fires `dispute_resolve_v1` with
//     canonical payload `{ dispute_id, resolution, metadata? }` and
//     invalidates `qk.list('marketplace_disputes')`.
//   • Resolve modal (kind=reject) fires `dispute_reject_v1` with
//     `{ dispute_id, rejection_reason }`.
//   • Drawer-footer Reject button opens a visible reason form then fires
//     `dispute_reject_v1` directly.
//   • Capability gate `disputes.write` (NEW per Phase B5) disables resolve/reject
//     when missing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { DisputesModule } from '../disputes';
import * as api from '@/lib/api';
import { getLookups } from '@/lib/data-source';

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => routerMocks.navigate,
}));

const realListResource = api.ui_list_resource_v1;
const realCompleteList = api.ui_list_resource_complete;
const realGetResource = api.ui_get_resource_v1;
const emptyScopedClientId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
const emptyScopedPartnerId = '22222222-2222-4222-8222-222222222222';

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
    id: 'dsp_881',
    contract_id: 'mctr_701',
    category: 'commercial',
    status: 'under_review',
    created_at: '2026-04-22T10:00:00Z',
    metadata: { shipment_ref: 'SHP-9381201', amount_sar: 480 },
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
  id: row.id,
  dispute_id: row.id,
  opened_by_label: row.id === 'dsp_881' ? 'Examplemart KSA' : 'MasarX Operations',
  counterparty_label: row.id === 'dsp_881' ? 'Examplecourier' : 'Exampledepot',
  opened_by_user_label: 'Finance Operator',
  resolved_by_user_label: row.status === 'resolved' ? 'Finance Lead' : null,
  shipment_ref: row.metadata.shipment_ref,
  amount_sar: row.metadata.amount_sar,
  escalation_count: row.id === 'dsp_880' ? 1 : 0,
  escalation_at: row.id === 'dsp_880' ? '2026-04-24T11:00:00Z' : null,
  is_escalated: row.id === 'dsp_880',
  is_terminal: row.status === 'resolved',
  age_seconds: 3600,
  age_hours: 1,
  client_id: row.id === 'dsp_881' ? 'cl_examplemart_ksa' : null,
  partner_id: row.id === 'dsp_880' || row.id === 'dsp_879' ? 'mpp_exampledepot' : null,
}));

const clientRows = [
  { id: 'cl_examplemart_ksa', name: 'Examplemart KSA', status: 'active' },
  { id: emptyScopedClientId, name: 'Live Empty Dispute Client', status: 'active' },
];

const partnerRows = [
  { id: 'mpp_exampledepot', name: 'Exampledepot', display_name: 'Exampledepot', status: 'approved' },
  { id: emptyScopedPartnerId, display_name: 'Live Empty Dispute Partner', status: 'approved' },
];

const nilUuid = '00000000-0000-0000-0000-000000000000';

function listFromRows<T>(rows: T[], opts?: api.ListOpts) {
  const filter = opts?.filter ?? {};
  const filteredRows = rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => {
      if (value == null || value === '') return true;
      if (key === 'client_id' && value === nilUuid) {
        return (row as Record<string, unknown>)[key] === 'cl_examplemart_ksa';
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

function renderDisputes(capabilities = ['disputes.read', 'disputes.write']) {
  return renderWithProviders(<DisputesModule />, { capabilities });
}

async function rowActionButtonAt(index: number) {
  await waitFor(() => {
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });
  const actionButtons = screen
    .getAllByLabelText('Row actions')
    .filter((node) => node.tagName === 'BUTTON');
  return actionButtons[index]!;
}

async function waitForLookups(category: string) {
  const deadline = Date.now() + 1000;
  while (getLookups(category).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  await Promise.all([
    waitForLookups('dispute_status'),
    waitForLookups('dispute_kind'),
    waitForLookups('dispute_resolution'),
  ]);

  vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
    if (resource === 'marketplace_disputes') {
      return listFromRows(disputeRows, opts);
    }
    if (resource === 'dispute_directory') {
      return listFromRows(disputeDirectoryRows, opts);
    }
    return realListResource(resource, opts);
  });

  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
    if (resource === 'dispute_directory') {
      return listFromRows(disputeDirectoryRows, opts);
    }
    if (resource === 'marketplace_disputes') {
      return listFromRows(disputeRows, opts);
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
  routerMocks.navigate.mockReset();
  vi.restoreAllMocks();
  window.history.pushState(null, '', '/');
});

describe('DisputesModule (CLAIM-FINANCE-WIRING — Phase B5/C4)', () => {
  it('mounts with dispute rows from marketplace_disputes seed', async () => {
    renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
  });

  it('uses the active tenant scope for dispute policy and operator context', async () => {
    const settingsSpy = vi.spyOn(api, 'resolveSettings');

    renderWithProviders(<DisputesModule />, {
      capabilities: ['disputes.read', 'disputes.write'],
      identity: {
        capabilities: ['disputes.read', 'disputes.write'],
        user: { organization_id: 'org_platform_home', access_scope_type: 'platform' },
        scope: { tenant: { id: 'org_rashed', label: 'First Tenant', rank: 2 } },
      },
    });

    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    expect(await screen.findByTitle('Resolved from tenant scope')).toBeInTheDocument();
    expect(settingsSpy).toHaveBeenCalledWith(
      'dispute_resolution_policy',
      expect.objectContaining({
        organization_id: 'org_rashed',
        tenant: expect.objectContaining({ id: 'org_rashed' }),
      }),
    );
  });

  it('disables Mark-resolved + Reject in drawer when only disputes.read held', async () => {
    const user = userEvent.setup();
    renderDisputes(['disputes.read']);
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    // Click first dispute id in mono cell to open the drawer.
    const rows = screen.getAllByRole('row');
    const firstDataRow = rows[1]!;
    const firstCell = within(firstDataRow).getAllByRole('cell')[1]!;
    await user.click(firstCell);
    const resolveBtn = await screen.findByRole('button', {
      name: /Mark resolved.*Dispute update permission required/i,
    });
    expect(resolveBtn).toBeDisabled();
    const rejectBtn = screen.getByRole('button', {
      name: /Reject.*Dispute update permission required/i,
    });
    expect(rejectBtn).toBeDisabled();
  });

  it('keeps dispute write actions inert when only disputes.read is held', async () => {
    const bulkSpy = vi.spyOn(api, 'ui_bulk_dispute_action_v1');
    const rejectSpy = vi.spyOn(api, 'dispute_reject_v1');
    const escalateSpy = vi.spyOn(api, 'dispute_escalate_v1');
    const ackSpy = vi.spyOn(api, 'dispute_acknowledge_v1');

    const user = userEvent.setup();
    renderDisputes(['disputes.read']);

    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);

    const disabledButtons = [
      await screen.findByRole('button', {
        name: /Acknowledge.*Dispute update permission required/i,
      }),
      screen.getByRole('button', {
        name: /Escalate.*Dispute update permission required/i,
      }),
      screen.getByRole('button', {
        name: /Reject.*Dispute update permission required/i,
      }),
      screen.getByRole('button', {
        name: /Mark resolved.*Dispute update permission required/i,
      }),
    ];

    for (const button of disabledButtons) {
      expect(button).toBeDisabled();
      await user.click(button);
    }

    expect(ackSpy).not.toHaveBeenCalled();
    expect(escalateSpy).not.toHaveBeenCalled();
    expect(rejectSpy).not.toHaveBeenCalled();
    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it('keeps cross-tenant dispute lifecycle actions inspectable but not mutable', async () => {
    const bulkSpy = vi.spyOn(api, 'ui_bulk_dispute_action_v1');
    const rejectSpy = vi.spyOn(api, 'dispute_reject_v1');
    const escalateSpy = vi.spyOn(api, 'dispute_escalate_v1');
    const ackSpy = vi.spyOn(api, 'dispute_acknowledge_v1');
    const tenantReason = "Switch to this dispute's tenant before changing dispute lifecycle.";
    const bulkTenantReason = "Switch to each selected dispute's tenant before changing dispute lifecycle.";
    const crossTenantRows = [
      {
        ...disputeRows[0]!,
        opened_by_organization_id: 'org_other_tenant',
        counterparty_organization_id: 'org_partner_tenant',
      },
    ];
    const crossTenantDirectoryRows = [
      {
        ...disputeDirectoryRows[0]!,
        opened_by_organization_id: 'org_other_tenant',
        counterparty_organization_id: 'org_partner_tenant',
      },
    ];

    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource, opts) => {
      if (resource === 'marketplace_disputes') return listFromRows(crossTenantRows, opts);
      if (resource === 'dispute_directory') return listFromRows(crossTenantDirectoryRows, opts);
      return realListResource(resource, opts);
    });
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'marketplace_disputes') return listFromRows(crossTenantRows, opts);
      if (resource === 'dispute_directory') return listFromRows(crossTenantDirectoryRows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderDisputes();
    await waitFor(() => {
      expect(screen.getByText('dsp_880')).toBeInTheDocument();
    });

    await user.click(screen.getAllByLabelText('Select row')[0]!);
    const bulkMarkResolved = screen.getByRole('button', { name: /^Mark resolved$/ });
    const bulkEscalate = screen.getByRole('button', { name: /^Escalate$/ });
    for (const button of [bulkMarkResolved, bulkEscalate]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', bulkTenantReason);
      await user.click(button).catch(() => undefined);
    }

    await user.click(await rowActionButtonAt(0));
    for (const label of ['Acknowledge', 'Escalate', 'Mark resolved']) {
      const option = await screen.findByRole('option', { name: new RegExp(`^${label}`) });
      expect(option).toHaveClass('is-disabled');
      expect(option).toHaveTextContent(tenantReason);
      await user.click(option).catch(() => undefined);
    }

    await user.keyboard('{Escape}');
    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);
    const drawer = await screen.findByRole('dialog', { name: /Dispute.*dsp_880/i });
    for (const label of ['Acknowledge', 'Escalate', 'Reject', 'Mark resolved']) {
      const button = within(drawer).getByRole('button', { name: label });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', tenantReason);
      await user.click(button).catch(() => undefined);
    }

    expect(ackSpy).not.toHaveBeenCalled();
    expect(escalateSpy).not.toHaveBeenCalled();
    expect(rejectSpy).not.toHaveBeenCalled();
    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it('row action menu disables lifecycle actions for terminal disputes', async () => {
    const bulkSpy = vi.spyOn(api, 'ui_bulk_dispute_action_v1');
    const escalateSpy = vi.spyOn(api, 'dispute_escalate_v1');
    const ackSpy = vi.spyOn(api, 'dispute_acknowledge_v1');

    const user = userEvent.setup();
    renderDisputes();
    await user.click(await rowActionButtonAt(2));

    const acknowledge = await screen.findByRole('option', { name: /^Acknowledge/ });
    const escalate = screen.getByRole('option', { name: /^Escalate/ });
    const markResolved = screen.getByRole('option', { name: /^Mark resolved/ });

    for (const option of [acknowledge, escalate, markResolved]) {
      expect(option).toHaveClass('is-disabled');
      expect(option).toHaveTextContent(/Dispute is resolved/i);
      await user.click(option).catch(() => undefined);
    }

    expect(ackSpy).not.toHaveBeenCalled();
    expect(escalateSpy).not.toHaveBeenCalled();
    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it('drawer footer explains disabled lifecycle actions for terminal disputes', async () => {
    const bulkSpy = vi.spyOn(api, 'ui_bulk_dispute_action_v1');
    const rejectSpy = vi.spyOn(api, 'dispute_reject_v1');
    const escalateSpy = vi.spyOn(api, 'dispute_escalate_v1');
    const ackSpy = vi.spyOn(api, 'dispute_acknowledge_v1');

    const user = userEvent.setup();
    renderDisputes();
    const terminalDispute = await screen.findByText('dsp_879');
    const terminalRow = terminalDispute.closest('tr');
    expect(terminalRow).toBeTruthy();
    await user.click(within(terminalRow as HTMLElement).getAllByRole('cell')[1]!);

    const drawer = await screen.findByRole('dialog', { name: /Dispute.*dsp_879/i });
    const expected = [
      ['Acknowledge', 'Dispute is resolved; acknowledgement is not allowed.'],
      ['Escalate', 'Dispute is resolved; escalation is not allowed.'],
      ['Reject', 'Dispute is resolved; rejection is not allowed.'],
      ['Mark resolved', 'Dispute is resolved; resolution is not allowed.'],
    ] as const;

    for (const [label, title] of expected) {
      const button = within(drawer).getByRole('button', { name: label });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', title);
      await user.click(button).catch(() => undefined);
    }

    expect(ackSpy).not.toHaveBeenCalled();
    expect(escalateSpy).not.toHaveBeenCalled();
    expect(rejectSpy).not.toHaveBeenCalled();
    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it('bulk lifecycle actions are disabled when selected disputes include terminal rows', async () => {
    const bulkSpy = vi.spyOn(api, 'ui_bulk_dispute_action_v1');
    const user = userEvent.setup();
    renderDisputes();

    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const checkboxes = screen.getAllByLabelText('Select row');
    await user.click(checkboxes[0]!);
    await user.click(checkboxes[2]!);

    const markResolved = screen.getByRole('button', { name: /^Mark resolved$/ });
    const escalate = screen.getByRole('button', { name: /^Escalate$/ });
    expect(markResolved).toBeDisabled();
    expect(markResolved).toHaveAttribute('title', 'Selected disputes include a status that cannot be resolved.');
    expect(escalate).toBeDisabled();
    expect(escalate).toHaveAttribute('title', 'Selected disputes include a status that cannot be escalated.');
    await user.click(markResolved).catch(() => undefined);
    await user.click(escalate).catch(() => undefined);

    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it('Mark-resolved with kind=credit fires bulk dispute action + invalidates marketplace_disputes', async () => {
    let didResolve = false;
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource, opts) => {
      const resolvedDisputeRows = didResolve
        ? disputeRows.map((row) =>
            row.id === 'dsp_880'
              ? { ...row, status: 'resolved', resolution: 'credit' }
              : row,
          )
        : disputeRows;
      const resolvedDirectoryRows = didResolve
        ? disputeDirectoryRows.map((row) =>
            row.dispute_id === 'dsp_880'
              ? {
                  ...row,
                  status: 'resolved',
                  resolution: 'credit',
                  is_terminal: true,
                  resolved_by_user_label: 'Finance Lead',
                }
              : row,
          )
        : disputeDirectoryRows;
      if (resource === 'marketplace_disputes') {
        return listFromRows(resolvedDisputeRows, opts);
      }
      if (resource === 'dispute_directory') {
        return listFromRows(resolvedDirectoryRows, opts);
      }
      return realListResource(resource, opts);
    });
    const spy = vi.spyOn(api, 'ui_bulk_dispute_action_v1').mockResolvedValue({
      ok: true,
      operation: 'resolve',
      succeeded_count: 1,
      failed_count: 0,
      results: [
        {
          ok: true,
          dispute_id: 'dsp_880',
          result: { dispute_id: 'dsp_880', status: 'resolved' },
        },
      ],
    } as Awaited<ReturnType<typeof api.ui_bulk_dispute_action_v1>>);
    spy.mockImplementation(async () => {
      didResolve = true;
      return {
        ok: true,
        operation: 'resolve',
        succeeded_count: 1,
        failed_count: 0,
        results: [
          {
            ok: true,
            dispute_id: 'dsp_880',
            result: { dispute_id: 'dsp_880', status: 'resolved' },
          },
        ],
      } as Awaited<ReturnType<typeof api.ui_bulk_dispute_action_v1>>;
    });

    const user = userEvent.setup();
    const { queryClient } = renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const invSpy = vi.spyOn(queryClient, 'invalidateQueries');

    // Open drawer for first row.
    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);
    const markResolvedBtn = await screen.findByRole('button', { name: 'Mark resolved' });
    await user.click(markResolvedBtn);

    // Modal opens with default resolution=credit (first lookup option).
    const modalSubmit = await screen.findByRole('button', {
      name: 'Mark resolved',
    });
    await user.click(modalSubmit);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const refreshedDrawer = await screen.findByRole('dialog', { name: /Dispute.*dsp_880/i });
    await waitFor(() => {
      expect(refreshedDrawer).toHaveTextContent('resolved');
      expect(refreshedDrawer).toHaveTextContent('credit');
    });
    expect(within(refreshedDrawer).getByRole('button', { name: 'Mark resolved' })).toBeDisabled();
    await user.click(within(refreshedDrawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Dispute.*dsp_880/i })).not.toBeInTheDocument();
    });
    expect(within(screen.getAllByRole('row')[1]!).getByText('Resolved')).toBeInTheDocument();
    const payload = spy.mock.calls[0]![0]!;
    expect(payload.dispute_ids).toHaveLength(1);
    expect(payload.operation).toBe('resolve');
    expect(payload).toHaveProperty('resolution');
    expect(typeof payload.resolution).toBe('string');
    await waitFor(() => {
      const calls = invSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('marketplace_disputes'))).toBe(true);
    });
  });

  it('Reject through Mark resolved requires visible notes and routes to reject operation', async () => {
    const spy = vi.spyOn(api, 'ui_bulk_dispute_action_v1').mockResolvedValue({
      ok: true,
      operation: 'reject',
      succeeded_count: 1,
      failed_count: 0,
      results: [],
    } as Awaited<ReturnType<typeof api.ui_bulk_dispute_action_v1>>);

    const user = userEvent.setup();
    renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);
    await user.click(await screen.findByRole('button', { name: 'Mark resolved' }));

    const dialog = await screen.findByRole('dialog', { name: /Resolve.*dsp_880/i });
    await user.selectOptions(within(dialog).getByLabelText('Resolution'), 'reject');
    const submit = within(dialog).getByRole('button', { name: 'Mark resolved' });
    expect(submit).toBeDisabled();
    await user.click(submit).catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/Notes/), 'Carrier evidence rejected');
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]![0]).toMatchObject({
      dispute_ids: ['dsp_880'],
      operation: 'reject',
      rejection_reason: 'Carrier evidence rejected',
      metadata: {
        notes: 'Carrier evidence rejected',
      },
    });
  });

  it('Drawer Reject button opens reason form then fires dispute_reject_v1', async () => {
    const spy = vi.spyOn(api, 'dispute_reject_v1').mockResolvedValue({
      ok: true,
      dispute_id: 'disp_test_2',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      status: 'rejected',
    } as Awaited<ReturnType<typeof api.dispute_reject_v1>>);
    const user = userEvent.setup();
    renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);
    // Reject is in the drawer footer; there will be 2 elements named "Reject"
    // when resolve modal happens. We click the drawer footer one (only one
    // present pre-modal).
    const rejectBtn = await screen.findByRole('button', { name: 'Reject' });
    await user.click(rejectBtn);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Reject - dsp_880');
    await user.type(screen.getByLabelText('Rejection reason'), 'Out of scope');
    await user.click(screen.getByRole('button', { name: 'Reject dispute' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('dispute_id');
    expect(payload.rejection_reason).toBe('Out of scope');
  });

  it('Drawer Reject backend-refetches terminal status in the same drawer without reload', async () => {
    let currentRows = disputeRows.map((row) => ({ ...row, metadata: { ...row.metadata } }));
    let currentDirectoryRows = disputeDirectoryRows.map((row) => ({
      ...row,
      metadata: { ...row.metadata },
    }));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'marketplace_disputes') return listFromRows(currentRows, opts);
      if (resource === 'dispute_directory') return listFromRows(currentDirectoryRows, opts);
      return realListResource(resource, opts);
    });
    vi.spyOn(api, 'dispute_reject_v1').mockImplementation(async (args) => {
      currentRows = currentRows.map((row) =>
        row.id === args.dispute_id
          ? {
              ...row,
              status: 'rejected',
              resolution: args.rejection_reason,
              resolved_at: '2026-05-18T11:29:11Z',
            }
          : row,
      );
      currentDirectoryRows = currentDirectoryRows.map((row) =>
        row.dispute_id === args.dispute_id
          ? {
              ...row,
              status: 'rejected',
              resolution: args.rejection_reason,
              resolved_at: '2026-05-18T11:29:11Z',
              is_terminal: true,
            }
          : row,
      );
      return {
        ok: true,
        dispute_id: args.dispute_id,
        correlation_id: 'cor_reject_readback',
        settings_resolution_id: 'srlv_reject_readback',
        status: 'rejected',
      };
    });

    const user = userEvent.setup();
    renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    const firstDataRow = screen.getAllByRole('row')[1]!;
    await user.click(within(firstDataRow).getAllByRole('cell')[1]!);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await user.type(screen.getByLabelText('Rejection reason'), 'Backend terminal readback');
    await user.click(screen.getByRole('button', { name: 'Reject dispute' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Dispute.*dsp_880/i })).toHaveTextContent(
        'rejected',
      );
    });
    const refreshedDrawer = screen.getByRole('dialog', { name: /Dispute.*dsp_880/i });
    expect(refreshedDrawer).toHaveTextContent('Resolution');
    expect(refreshedDrawer).toHaveTextContent('Backend terminal readback');
  });

  it('Drawer Reject without reason does NOT fire RPC', async () => {
    const spy = vi.spyOn(api, 'dispute_reject_v1');

    const user = userEvent.setup();
    renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);
    const rejectBtn = await screen.findByRole('button', { name: 'Reject' });
    await user.click(rejectBtn);
    const submit = await screen.findByRole('button', { name: 'Reject dispute' });
    expect(submit).toBeDisabled();
    await user.click(submit).catch(() => undefined);

    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  // ── W9-3 escalate path coverage ──────────────────────────────────────────
  it('Drawer Escalate opens reason form then fires dispute_escalate_v1', async () => {
    const spy = vi.spyOn(api, 'dispute_escalate_v1').mockResolvedValue({
      ok: true,
      dispute_id: 'disp_test_3',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      status: 'under_review',
      escalation_count: 1,
    } as Awaited<ReturnType<typeof api.dispute_escalate_v1>>);
    const user = userEvent.setup();
    const { queryClient } = renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const invSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);
    const escalateBtn = await screen.findByRole('button', { name: 'Escalate' });
    await user.click(escalateBtn);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Escalate - dsp_880');
    await user.type(screen.getByLabelText('Escalation reason'), 'Repeat offender');
    await user.click(screen.getByRole('button', { name: 'Escalate dispute' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('dispute_id');
    expect(payload.escalation_reason).toBe('Repeat offender');
    await waitFor(() => {
      const calls = invSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('marketplace_disputes'))).toBe(true);
    });
  });

  it('bulk Escalate uses server-side ui_bulk_dispute_action_v1 once for selected disputes', async () => {
    let didEscalate = false;
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource, opts) => {
      const escalatedDisputeRows = didEscalate
        ? disputeRows.map((row) =>
            row.id === 'dsp_880'
              ? { ...row, status: 'under_review', metadata: { ...row.metadata, escalation_reason: 'Needs finance manager review' } }
              : row,
          )
        : disputeRows;
      const escalatedDirectoryRows = didEscalate
        ? disputeDirectoryRows.map((row) =>
            row.dispute_id === 'dsp_880'
              ? {
                  ...row,
                  status: 'under_review',
                  is_escalated: true,
                  escalation_count: 2,
                  escalation_at: '2026-05-24T10:00:00Z',
                }
              : row,
          )
        : disputeDirectoryRows;
      if (resource === 'marketplace_disputes') {
        return listFromRows(escalatedDisputeRows, opts);
      }
      if (resource === 'dispute_directory') {
        return listFromRows(escalatedDirectoryRows, opts);
      }
      return realListResource(resource, opts);
    });
    const bulkSpy = vi.spyOn(api, 'ui_bulk_dispute_action_v1').mockImplementation(async () => {
      didEscalate = true;
      return {
        ok: true,
        operation: 'escalate',
        succeeded_count: 1,
        failed_count: 0,
        results: [
          {
            ok: true,
            dispute_id: 'dsp_880',
            result: { dispute_id: 'dsp_880', status: 'under_review' },
          },
        ],
      } as Awaited<ReturnType<typeof api.ui_bulk_dispute_action_v1>>;
    });
    const singleSpy = vi.spyOn(api, 'dispute_escalate_v1');

    const user = userEvent.setup();
    renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    await user.click(screen.getAllByLabelText('Select row')[0]!);
    const bulkEscalate = await screen.findByRole('button', { name: /^Escalate$/ });
    await user.click(bulkEscalate);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Escalate 1 dispute');
    await user.type(screen.getByLabelText('Escalation reason'), 'Needs finance manager review');
    await user.click(screen.getByRole('button', { name: 'Escalate disputes' }));

    await waitFor(() => {
      expect(bulkSpy).toHaveBeenCalledTimes(1);
    });
    expect(singleSpy).not.toHaveBeenCalled();
    const payload = bulkSpy.mock.calls[0]![0]!;
    expect(payload.dispute_ids).toHaveLength(1);
    expect(payload.operation).toBe('escalate');
    expect(payload.escalation_reason).toBe('Needs finance manager review');
    await waitFor(() => {
      const firstDataRow = screen.getAllByRole('row')[1]!;
      expect(within(firstDataRow).getByText('Under review')).toBeInTheDocument();
    });
  });

  it('Drawer Escalate without reason does NOT fire RPC', async () => {
    const spy = vi.spyOn(api, 'dispute_escalate_v1');

    const user = userEvent.setup();
    renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);
    const escalateBtn = await screen.findByRole('button', { name: 'Escalate' });
    await user.click(escalateBtn);
    const submit = await screen.findByRole('button', { name: 'Escalate dispute' });
    expect(submit).toBeDisabled();
    await user.click(submit).catch(() => undefined);

    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('consumes the W25 dispute_directory projection — drawer mounts without error and renders core dispute detail rows', async () => {
    // Asserts the module successfully consumes the
    // `dispute_directory` paired projection (W25 closure) without
    // crashing. The seeded dispute rows have no
    // opened_by_organization_id / counterparty_organization_id columns
    // (they predate the W25 projection contract), so the projection-only
    // labels resolve to null and the conditional DetailRow entries are
    // not rendered — the legacy DetailRow entries (`Contract`,
    // `Shipment`, `Amount`, `Filed`) must remain visible regardless.
    const user = userEvent.setup();
    renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);

    // Legacy DetailRow entries must remain present (sanity guard).
    // Use getAllByText since some labels (`Shipment`) double as column
    // headers; the projection contract is satisfied as long as the
    // drawer rendered without crashing and core rows are visible.
    expect((await screen.findAllByText('Contract')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Shipment').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Amount').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Filed').length).toBeGreaterThanOrEqual(1);
  });

  it('Escalate is disabled in drawer when only disputes.read held', async () => {
    const user = userEvent.setup();
    renderDisputes(['disputes.read']);
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const rows = screen.getAllByRole('row');
    const firstDataRow = rows[1]!;
    const firstCell = within(firstDataRow).getAllByRole('cell')[1]!;
    await user.click(firstCell);
    const escalateBtn = await screen.findByRole('button', {
      name: /Escalate.*Dispute update permission required/i,
    });
    expect(escalateBtn).toBeDisabled();
  });

  // ── W31 / FB-07 acknowledge path coverage ────────────────────────────────
  it('Drawer Acknowledge fires dispute_acknowledge_v1 + invalidates marketplace_disputes', async () => {
    const spy = vi.spyOn(api, 'dispute_acknowledge_v1').mockResolvedValue({
      ok: true,
      dispute_id: 'disp_test_ack_1',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      status: 'under_review',
    } as Awaited<ReturnType<typeof api.dispute_acknowledge_v1>>);

    const user = userEvent.setup();
    const { queryClient } = renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const invSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);
    const ackBtn = await screen.findByRole('button', { name: 'Acknowledge' });
    await user.click(ackBtn);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(screen.getAllByText(/Dispute .* dsp_880/i).length).toBeGreaterThan(0);
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('dispute_id');
    expect(typeof payload.dispute_id).toBe('string');
    await waitFor(() => {
      const calls = invSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('marketplace_disputes'))).toBe(true);
    });
  });

  it('Acknowledge is disabled in drawer when only disputes.read held', async () => {
    const user = userEvent.setup();
    renderDisputes(['disputes.read']);
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const rows = screen.getAllByRole('row');
    const firstCell = within(rows[1]!).getAllByRole('cell')[1]!;
    await user.click(firstCell);
    const ackBtn = await screen.findByRole('button', {
      name: /Acknowledge.*Dispute update permission required/i,
    });
    expect(ackBtn).toBeDisabled();
  });

  it('Acknowledge surfaces an info toast when the RPC reports already_processed=true', async () => {
    const spy = vi.spyOn(api, 'dispute_acknowledge_v1').mockResolvedValue({
      ok: true,
      dispute_id: 'disp_test_ack_2',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      status: 'under_review',
      already_processed: true,
    } as Awaited<ReturnType<typeof api.dispute_acknowledge_v1>>);

    const user = userEvent.setup();
    renderDisputes();
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const rows = screen.getAllByRole('row');
    await user.click(within(rows[1]!).getAllByRole('cell')[1]!);
    const ackBtn = await screen.findByRole('button', { name: 'Acknowledge' });
    await user.click(ackBtn);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]![0]).toHaveProperty('dispute_id');
    expect(screen.getAllByText(/Dispute .* dsp_880/i).length).toBeGreaterThan(0);
  });

  it('scopes disputes from client query params through related shipment lineage', async () => {
    window.history.pushState(null, '', '/finance/disputes?client=cl_examplemart_ksa');

    renderDisputes();

    await waitFor(() => {
      expect(screen.getByText('Scoped client Examplemart KSA')).toBeInTheDocument();
      expect(screen.getByText('dsp_881')).toBeInTheDocument();
    });
    expect(screen.queryByText('dsp_880')).not.toBeInTheDocument();
    expect(screen.queryByText('dsp_879')).not.toBeInTheDocument();
  });

  it('resolves the scoped client label from clients when the dispute scope is empty', async () => {
    window.history.pushState(null, '', `/finance/disputes?client=${emptyScopedClientId}`);

    renderDisputes();

    await waitFor(() => {
      expect(screen.getByText('Scoped client Live Empty Dispute Client')).toBeInTheDocument();
    });
    expect(screen.queryByText('dsp_880')).not.toBeInTheDocument();
    expect(screen.queryByText('dsp_881')).not.toBeInTheDocument();
  });

  it('keeps scoped disputes readable when client label readback is denied', async () => {
    vi.mocked(api.ui_get_resource_v1).mockImplementation(async (resource, id) => {
      if (resource === 'clients') {
        throw Object.assign(new Error('Capability denied: clients.read'), {
          code: 'capability_denied',
          capability: 'clients.read',
        });
      }
      return realGetResource(resource, id);
    });
    window.history.pushState(null, '', `/finance/disputes?client=${emptyScopedClientId}`);

    renderDisputes(['disputes.read']);

    await waitFor(() => {
      expect(screen.getByText('Scoped client selected client')).toBeInTheDocument();
    });
    expect(screen.queryByText('dsp_880')).not.toBeInTheDocument();
  });

  it('scopes disputes from partner query params through contract participant lineage', async () => {
    window.history.pushState(null, '', '/finance/disputes?partner=mpp_exampledepot');

    renderDisputes();

    await waitFor(() => {
      expect(screen.getByText('Scoped partner Exampledepot')).toBeInTheDocument();
      expect(screen.getByText('dsp_880')).toBeInTheDocument();
      expect(screen.getByText('dsp_879')).toBeInTheDocument();
    });
    expect(screen.queryByText('dsp_881')).not.toBeInTheDocument();
  });

  it('resolves the scoped partner label from marketplace participants when the dispute scope is empty', async () => {
    window.history.pushState(null, '', `/finance/disputes?partner=${emptyScopedPartnerId}`);

    renderDisputes();

    await waitFor(() => {
      expect(screen.getByText('Scoped partner Live Empty Dispute Partner')).toBeInTheDocument();
    });
    expect(screen.queryByText('dsp_880')).not.toBeInTheDocument();
    expect(screen.queryByText('dsp_881')).not.toBeInTheDocument();
  });
});
