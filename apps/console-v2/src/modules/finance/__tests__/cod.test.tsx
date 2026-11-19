// cod.test.tsx — covers CodModule W39 closure for the "Start COD settlement"
// per-row + bulk actions wired through the canonical public-callable
// workflow-start seam `api.start_workflow_run` (server-asserted
// `workflow_runs.write`). Targets the canonical
// `cod_driver_shift_settlement_v2` workflow template key. Previously these row/bulk
// actions emitted only a toast simulation (REAUDIT5B FINANCE NEW P2).

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { CodModule } from '../cod';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';

beforeEach(() => {
  localStorage.removeItem('demo-v2.view.cod');
  const realCompleteList = api.ui_list_resource_complete;
  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
    if (resource === 'settlement_batches') return { rows: [], total: 0 };
    if (resource === 'workflow_run_directory') return { rows: [], total: 0 };
    if (resource !== 'cod_entries') return realCompleteList(resource, opts);
    return {
      rows: [
        {
          id: 'cod_1',
          organization_id: 'org_rashed',
          subject_id: 'shipment_cod_1',
          currency: 'SAR',
          collected_at: '2026-05-15T05:26:47.233Z',
          created_at: '2026-05-15T05:26:47.322Z',
          metadata: {
            tracking: 'COD-READBACK-SHIPMENT',
            expected: 240,
            collected: 240,
            remitted: 0,
            discrepancy: 0,
            status: 'collected',
            branch_id: 'branch_riyadh',
            driver_user_id: 'driver_user_1',
            settlement_context_ready: true,
          },
        },
      ],
      total: 1,
    };
  });
  vi.spyOn(api, 'compute_cod_payment_collection_summary_v1').mockResolvedValue({
    scope: { organization_id: 'org_rashed' },
    expected: 450,
    collected: 430,
    remitted: 190,
    variance: -20,
  });
  vi.spyOn(api, 'progress_workflow_run_until_wait_v1').mockResolvedValue({
    ok: true,
    workflow_run_id: 'wfr_test_cod_variance_1',
    workflow_status: 'paused',
    duration_ms: 12,
    steps: [],
  } as Awaited<ReturnType<typeof api.progress_workflow_run_until_wait_v1>>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CodModule (CLAIM-FINANCE-COD — W39 closure)', () => {
  it('mounts the COD entries grid', async () => {
    renderWithProviders(<CodModule />, { capabilities: ['cod.read', 'finance.read'] });
    await waitFor(() => {
      expect(document.querySelectorAll('table').length).toBeGreaterThan(0);
    });
  });

  it('sources KPI totals from compute_cod_payment_collection_summary_v1, not row reductions', async () => {
    vi.spyOn(api, 'compute_cod_payment_collection_summary_v1').mockResolvedValue({
      scope: { organization_id: 'org_rashed' },
      expected: 1234,
      collected: 1200,
      remitted: 800,
      variance: -34,
    });

    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read'],
        user: { organization_id: 'org_rashed' },
      },
    });

    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('1,200')).toBeInTheDocument();
    expect(screen.getByText('800')).toBeInTheDocument();
    expect(screen.getByText('-34')).toBeInTheDocument();
    expect(api.compute_cod_payment_collection_summary_v1).toHaveBeenCalledWith({
      organization_id: 'org_rashed',
    });
  });

  it('uses the active tenant scope for COD policy, summary, and operator context', async () => {
    const settingsSpy = vi.spyOn(api, 'resolveSettings');

    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read'],
        user: { organization_id: 'org_platform_home', access_scope_type: 'platform' },
        scope: { tenant: { id: 'org_rashed', label: 'First Tenant', rank: 2 } },
      },
    });

    expect(await screen.findByTitle('Resolved from tenant scope')).toBeInTheDocument();
    expect(screen.queryByTitle('Resolved from client scope')).not.toBeInTheDocument();
    expect(api.compute_cod_payment_collection_summary_v1).toHaveBeenCalledWith({
      organization_id: 'org_rashed',
    });
    expect(settingsSpy).toHaveBeenCalledWith(
      'cod_policy',
      expect.objectContaining({
        organization_id: 'org_rashed',
        tenant: expect.objectContaining({ id: 'org_rashed' }),
      }),
    );
  });

  it('fails closed when the canonical COD summary cannot be read', async () => {
    vi.spyOn(api, 'compute_cod_payment_collection_summary_v1').mockRejectedValue(
      new Error('summary projection unavailable'),
    );

    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read'],
        user: { organization_id: 'org_rashed' },
      },
    });

    expect(await screen.findByText('COD summary unavailable')).toBeInTheDocument();
    expect(screen.getByText('This section could not load. Please try again or contact an administrator.')).toBeInTheDocument();
    expect(screen.queryByText('Expected')).not.toBeInTheDocument();
  });

  it('fails closed when the canonical COD summary omits required totals', async () => {
    vi.spyOn(api, 'compute_cod_payment_collection_summary_v1').mockResolvedValue({
      scope: { organization_id: 'org_rashed' },
      expected: 1234,
      collected: 1200,
    } as Awaited<ReturnType<typeof api.compute_cod_payment_collection_summary_v1>>);

    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read'],
        user: { organization_id: 'org_rashed' },
      },
    });

    expect(await screen.findByText('COD summary unavailable')).toBeInTheDocument();
    expect(screen.getByText(/COD closeout totals are incomplete/i)).toBeInTheDocument();
  });

  it('opens a shipment context drawer in place from a COD row', async () => {
    window.history.pushState(null, '', '/finance/cod');
    const realGet = ds.ui_get_resource_v1;
    vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (resource === 'shipments') {
        return {
          id: String(id),
          tracking_number: 'COD-READBACK-SHIPMENT',
          status: 'delivered',
          service_type: 'standard',
        };
      }
      return realGet(resource, id);
    });
    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const firstRow = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
    expect(firstRow).not.toBeNull();
    await user.click(firstRow!);

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(window.location.pathname).toBe('/finance/cod');
    expect(window.location.search).toBe('');
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps COD closeout write actions inert when finance.write is missing', async () => {
    const user = userEvent.setup();
    const remitSpy = vi.spyOn(api, 'ui_record_cod_remittance_v1');
    const adjustSpy = vi.spyOn(api, 'ui_adjust_cod_collection_v1');
    const workflowSpy = vi.spyOn(api, 'start_workflow_run');

    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read'],
        user: { organization_id: 'org_rashed' },
      },
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const rowCheckboxes = screen
      .getAllByRole('checkbox')
      .filter((cb) => cb.getAttribute('aria-label') === 'Select row');
    expect(rowCheckboxes.length).toBeGreaterThan(0);
    await user.click(rowCheckboxes[0]!);

    const bulkCashier = await screen.findByRole('button', { name: /Record cashier counts/i });
    expect(bulkCashier).toBeDisabled();
    await user.click(bulkCashier);

    const bulkVariance = screen.getByRole('button', { name: /Start COD settlement/i });
    expect(bulkVariance).toBeDisabled();
    await user.click(bulkVariance);

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);

    const cashierOption = await screen.findByRole('option', { name: /Record cashier count/i });
    const adjustOption = await screen.findByRole('option', { name: /Adjust collected/i });
    const varianceOption = await screen.findByRole('option', { name: /Start COD settlement/i });
    for (const option of [cashierOption, adjustOption, varianceOption]) {
      expect(option).toHaveClass('is-disabled');
      expect(option).toHaveTextContent(/finance update permission/i);
      await user.click(option).catch(() => undefined);
    }

    expect(remitSpy).not.toHaveBeenCalled();
    expect(adjustSpy).not.toHaveBeenCalled();
    expect(workflowSpy).not.toHaveBeenCalled();
  });

  it('keeps cross-tenant COD lifecycle actions inspectable but not mutable', async () => {
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource) => {
      if (resource !== 'cod_entries') return { rows: [], total: 0 };
      return {
        rows: [
          {
            id: 'cod_cross_tenant',
            organization_id: 'org_other_tenant',
            subject_id: 'shipment_cod_cross_tenant',
            currency: 'SAR',
            collected_at: '2026-05-15T05:26:47.233Z',
            created_at: '2026-05-15T05:26:47.322Z',
            metadata: {
              tracking: 'COD-CROSS-TENANT',
              expected: 240,
              collected: 240,
              remitted: 0,
              discrepancy: 0,
              status: 'collected',
            },
          },
        ],
        total: 1,
      };
    });
    const remitSpy = vi.spyOn(api, 'ui_record_cod_remittance_v1');
    const adjustSpy = vi.spyOn(api, 'ui_adjust_cod_collection_v1');
    const workflowSpy = vi.spyOn(api, 'start_workflow_run');

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
        user: { organization_id: 'org_rashed' },
      },
    });

    expect(await screen.findByText('COD-CROSS-TENANT')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Select row'));

    const bulkCashier = await screen.findByRole('button', { name: /Record cashier counts/i });
    expect(bulkCashier).toBeDisabled();
    expect(bulkCashier).toHaveAttribute(
      'title',
      "Switch to each selected COD row's tenant before recording cashier counts.",
    );
    const bulkSettlement = screen.getByRole('button', { name: /^Start COD settlement$/ });
    expect(bulkSettlement).toBeDisabled();
    expect(bulkSettlement).toHaveAttribute(
      'title',
      "Switch to each selected COD row's tenant before starting settlement.",
    );

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    const cashierOption = await screen.findByRole('option', { name: /Record cashier count/i });
    const adjustOption = await screen.findByRole('option', { name: /Adjust collected/i });
    const settlementOption = await screen.findByRole('option', { name: /Start COD settlement/i });
    const openShipmentOption = await screen.findByRole('option', { name: /Open shipment/i });

    for (const option of [cashierOption, adjustOption, settlementOption]) {
      expect(option).toHaveClass('is-disabled');
      expect(option).toHaveTextContent(/Switch to this COD row's tenant before changing COD lifecycle/i);
      await user.click(option).catch(() => undefined);
    }
    expect(openShipmentOption).not.toHaveClass('is-disabled');

    expect(remitSpy).not.toHaveBeenCalled();
    expect(adjustSpy).not.toHaveBeenCalled();
    expect(workflowSpy).not.toHaveBeenCalled();
  });

  it('blocks duplicate COD settlement starts when a backend settlement batch already owns the COD entry', async () => {
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource) => {
      if (resource === 'cod_entries') {
        return {
          rows: [
            {
              id: 'cod_duplicate_guard',
              organization_id: 'org_rashed',
              subject_id: 'shipment_cod_duplicate_guard',
              currency: 'SAR',
              collected_at: '2026-05-15T05:26:47.233Z',
              created_at: '2026-05-15T05:26:47.322Z',
              metadata: {
                tracking: 'COD-DUPLICATE-GUARD',
                expected: 64.5,
                collected: 60,
                remitted: 60,
                discrepancy: -4.5,
                status: 'shortfall',
              },
            },
          ],
          total: 1,
        };
      }
      if (resource === 'settlement_batches') {
        return {
          rows: [
            {
              id: 'settlement_duplicate_guard_existing',
              organization_id: 'org_rashed',
              kind: 'cod',
              status: 'approved',
              metadata: {
                cod_entry_id: 'cod_duplicate_guard',
                tracking: 'COD-DUPLICATE-GUARD',
              },
            },
          ],
          total: 1,
        };
      }
      return { rows: [], total: 0 };
    });
    const workflowSpy = vi.spyOn(api, 'start_workflow_run');

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
        user: { organization_id: 'org_rashed' },
      },
    });

    expect(await screen.findByText('COD-DUPLICATE-GUARD')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Select row'));

    const bulkSettlement = await screen.findByRole('button', { name: /^Start COD settlement$/ });
    expect(bulkSettlement).toBeDisabled();
    expect(bulkSettlement).toHaveAttribute('title', 'No selected COD rows need a settlement workflow.');

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    const settlementOption = await screen.findByRole('option', { name: /Start COD settlement/i });
    expect(settlementOption).toHaveClass('is-disabled');
    expect(settlementOption).toHaveTextContent(/COD settlement already exists for this row/i);
    expect(settlementOption).toHaveTextContent(/Approved settlement_duplicate_guard_existing/i);
    await user.click(settlementOption);

    expect(workflowSpy).not.toHaveBeenCalled();
  });

  it('blocks duplicate COD settlement starts when an active workflow run already owns the COD entry', async () => {
    const templateId = api.resolve_workflow_template_id_v1('cod_driver_shift_settlement_v2');
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource) => {
      if (resource === 'cod_entries') {
        return {
          rows: [
            {
              id: 'cod_active_run_guard',
              organization_id: 'org_rashed',
              subject_id: 'shipment_cod_active_run_guard',
              currency: 'SAR',
              collected_at: '2026-05-15T05:26:47.233Z',
              created_at: '2026-05-15T05:26:47.322Z',
              metadata: {
                tracking: 'COD-ACTIVE-RUN-GUARD',
                expected: 64.5,
                collected: 60,
                remitted: 60,
                discrepancy: -4.5,
                status: 'shortfall',
              },
            },
          ],
          total: 1,
        };
      }
      if (resource === 'settlement_batches') return { rows: [], total: 0 };
      if (resource === 'workflow_run_directory') {
        return {
          rows: [
            {
              id: 'workflow_run_active_guard',
              workflow_template_id: templateId,
              workflow_status: 'pending',
              context: {
                organization_id: 'org_rashed',
                payload: {
                  organization_id: 'org_rashed',
                  cod_entry_id: 'cod_active_run_guard',
                },
              },
            },
          ],
          total: 1,
        };
      }
      return { rows: [], total: 0 };
    });
    const workflowSpy = vi.spyOn(api, 'start_workflow_run');

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
        user: { organization_id: 'org_rashed' },
      },
    });

    expect(await screen.findByText('COD-ACTIVE-RUN-GUARD')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Select row'));

    const bulkSettlement = await screen.findByRole('button', { name: /^Start COD settlement$/ });
    expect(bulkSettlement).toBeDisabled();
    expect(bulkSettlement).toHaveAttribute('title', 'No selected COD rows need a settlement workflow.');

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    const settlementOption = await screen.findByRole('option', { name: /Start COD settlement/i });
    expect(settlementOption).toHaveClass('is-disabled');
    expect(settlementOption).toHaveTextContent(/COD settlement workflow is already active for this row/i);
    expect(settlementOption).toHaveTextContent(/Pending workflow_run_active_guard/i);
    await user.click(settlementOption);

    expect(workflowSpy).not.toHaveBeenCalled();
  });

  it('disables COD settlement starts when shipment driver context is missing', async () => {
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource) => {
      if (resource === 'settlement_batches') return { rows: [], total: 0 };
      if (resource === 'workflow_run_directory') return { rows: [], total: 0 };
      if (resource !== 'cod_entries') return { rows: [], total: 0 };
      return {
        rows: [
          {
            id: 'cod_missing_driver',
            organization_id: 'org_rashed',
            subject_id: 'shipment_missing_driver',
            currency: 'SAR',
            collected_at: '2026-05-15T05:26:47.233Z',
            created_at: '2026-05-15T05:26:47.322Z',
            metadata: {
              tracking: 'COD-MISSING-DRIVER',
              expected: 50,
              collected: 45,
              remitted: 45,
              discrepancy: -5,
              status: 'shortfall',
              branch_id: 'branch_riyadh',
              settlement_context_ready: false,
            },
          },
        ],
        total: 1,
      };
    });
    const workflowSpy = vi.spyOn(api, 'start_workflow_run');
    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
        user: { organization_id: 'org_rashed' },
      },
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const startOption = await screen.findByRole('option', {
      name: /Start COD settlement/i,
    });

    expect(startOption).toHaveClass('is-disabled');
    expect(startOption).toHaveTextContent('COD settlement workflow requires shipment driver context.');
    await user.click(startOption).catch(() => undefined);
    expect(workflowSpy).not.toHaveBeenCalled();
  });

  it('per-row "Start COD settlement" derives driver-shift context, starts the workflow, and opens run readback', async () => {
    const swrSpy = vi
      .spyOn(api, 'start_workflow_run')
      .mockResolvedValue({
        ok: true,
        workflow_run_id: 'wfr_test_cod_variance_1',
        workflow_template_id: '99990000-0000-0000-0000-000000570002',
        workflow_status: 'pending',
        dry_run: false,
        idempotency_key: 'idemp_test_cod_1',
        correlation_id: 'cor_test_cod_1',
        started_at: new Date().toISOString(),
        canonical_entrypoint: 'progress_workflow_run',
      } as Awaited<ReturnType<typeof api.start_workflow_run>>);
    const shipmentSpy = vi.spyOn(api, 'ui_get_resource_v1').mockResolvedValue({
      id: 'shipment_cod_1',
      tracking_number: 'COD-READBACK-SHIPMENT',
      client_id: 'client_cod_1',
      branch_id: 'branch_riyadh',
      driver_user_id: 'driver_user_1',
      cod_currency: 'SAR',
    } as Awaited<ReturnType<typeof api.ui_get_resource_v1>>);

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
        user: { organization_id: 'org_rashed' },
      },
    });
    await waitFor(() => {
      expect(document.querySelectorAll('table').length).toBeGreaterThan(0);
    });

    // DataTable rowActions surface via a kebab "Row actions" button per
    // row. Open the first row's actions menu, then pick the settlement
    // workflow start from the palette options.
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    expect(kebabs.length).toBeGreaterThan(0);
    await user.click(kebabs[0]!);
    const openGate = await screen.findByRole('option', {
      name: /Start COD settlement/i,
    });
    await user.click(openGate);

    await waitFor(() => {
      expect(swrSpy).toHaveBeenCalled();
    });
    expect(api.progress_workflow_run_until_wait_v1).toHaveBeenCalledWith(
      'wfr_test_cod_variance_1',
      expect.objectContaining({
        source: 'console-v2/finance/cod',
        cod_entry_id: 'cod_1',
        shipment_id: 'shipment_cod_1',
        tracking: 'COD-READBACK-SHIPMENT',
      }),
      expect.objectContaining({
        budget_ms: 5000,
        max_steps: 10,
      }),
    );
    expect(shipmentSpy).toHaveBeenCalledWith('shipments', 'shipment_cod_1');
    const [templateId, context] = swrSpy.mock.calls[0]!;
    expect(templateId).toBe('99990000-0000-0000-0000-000000570002');
    expect(context).toMatchObject({
      cod_entry_id: 'cod_1',
      tracking: 'COD-READBACK-SHIPMENT',
      organization_id: 'org_rashed',
      kind: 'cod',
      scope_type: 'driver_shift',
      subject_type: 'driver',
      subject_id: 'driver_user_1',
      branch_id: 'branch_riyadh',
      client_id: 'client_cod_1',
      settlement: {
        expected_amount: 240,
        collected_amount: 240,
        remitted_amount: 0,
        variance_amount: 0,
        outstanding_handover_amount: 240,
        currency: 'SAR',
      },
    });
    expect(await screen.findByText('Workflow run context')).toBeInTheDocument();
    expect(screen.getByText('Driver shift COD settlement')).toBeInTheDocument();
    expect(screen.getByText('wfr_test_cod_variance_1')).toBeInTheDocument();
  });

  it('bulk "Start COD settlement" reviews mixed selections and starts only eligible rows', async () => {
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource !== 'cod_entries') return { rows: [], total: 0 };
      const rows = [
        {
          id: 'cod_bulk_eligible',
          organization_id: 'org_rashed',
          subject_id: 'shipment_cod_bulk_eligible',
          currency: 'SAR',
          collected_at: '2026-05-15T05:26:47.233Z',
          created_at: '2026-05-15T05:26:47.322Z',
          metadata: {
            tracking: 'COD-BULK-ELIGIBLE',
            expected: 64.5,
            collected: 60,
            remitted: 60,
            discrepancy: -4.5,
            status: 'shortfall',
          },
        },
        {
          id: 'cod_bulk_balanced',
          organization_id: 'org_rashed',
          subject_id: 'shipment_cod_bulk_balanced',
          currency: 'SAR',
          collected_at: '2026-05-15T05:26:47.233Z',
          created_at: '2026-05-15T05:26:47.322Z',
          metadata: {
            tracking: 'COD-BULK-BALANCED',
            expected: 240,
            collected: 240,
            remitted: 240,
            discrepancy: 0,
            status: 'remitted',
          },
        },
      ];
      return { rows, total: rows.length };
    });
    const shipmentSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (_resource, id) => {
      if (id === 'shipment_cod_bulk_eligible') {
        return {
          id,
          tracking_number: 'COD-BULK-ELIGIBLE',
          client_id: 'client_cod_bulk',
          branch_id: 'branch_riyadh',
          driver_user_id: 'driver_user_bulk',
          cod_currency: 'SAR',
        } as Awaited<ReturnType<typeof api.ui_get_resource_v1>>;
      }
      throw new Error(`Unexpected shipment read: ${id}`);
    });
    const workflowSpy = vi.spyOn(api, 'start_workflow_run').mockResolvedValue({
      ok: true,
      workflow_run_id: 'wfr_bulk_cod_eligible',
      workflow_template_id: '99990000-0000-0000-0000-000000570002',
      workflow_status: 'pending',
      dry_run: false,
      idempotency_key: 'idemp_bulk_cod_eligible',
      correlation_id: 'cor_bulk_cod_eligible',
      started_at: new Date().toISOString(),
      canonical_entrypoint: 'progress_workflow_run',
    } as Awaited<ReturnType<typeof api.start_workflow_run>>);

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
      identity: {
        capabilities: ['cod.read', 'finance.read', 'finance.write', 'workflows.read', 'observability.read'],
        user: { organization_id: 'org_rashed' },
      },
    });
    expect(await screen.findByText('COD-BULK-ELIGIBLE')).toBeInTheDocument();
    expect(screen.getByText('COD-BULK-BALANCED')).toBeInTheDocument();

    for (const checkbox of screen.getAllByLabelText('Select row')) {
      await user.click(checkbox);
    }
    await user.click(await screen.findByRole('button', { name: /^Start COD settlement$/ }));

    const dialog = await screen.findByRole('dialog', { name: /Start COD settlements - 1 eligible/i });
    expect(within(dialog).getByText(/1 selected row will be skipped/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/COD-BULK-ELIGIBLE/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/variance/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/COD-BULK-BALANCED/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Start COD settlements' }));

    await waitFor(() => {
      expect(workflowSpy).toHaveBeenCalledTimes(1);
    });
    expect(api.progress_workflow_run_until_wait_v1).toHaveBeenCalledWith(
      'wfr_bulk_cod_eligible',
      expect.objectContaining({
        source: 'console-v2/finance/cod',
        cod_entry_id: 'cod_bulk_eligible',
        shipment_id: 'shipment_cod_bulk_eligible',
        tracking: 'COD-BULK-ELIGIBLE',
      }),
      expect.objectContaining({ max_steps: 10 }),
    );
    expect(shipmentSpy).toHaveBeenCalledTimes(1);
    expect(shipmentSpy).toHaveBeenCalledWith('shipments', 'shipment_cod_bulk_eligible');
    const [templateId, context] = workflowSpy.mock.calls[0]!;
    expect(templateId).toBe('99990000-0000-0000-0000-000000570002');
    expect(context).toMatchObject({
      cod_entry_id: 'cod_bulk_eligible',
      shipment_id: 'shipment_cod_bulk_eligible',
      tracking: 'COD-BULK-ELIGIBLE',
      subject_id: 'driver_user_bulk',
      branch_id: 'branch_riyadh',
    });
  });

  it('per-row "Record cashier count" opens a typed modal and fires ui_record_cod_remittance_v1 with canonical COD payload', async () => {
    const spy = vi.spyOn(api, 'ui_record_cod_remittance_v1').mockResolvedValue({
      ok: true,
      transfer_id: 'tr_test_cod_remit_1',
      from_finance_event_id: 'fe_out_test',
      to_finance_event_id: 'fe_in_test',
      correlation_id: 'cor_test_cod_remit_1',
    } as Awaited<ReturnType<typeof api.ui_record_cod_remittance_v1>>);
    const promptSpy = vi.spyOn(window, 'prompt');

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('table').length).toBeGreaterThan(0);
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /Record cashier count/i }));

    const dialog = await screen.findByRole('dialog', { name: /Cashier count/i });
    const amount = within(dialog).getByLabelText(/Cashier amount/i);
    const reason = within(dialog).getByLabelText(/Reason/i);
    await user.clear(amount);
    await user.type(amount, '240');
    await user.type(reason, 'cashier handover');
    await user.click(within(dialog).getByRole('button', { name: /Record cashier count/i }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]![0]).toMatchObject({
      cod_entry_id: 'cod_1',
      amount: 240,
      currency: 'SAR',
      reason: 'cashier handover',
    });
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('keeps the operator on COD reconciliation and shows cashier-count readback without reload', async () => {
    window.history.pushState(null, '', '/finance/cod');
    let remitted = false;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource !== 'cod_entries') return { rows: [], total: 0 };
      return {
        rows: [
          {
            id: 'aa91ada6-bf3f-40ce-8690-840a8dc03dcb',
            subject_id: 'b71e0b1c-4a26-4bb4-a28a-63576249da82',
            currency: 'SAR',
            collected_at: '2026-05-15T05:26:47.233Z',
            created_at: '2026-05-15T05:26:47.322Z',
            metadata: {
              tracking: '26003UXTM',
              expected: 128.75,
              collected: 128.75,
              remitted: remitted ? 128.75 : 0,
              discrepancy: 0,
              status: remitted ? 'remitted' : 'collected',
            },
          },
        ],
        total: 1,
      };
    });
    vi.spyOn(api, 'compute_cod_payment_collection_summary_v1').mockImplementation(async (scope) => ({
      scope,
      expected: 128.75,
      collected: 128.75,
      remitted: remitted ? 128.75 : 0,
      variance: 0,
    }));
    vi.spyOn(api, 'ui_record_cod_remittance_v1').mockImplementation(async () => {
      remitted = true;
      return {
        ok: true,
        transfer_id: 'tr_live_cashier_1',
        from_finance_event_id: 'fe_driver_out_1',
        to_finance_event_id: 'fe_cashier_in_1',
        correlation_id: 'cor_live_cashier_1',
      } as Awaited<ReturnType<typeof api.ui_record_cod_remittance_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write'],
      identity: {
        capabilities: ['cod.read', 'finance.read', 'finance.write'],
        user: { organization_id: 'org_rashed' },
      },
    });

    expect(await screen.findByText('26003UXTM')).toBeInTheDocument();
    expect(screen.getByText('collected')).toBeInTheDocument();

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    await user.click(await screen.findByRole('option', { name: /Record cashier count/i }));

    const dialog = await screen.findByRole('dialog', { name: /Cashier count - 26003UXTM/i });
    await user.type(within(dialog).getByLabelText(/Reason/i), 'live cashier count');
    await user.click(within(dialog).getByRole('button', { name: /Record cashier count/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Cashier count/i })).not.toBeInTheDocument();
      const row = Array.from(document.querySelectorAll('.dt__table tbody tr')).find((tr) =>
        tr.textContent?.includes('26003UXTM'),
      ) as HTMLElement | undefined;
      expect(row).toBeTruthy();
      expect(row!.textContent).toContain('remitted');
      expect(row!.textContent).toContain('128.75');
    });
    expect(screen.getAllByText('100%').length).toBeGreaterThanOrEqual(1);
    expect(window.location.pathname).toBe('/finance/cod');
  });

  it('disables cashier count actions when no outstanding COD handover remains', async () => {
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource) => {
      if (resource !== 'cod_entries') return { rows: [], total: 0 };
      return {
        rows: [
          {
            id: 'aa91ada6-bf3f-40ce-8690-840a8dc03dcb',
            subject_id: 'b71e0b1c-4a26-4bb4-a28a-63576249da82',
            currency: 'SAR',
            collected_at: '2026-05-15T05:26:47.233Z',
            created_at: '2026-05-15T05:26:47.322Z',
            metadata: {
              tracking: '26003UXTM',
              expected: 128.75,
              collected: 128.75,
              remitted: 128.75,
              discrepancy: 0,
              status: 'remitted',
            },
          },
        ],
        total: 1,
      };
    });
    const spy = vi.spyOn(api, 'ui_record_cod_remittance_v1');

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write'],
      identity: {
        capabilities: ['cod.read', 'finance.read', 'finance.write'],
        user: { organization_id: 'org_rashed' },
      },
    });

    expect(await screen.findByText('26003UXTM')).toBeInTheDocument();
    await user.click(
      screen
        .getAllByRole('checkbox')
        .find((cb) => cb.getAttribute('aria-label') === 'Select row')!,
    );

    const bulkCashier = await screen.findByRole('button', { name: /Record cashier counts/i });
    expect(bulkCashier).toBeDisabled();
    expect(bulkCashier).toHaveAttribute(
      'title',
      'No selected COD rows have outstanding handover amounts.',
    );

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    const cashierOption = await screen.findByRole('option', { name: /Record cashier count/i });
    expect(cashierOption).toHaveClass('is-disabled');
    expect(cashierOption).toHaveTextContent(/No outstanding COD handover amount remains/i);
    await user.click(cashierOption);

    expect(screen.queryByRole('dialog', { name: /Cashier count - 26003UXTM/i })).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('per-row "Adjust collected" opens a typed modal and fires ui_adjust_cod_collection_v1 with signed adjustment payload', async () => {
    const spy = vi.spyOn(api, 'ui_adjust_cod_collection_v1').mockResolvedValue({
      ok: true,
      finance_event_id: 'fe_adjust_test',
      correlation_id: 'cor_test_cod_adjust_1',
    } as Awaited<ReturnType<typeof api.ui_adjust_cod_collection_v1>>);
    const promptSpy = vi.spyOn(window, 'prompt');

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write'],
    });
    await waitFor(() => {
      expect(document.querySelectorAll('table').length).toBeGreaterThan(0);
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /Adjust collected/i }));

    const dialog = await screen.findByRole('dialog', { name: /Adjust cashier count/i });
    const amount = within(dialog).getByLabelText(/Adjustment amount/i);
    const reason = within(dialog).getByLabelText(/Reason/i);
    await user.type(amount, '-15');
    await user.type(reason, 'cashier correction');
    await user.click(within(dialog).getByRole('button', { name: /Record adjustment/i }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]![0]).toMatchObject({
      cod_entry_id: 'cod_1',
      adjustment_amount: -15,
      currency: 'SAR',
      reason: 'cashier correction',
    });
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('keeps the operator on COD reconciliation and shows adjustment readback without reload', async () => {
    window.history.pushState(null, '', '/finance/cod');
    let adjusted = false;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource) => {
      if (resource !== 'cod_entries') return { rows: [], total: 0 };
      return {
        rows: [
          {
            id: 'cod_adjust_readback_1',
            organization_id: 'org_rashed',
            subject_id: 'shipment_cod_adjust_1',
            currency: 'SAR',
            collected_at: '2026-05-15T05:26:47.233Z',
            created_at: '2026-05-15T05:26:47.322Z',
            metadata: {
              tracking: 'COD-ADJUST-READBACK',
              expected: 240,
              collected: adjusted ? 225 : 240,
              remitted: 0,
              discrepancy: adjusted ? -15 : 0,
              status: adjusted ? 'shortfall' : 'collected',
            },
          },
        ],
        total: 1,
      };
    });
    vi.spyOn(api, 'compute_cod_payment_collection_summary_v1').mockImplementation(async (scope) => ({
      scope,
      expected: 240,
      collected: adjusted ? 225 : 240,
      remitted: 0,
      variance: adjusted ? -15 : 0,
    }));
    vi.spyOn(api, 'ui_adjust_cod_collection_v1').mockImplementation(async () => {
      adjusted = true;
      return {
        ok: true,
        finance_event_id: 'fe_adjust_readback_1',
        correlation_id: 'cor_adjust_readback_1',
      } as Awaited<ReturnType<typeof api.ui_adjust_cod_collection_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      capabilities: ['cod.read', 'finance.read', 'finance.write'],
      identity: {
        capabilities: ['cod.read', 'finance.read', 'finance.write'],
        user: { organization_id: 'org_rashed' },
      },
    });

    expect(await screen.findByText('COD-ADJUST-READBACK')).toBeInTheDocument();
    expect(screen.getByText('collected')).toBeInTheDocument();
    expect(screen.getAllByText('240').length).toBeGreaterThanOrEqual(1);

    await user.click((await screen.findAllByRole('button', { name: /Row actions/ }))[0]!);
    await user.click(await screen.findByRole('option', { name: /Adjust collected/i }));

    const dialog = await screen.findByRole('dialog', { name: /Adjust cashier count - COD-ADJUST-READBACK/i });
    await user.type(within(dialog).getByLabelText(/Adjustment amount/i), '-15');
    await user.type(within(dialog).getByLabelText(/Reason/i), 'cashier recount readback');
    await user.click(within(dialog).getByRole('button', { name: /Record adjustment/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Adjust cashier count/i })).not.toBeInTheDocument();
      const row = Array.from(document.querySelectorAll('.dt__table tbody tr')).find((tr) =>
        tr.textContent?.includes('COD-ADJUST-READBACK'),
      ) as HTMLElement | undefined;
      expect(row).toBeTruthy();
      expect(row!.textContent).toContain('225');
      expect(row!.textContent).toContain('-15');
      expect(row!.textContent).toContain('shortfall');
    });
    expect(screen.getByText('94%')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/finance/cod');
  });
});
