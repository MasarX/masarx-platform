// route-plans.lifecycle.test.tsx — closes OPERATIONS reaudit D2 for the
// route-plans surface. Adds per-RPC Vitest assertions for the Solve / Freeze
// / Publish / Apply / Rebalance / Validate / Create lifecycle actions that
// previously had no direct mutation test (`route-plans.test.tsx` only mounted
// the module and `route-plans.wave-catalog.test.tsx` only covered the read
// seam).
//
// Asserted behavior per action:
//   1. mount + capability gate (positive + negative) — buttons exist and are
//      disabled when `route_plans.write` is missing.
//   2. happy path — clicking the button fires the canonical RPC with the
//      expected payload shape (plan id / move list / etc.).
//   3. mutation invalidation — the route_plans list query is invalidated
//      after a successful mutation (cache fan-out).
//   4. failure mode — when the RPC rejects, an error toast surfaces.
//
// Pattern mirrors `dispatch.assign-driver.test.tsx`: spy on the
// `data-source` seam, render the live module, click the action, assert call
// args + invalidation. We avoid asserting on the toast DOM directly because
// the toast store renders into a portal that isn't part of the module tree;
// instead we assert that the spy was called or rejected with the expected
// args, which is the deterministic invariant.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { RoutePlansModule } from '@/modules/operate/route-plans';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';
import * as supabase from '@/lib/supabase';
import { clearToasts, getToasts } from '@/components/toastStore';
import { ROUTE_PLAN_FIXTURE_IDS, routePlanningListResource } from './route-plans.fixtures';

const SOLVE_SPY = vi.spyOn(ds, 'ui_solve_route_plan_v1');
const FREEZE_SPY = vi.spyOn(ds, 'ui_freeze_route_plan_v1');
const PUBLISH_SPY = vi.spyOn(ds, 'ui_publish_route_plan_v1');
const APPLY_SPY = vi.spyOn(ds, 'ui_apply_route_plan_v1');
const VALIDATE_SPY = vi.spyOn(ds, 'route_plan_validate_constraints_v1');
const CREATE_SPY = vi.spyOn(ds, 'ui_create_route_plan_v1');
const REBALANCE_SPY = vi.spyOn(ds, 'ui_rebalance_route_plan_v1');
const API_GET_RESOURCE = api.ui_get_resource_v1;
const API_GET_SPY = vi.spyOn(api, 'ui_get_resource_v1');
const GET_RESOURCE = ds.ui_get_resource_v1;
const GET_SPY = vi.spyOn(ds, 'ui_get_resource_v1');
const LIST_RESOURCE = ds.ui_list_resource_v1;
const COMPLETE_LIST_RESOURCE = ds.ui_list_resource_complete;

function routePlanCandidateList(opts?: Parameters<typeof ds.ui_list_resource_v1>[1]) {
  const branchId = String(opts?.filter?.branch_id ?? 'hub_jed');
  const plannedDate = String(opts?.filter?.planned_date ?? '2026-05-07');
  return {
    rows: [
      {
        id: 'shp_route_plan_candidate_eligible',
        sequence_order: 1,
        shipment_id: 'shp_route_plan_candidate_eligible',
        client_id: 'client_route_plan_candidate',
        branch_id: branchId,
        zone_id: 'zone_candidate_north',
        service_level: 'express',
        promised_delivery_date: plannedDate,
        promised_window_start_at: `${plannedDate}T08:00:00Z`,
        promised_window_end_at: `${plannedDate}T10:00:00Z`,
        priority_score: 80,
        tracking_number: 'MX-ELIGIBLE',
        stop_payload: {
          shipment_id: 'shp_route_plan_candidate_eligible',
          client_id: 'client_route_plan_candidate',
          stop_kind: 'delivery',
          sequence_order: 1,
          planned_window_start_at: `${plannedDate}T08:00:00Z`,
          planned_window_end_at: `${plannedDate}T10:00:00Z`,
          metadata: {
            source: 'delivery_wave_builder',
            service_level: 'express',
            tracking_number: 'MX-ELIGIBLE',
          },
        },
      },
    ],
    total: 1,
  };
}

function firstTenantRoutePlanCandidateList(opts?: Parameters<typeof ds.ui_list_resource_v1>[1]) {
  const branchId = String(opts?.filter?.branch_id ?? 'hub_jed');
  const plannedDate = String(opts?.filter?.planned_date ?? '2026-05-07');
  const shipmentId = '7065299a-02bd-49a4-b037-1972b71eefa0';
  return {
    rows: [
      {
        id: shipmentId,
        sequence_order: 1,
        shipment_id: shipmentId,
        client_id: 'client_route_plan_candidate',
        branch_id: branchId,
        zone_id: 'zone_candidate_north',
        service_level: 'standard',
        promised_delivery_date: plannedDate,
        promised_window_start_at: `${plannedDate}T09:00:00Z`,
        promised_window_end_at: `${plannedDate}T11:00:00Z`,
        priority_score: 95,
        tracking_number: '26007QJTZ',
        stop_payload: {
          shipment_id: shipmentId,
          client_id: 'client_route_plan_candidate',
          stop_kind: 'delivery',
          sequence_order: 1,
          planned_window_start_at: `${plannedDate}T09:00:00Z`,
          planned_window_end_at: `${plannedDate}T11:00:00Z`,
          metadata: {
            source: 'delivery_wave_builder',
            service_level: 'standard',
            tracking_number: '26007QJTZ',
          },
        },
      },
    ],
    total: 1,
  };
}

function mockShipmentContextRead(shipmentId: string, marker: string, trackingNumber: string) {
  return vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
    if (resource === 'shipments' && id === shipmentId) {
      return {
        id,
        tracking_number: trackingNumber,
        status: 'created',
        service_type: 'express',
        client_reference_number: marker,
      };
    }
    return GET_RESOURCE(resource, id);
  });
}

function mockRoutePlanResourceRead(
  implementation: (resource: string, id: string) => ReturnType<typeof api.ui_get_resource_v1>,
) {
  GET_SPY.mockImplementation(implementation);
  API_GET_SPY.mockImplementation(implementation);
}

beforeEach(() => {
  window.history.pushState(null, '', '/operate/route-plans');
  clearToasts();
  vi.spyOn(supabase, 'rpc').mockResolvedValue(null);
  vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation((key, opts) =>
    routePlanningListResource(key, opts, LIST_RESOURCE),
  );
  SOLVE_SPY.mockClear();
  SOLVE_SPY.mockResolvedValue({ ok: true, plan_id: 'rpl_fixture_alpha', status: 'solved' });
  FREEZE_SPY.mockClear();
  FREEZE_SPY.mockResolvedValue({
    ok: true,
    plan_id: 'rpl_fixture_alpha',
    status: 'frozen',
    constraint_validation: { fail_count: 0 },
  });
  PUBLISH_SPY.mockClear();
  PUBLISH_SPY.mockResolvedValue({
    ok: true,
    plan_id: 'rpl_fixture_alpha',
    execution_pack_hash: 'pack_fixture_alpha',
  });
  APPLY_SPY.mockClear();
  APPLY_SPY.mockResolvedValue({
    ok: true,
    plan_id: 'rpl_fixture_alpha',
    status: 'applied',
    runs_materialized: 1,
  });
  VALIDATE_SPY.mockClear();
  VALIDATE_SPY.mockResolvedValue({
    ok: true,
    plan_id: 'rpl_fixture_alpha',
    fail_count: 0,
    items: [{ name: 'Fixture validation', passed: 1, failed: 0, status: 'pass' }],
  });
  CREATE_SPY.mockClear();
  CREATE_SPY.mockResolvedValue({
    ok: true,
    route_plan_id: 'rpl_fixture_created',
    status: 'draft',
    plan_id: 'RPL-FIX-CREATED',
  });
  REBALANCE_SPY.mockClear();
  REBALANCE_SPY.mockResolvedValue({
    ok: true,
    plan_id: 'rpl_fixture_alpha',
    moves_applied: 1,
  });
  GET_SPY.mockClear();
  GET_SPY.mockImplementation((resource, id) => GET_RESOURCE(resource, id));
  API_GET_SPY.mockClear();
  API_GET_SPY.mockImplementation((resource, id) => API_GET_RESOURCE(resource, id));
});

async function openFirstRowDrawer() {
  const user = userEvent.setup();
  await waitFor(() => {
    expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
  });
  await user.click(document.querySelector('.dt__table tbody tr') as Element);
  await waitFor(() => {
    expect(document.querySelector('.drawer__footer')).not.toBeNull();
  });
  return user;
}

function findFooterButton(label: RegExp): HTMLElement {
  const footer = document.querySelector('.drawer__footer');
  if (!footer) throw new Error('drawer footer not rendered');
  // Match against the first <span> child (the label) so CapabilityLock chip
  // text (e.g. "route_plans.write") doesn't confuse the regex.
  const btn = Array.from(footer.querySelectorAll('button')).find((b) => {
    const span = b.querySelector('span');
    return label.test((span?.textContent ?? b.textContent ?? '').trim());
  });
  if (!btn) throw new Error(`footer button matching ${label} not found`);
  return btn as HTMLElement;
}

async function selectFirstBulkRows(count: number) {
  const user = userEvent.setup();
  await waitFor(() => {
    expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThanOrEqual(count);
  });
  const checkboxes = screen.getAllByLabelText('Select row');
  expect(checkboxes.length).toBeGreaterThanOrEqual(count);
  for (const checkbox of checkboxes.slice(0, count)) {
    await user.click(checkbox);
  }
  await waitFor(() => {
    expect(document.querySelector('.dt-bulkbar')).not.toBeNull();
  });
  return user;
}

function findBulkButton(label: RegExp): HTMLElement {
  const bar = document.querySelector('.dt-bulkbar');
  if (!bar) throw new Error('bulk action bar not rendered');
  const btn = Array.from(bar.querySelectorAll('button')).find((button) =>
    label.test((button.textContent ?? '').trim()),
  );
  if (!btn) throw new Error(`bulk button matching ${label} not found`);
  return btn as HTMLElement;
}

async function rowActionButtonAt(index: number): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.getAllByRole('button', { name: 'Row actions' }).length).toBeGreaterThan(index);
  });
  return screen.getAllByRole('button', { name: 'Row actions' })[index] as HTMLElement;
}

function expectInvalidatedResource(invalidate: { mock: { calls: unknown[][] } }, resource: string) {
  const calls = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg));
  expect(calls.some((call) => call.includes(`"${resource}"`))).toBe(true);
}

function expectInvalidatedCompleteResource(invalidate: { mock: { calls: unknown[][] } }, resource: string) {
  const calls = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg));
  expect(calls.some((call) => call.includes(`"${resource}"`) && call.includes('"complete"'))).toBe(true);
}

describe('RoutePlansModule · lifecycle mutations (OPERATIONS reaudit D2)', () => {
  it('fails closed when the canonical route-plan list read rejects', async () => {
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_plans') throw new Error('api.route_plans unavailable');
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });

    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: ['route_plans.read'] });
      expect(await screen.findByText(/Route-plan inventory failed/i)).toBeInTheDocument();
      expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
      expect(screen.queryByText(/api.route_plans unavailable/i)).not.toBeInTheDocument();
      expect(document.querySelector('.dt__table')).toBeNull();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('disables Solve / Freeze / Publish / Apply / Rebalance footer buttons when route_plans.write is missing', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['route_plans.read'] });
    await openFirstRowDrawer();
    expect(findFooterButton(/^Solve$/)).toBeDisabled();
    expect(findFooterButton(/^Freeze$/)).toBeDisabled();
    expect(findFooterButton(/^Publish$/)).toBeDisabled();
    expect(findFooterButton(/^Apply$/)).toBeDisabled();
    expect(findFooterButton(/Rebalance/)).toBeDisabled();
    // CapabilityLock chips surface the missing capability.
    expect(screen.getAllByText(/Route plan update permission required/i).length).toBeGreaterThan(0);
  });

  it('keeps cross-tenant route-plan lifecycle actions inspectable but not mutable', async () => {
    const tenantReason = "Switch to this route plan's tenant before changing route-plan lifecycle.";
    const bulkTenantReason = "Switch to each selected route plan's tenant before changing route-plan lifecycle.";
    const crossTenantPlan = {
      id: ROUTE_PLAN_FIXTURE_IDS.alpha,
      organization_id: 'org_other_tenant',
      branch_id: ROUTE_PLAN_FIXTURE_IDS.hub,
      planned_date: '2026-05-07',
      status: 'draft',
      updated_at: '2026-05-07T08:00:00.000Z',
      metadata: { wave_label: 'Morning', wave_key: 'wave_morning' },
      inputs: { wave_id: 'wave_morning', wave_label: 'Morning' },
      solution: { stops: [] },
    };
    const crossTenantDirectory = {
      ...crossTenantPlan,
      plan_display_id: 'RPL-CROSS-A',
      branch_label: 'JED Main Hub',
      branch_code: 'JED',
      wave_label: 'Morning',
      wave_key: 'wave_morning',
      stop_count: 1,
      run_count: 1,
      drivers_notified_count: 0,
      is_applied: false,
    };
    vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_plans') return { rows: [crossTenantPlan], total: 1 } as never;
      if (key === 'route_plan_directory') return { rows: [crossTenantDirectory], total: 1 } as never;
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });
    GET_SPY.mockImplementation(async (resource, id) => {
      if (id === ROUTE_PLAN_FIXTURE_IDS.alpha && resource === 'route_plans') return crossTenantPlan;
      if (id === ROUTE_PLAN_FIXTURE_IDS.alpha && resource === 'route_plan_directory') return crossTenantDirectory;
      return GET_RESOURCE(resource, id);
    });

    const user = userEvent.setup();
    renderWithProviders(<RoutePlansModule />, {
      identity: {
        capabilities: ['all'],
        user: { organization_id: 'org_rashed', access_scope_type: 'tenant' },
        scope: { tenant: { id: 'org_rashed', label: 'First Tenant', rank: 2 } },
      },
    });
    await waitFor(() => {
      expect(screen.getByText('RPL-CROSS-A')).toBeInTheDocument();
    });

    await user.click(screen.getAllByLabelText('Select row')[0]!);
    for (const label of ['Solve sequence', 'Freeze', 'Publish', 'Apply']) {
      const button = screen.getByRole('button', { name: new RegExp(`^${label}$`) });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', bulkTenantReason);
      await user.click(button).catch(() => undefined);
    }

    await user.click(await rowActionButtonAt(0));
    for (const label of ['Solve', 'Freeze', 'Publish', 'Apply', 'Rebalance']) {
      const option = await screen.findByRole('option', { name: new RegExp(`^${label}`) });
      expect(option).toHaveClass('is-disabled');
      expect(option).toHaveTextContent(tenantReason);
      await user.click(option).catch(() => undefined);
    }

    await user.keyboard('{Escape}');
    await openFirstRowDrawer();
    for (const label of [/^Solve$/, /^Freeze$/, /^Publish$/, /^Apply$/, /Rebalance/]) {
      const button = findFooterButton(label);
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', tenantReason);
      await user.click(button).catch(() => undefined);
    }

    expect(SOLVE_SPY).not.toHaveBeenCalled();
    expect(FREEZE_SPY).not.toHaveBeenCalled();
    expect(PUBLISH_SPY).not.toHaveBeenCalled();
    expect(APPLY_SPY).not.toHaveBeenCalled();
    expect(REBALANCE_SPY).not.toHaveBeenCalled();
  });

  it('Solve fires ui_solve_route_plan_v1 with the plan id and invalidates the list', async () => {
    const { queryClient } = renderWithProviders(<RoutePlansModule />, {
      capabilities: ['all'],
    });
    const user = await openFirstRowDrawer();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(findFooterButton(/^Solve$/));
    await waitFor(() => {
      expect(SOLVE_SPY).toHaveBeenCalled();
    });
    const [planId] = SOLVE_SPY.mock.calls[0] as [string];
    expect(typeof planId).toBe('string');
    expect(planId.length).toBeGreaterThan(0);
    await waitFor(() => {
      expectInvalidatedResource(invalidate, 'route_plans');
      expectInvalidatedResource(invalidate, 'route_plan_directory');
    });
  });

  it('Freeze fires ui_freeze_route_plan_v1 with the plan id', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = await openFirstRowDrawer();
    await user.click(findFooterButton(/^Freeze$/));
    await waitFor(() => {
      expect(FREEZE_SPY).toHaveBeenCalled();
    });
    const [planId] = FREEZE_SPY.mock.calls[0] as [string];
    expect(typeof planId).toBe('string');
    expect(planId.length).toBeGreaterThan(0);
  });

  it('updates the open route-plan drawer from backend readback after Freeze without reopening', async () => {
    let liveStatus = 'draft';
    GET_SPY.mockImplementation(async (resource, id) => {
      if (id === ROUTE_PLAN_FIXTURE_IDS.alpha && resource === 'route_plans') {
        return {
          id,
          organization_id: 'org_rashed',
          branch_id: ROUTE_PLAN_FIXTURE_IDS.hub,
          planned_date: '2026-05-07',
          status: liveStatus,
          updated_at: '2026-05-07T08:00:00.000Z',
          metadata: { wave_label: 'Morning', wave_key: 'wave_morning' },
          inputs: { wave_id: 'wave_morning', wave_label: 'Morning' },
          solution: { stops: [] },
        };
      }
      if (id === ROUTE_PLAN_FIXTURE_IDS.alpha && resource === 'route_plan_directory') {
        return {
          id,
          organization_id: 'org_rashed',
          branch_id: ROUTE_PLAN_FIXTURE_IDS.hub,
          planned_date: '2026-05-07',
          status: liveStatus,
          plan_display_id: 'RPL-FIX-A',
          branch_label: 'JED Main Hub',
          branch_code: 'JED',
          wave_label: 'Morning',
          wave_key: 'wave_morning',
          stop_count: 1,
          run_count: liveStatus === 'frozen' ? 2 : 1,
          drivers_notified_count: 0,
          is_applied: false,
          updated_at: '2026-05-07T08:10:00.000Z',
        };
      }
      return GET_RESOURCE(resource, id);
    });
    FREEZE_SPY.mockImplementationOnce(async () => {
      liveStatus = 'frozen';
      return {
        ok: true,
        plan_id: ROUTE_PLAN_FIXTURE_IDS.alpha,
        status: 'frozen',
        constraint_validation: { fail_count: 0 },
      };
    });

    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = await openFirstRowDrawer();
    const drawer = document.querySelector('.drawer') as HTMLElement;
    await waitFor(() => {
      expect(within(drawer).getAllByText('Draft').length).toBeGreaterThan(0);
    });

    await user.click(findFooterButton(/^Freeze$/));

    await waitFor(() => {
      expect(within(drawer).getAllByText('Frozen').length).toBeGreaterThan(0);
    });
    expect(GET_SPY.mock.calls.some(([resource, id]) =>
      resource === 'route_plan_directory' && id === ROUTE_PLAN_FIXTURE_IDS.alpha,
    )).toBe(true);
  });

  it('Publish fires ui_publish_route_plan_v1 with the plan id', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = await openFirstRowDrawer();
    await user.click(findFooterButton(/^Publish$/));
    await waitFor(() => {
      expect(PUBLISH_SPY).toHaveBeenCalled();
    });
    const [planId] = PUBLISH_SPY.mock.calls[0] as [string];
    expect(typeof planId).toBe('string');
    expect(planId.length).toBeGreaterThan(0);
  });

  it('Apply fires ui_apply_route_plan_v1 with the plan id and invalidates route-plan and dispatch projections', async () => {
    const { queryClient } = renderWithProviders(<RoutePlansModule />, {
      capabilities: ['all'],
    });
    const user = await openFirstRowDrawer();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(findFooterButton(/^Apply$/));
    await waitFor(() => {
      expect(APPLY_SPY).toHaveBeenCalled();
    });
    const [planId] = APPLY_SPY.mock.calls[0] as [string];
    expect(typeof planId).toBe('string');
    expect(planId.length).toBeGreaterThan(0);
    await waitFor(() => {
      expectInvalidatedResource(invalidate, 'route_plans');
      expectInvalidatedResource(invalidate, 'route_plan_directory');
      expectInvalidatedResource(invalidate, 'route_runs');
      expectInvalidatedResource(invalidate, 'route_stops');
      expectInvalidatedResource(invalidate, 'route_run_directory');
      expectInvalidatedCompleteResource(invalidate, 'route_runs');
      expectInvalidatedCompleteResource(invalidate, 'route_stops');
      expectInvalidatedCompleteResource(invalidate, 'route_run_directory');
      expectInvalidatedCompleteResource(invalidate, 'route_run_assignments');
      expectInvalidatedCompleteResource(invalidate, 'route_run_assignment_events');
      expectInvalidatedCompleteResource(invalidate, 'route_stop_reassignment_events');
      expectInvalidatedCompleteResource(invalidate, 'tasks');
    });
  });

  it('Validate-constraints panel calls route_plan_validate_constraints_v1 for the open plan', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = await openFirstRowDrawer();
    // PlanValidatePanel renders a `Run validation` button in idle state.
    const runBtn = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.drawer button')).find((b) =>
        /^Run validation$/.test(b.textContent ?? ''),
      );
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    await user.click(runBtn);
    await waitFor(() => {
      expect(VALIDATE_SPY).toHaveBeenCalled();
    });
    const [planId] = VALIDATE_SPY.mock.calls[0] as [string];
    expect(typeof planId).toBe('string');
    expect(planId.length).toBeGreaterThan(0);
  });

  it('keeps drawer constraint validation available with route_plans.read only', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['route_plans.read'] });
    await openFirstRowDrawer();
    const runBtn = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.drawer button')).find((b) =>
        /^Run validation$/.test(b.textContent ?? ''),
      );
      expect(found).toBeTruthy();
      return found as HTMLButtonElement;
    });
    expect(runBtn).not.toBeDisabled();
  });

  it('drawer map reloads the selected plan stops, shipments, and geocodes through scoped backend reads', async () => {
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_runs' && opts?.filter?.route_plan_id) {
        return {
          rows: [{ id: 'run_scoped_map', route_plan_id: String(opts.filter.route_plan_id), metadata: {} }],
          total: 1,
        };
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });
    const completeListSpy = vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
      if (key === 'route_stops' && opts?.filter?.route_run_id === 'run_scoped_map') {
        return {
          rows: [
            {
              id: 'stop_scoped_map',
              route_run_id: 'run_scoped_map',
              shipment_id: 'shipment_scoped_map',
              sequence_order: 1,
            },
          ],
          total: 1,
        };
      }
      if (key === 'geocodes' && opts?.filter?.address_id === 'address_scoped_map') {
        return {
          rows: [
            {
              id: 'geo_scoped_map',
              address_id: 'address_scoped_map',
              lat: 24.7136,
              lng: 46.6753,
              confidence_score: 0.94,
              provider_name: 'registry-projection',
              is_primary: true,
            },
          ],
          total: 1,
        };
      }
      return COMPLETE_LIST_RESOURCE(key, opts);
    });
    const getSpy = vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (key, id) => {
      if (key === 'shipments' && id === 'shipment_scoped_map') {
        return {
          id: 'shipment_scoped_map',
          tracking_number: 'SHP-SCOPED-MAP',
          destination_address_id: 'address_scoped_map',
        };
      }
      return GET_RESOURCE(key, id);
    });
    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
      await openFirstRowDrawer();
      await waitFor(() => {
        expect(
          screen.getByRole('img', { name: '#1 SHP-SCOPED-MAP, registry-projection geocode - 94%' }),
        ).toBeInTheDocument();
      });

      await waitFor(() => {
        const listCalls = listSpy.mock.calls.map(([resource, opts]) => ({
          resource,
          filter: opts?.filter,
        }));
        const completeListCalls = completeListSpy.mock.calls.map(([resource, opts]) => ({
          resource,
          filter: opts?.filter,
        }));
        expect(listCalls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              resource: 'route_runs',
              filter: expect.objectContaining({ route_plan_id: expect.any(String) }),
            }),
          ]),
        );
        expect(completeListCalls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              resource: 'route_stops',
              filter: expect.objectContaining({ route_run_id: expect.any(String) }),
            }),
            expect.objectContaining({
              resource: 'geocodes',
              filter: expect.objectContaining({ address_id: expect.any(String) }),
            }),
          ]),
        );
        expect(getSpy.mock.calls).toEqual(
          expect.arrayContaining([
            expect.arrayContaining(['shipments', expect.any(String)]),
          ]),
        );
      });
    } finally {
      listSpy.mockRestore();
      completeListSpy.mockRestore();
      getSpy.mockReset();
    }
  });

  it('bulk Solve reports partial success without hiding the successful selected plan', async () => {
    SOLVE_SPY.mockResolvedValueOnce({ ok: true, plan_id: 'rpl_bulk_success', status: 'solved' });
    SOLVE_SPY.mockRejectedValueOnce(new Error('solver blocked plan'));
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = await selectFirstBulkRows(2);
    await user.click(findBulkButton(/^Solve sequence$/));
    await waitFor(() => {
      expect(SOLVE_SPY).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const toast = getToasts().find((entry) => entry.message.includes('Solved partially'));
      expect(toast).toMatchObject({ tone: 'warn' });
      expect(toast?.message).toContain('1 succeeded, 1 failed');
      expect(toast?.message).toContain('solver blocked plan');
    });
  });

  it('bulk Apply reports all selected failures clearly', async () => {
    APPLY_SPY.mockRejectedValueOnce(new Error('execution pack missing'));
    APPLY_SPY.mockRejectedValueOnce(new Error('route plan is not published'));
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = await selectFirstBulkRows(2);
    await user.click(findBulkButton(/^Apply$/));
    await waitFor(() => {
      expect(APPLY_SPY).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const toast = getToasts().find((entry) => entry.message.includes('Apply failed'));
      expect(toast).toMatchObject({ tone: 'danger' });
      expect(toast?.message).toContain('2 failed');
      expect(toast?.message).toContain('execution pack missing');
      expect(toast?.message).toContain('route plan is not published');
    });
  });

  it('surfaces an error path when ui_solve_route_plan_v1 rejects (no unhandled exception)', async () => {
    SOLVE_SPY.mockRejectedValueOnce(new Error('seed-side solver outage'));
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = await openFirstRowDrawer();
    await user.click(findFooterButton(/^Solve$/));
    await waitFor(() => {
      expect(SOLVE_SPY).toHaveBeenCalled();
    });
    // The mutation hook handles the rejection; the test asserts the call
    // was made even when the RPC rejects (i.e. error path doesn't bypass
    // the canonical seam).
    expect(SOLVE_SPY).toHaveBeenCalledTimes(1);
    // Restore for downstream tests in this file.
    SOLVE_SPY.mockReset();
  });

  it('New plan picker reads canonical candidate rows and does not offer ineligible shipments', async () => {
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_plan_delivery_wave_candidates') {
        return routePlanCandidateList(opts);
      }
      if (key === 'shipments') {
        return {
          rows: [
            {
              id: 'shp_route_plan_candidate_ineligible',
              client_id: 'client_route_plan_candidate',
              tracking_number: 'MX-INELIGIBLE',
              status: 'cancelled',
            },
          ],
          total: 1,
        };
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });

    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = userEvent.setup();
    const newBtn = await screen.findByRole('button', { name: /New plan/ });
    await user.click(newBtn);
    const dateInput = await screen.findByLabelText('Plan date');
    await user.clear(dateInput);
    await user.type(dateInput, '2026-05-07');

    expect(await screen.findByLabelText('Select candidate MX-ELIGIBLE')).toBeInTheDocument();
    expect(screen.getByText('MX-ELIGIBLE')).toBeInTheDocument();
    expect(screen.getByText(/express/)).toBeInTheDocument();
    expect(screen.getByText('2026-05-07')).toBeInTheDocument();
    expect(screen.getByText(/priority 80/)).toBeInTheDocument();
    expect(screen.queryByText('MX-INELIGIBLE')).not.toBeInTheDocument();
    expect(listSpy.mock.calls.some(([key]) => key === 'shipments')).toBe(false);

    listSpy.mockRestore();
  });

  it('New plan date input refetches backend candidates and enables Create in the same modal', async () => {
    const expectedDateValue = new Date();
    expectedDateValue.setUTCDate(expectedDateValue.getUTCDate() + 1);
    const expectedDate = expectedDateValue.toISOString().slice(0, 10);
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_stops') {
        return { rows: [], total: 0 };
      }
      if (key === 'route_plan_delivery_wave_candidates') {
        const filter = opts?.filter ?? {};
        const plannedDate = String(filter.planned_date ?? '');
        if (plannedDate !== expectedDate) {
          return { rows: [], total: 0 };
        }
        return {
          rows: [
            {
              id: '4d77924c-50ad-4b9f-9456-65fcf39c49eb',
              sequence_order: 1,
              shipment_id: '4d77924c-50ad-4b9f-9456-65fcf39c49eb',
              client_id: '4e2442f8-2b5b-4aaa-9ea3-b1c7be15f919',
              branch_id: String(filter.branch_id ?? 'hub_jed'),
              zone_id: 'zone_route_candidate',
              service_level: 'cod',
              promised_delivery_date: expectedDate,
              promised_window_start_at: `${expectedDate}T08:00:00Z`,
              promised_window_end_at: `${expectedDate}T12:00:00Z`,
              priority_score: 90,
              tracking_number: '26000001R',
              stop_payload: {
                shipment_id: '4d77924c-50ad-4b9f-9456-65fcf39c49eb',
                client_id: '4e2442f8-2b5b-4aaa-9ea3-b1c7be15f919',
                stop_kind: 'delivery',
                sequence_order: 1,
                planned_window_start_at: `${expectedDate}T08:00:00Z`,
                planned_window_end_at: `${expectedDate}T12:00:00Z`,
                metadata: {
                  source: 'delivery_wave_builder',
                  service_level: 'cod',
                  tracking_number: '26000001R',
                },
              },
            },
          ],
          total: 1,
        };
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });

    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /New plan/ }));

    expect(await screen.findByText('No eligible route-plan candidates')).toBeInTheDocument();
    const modal = document.querySelector('.modal') as HTMLElement;
    expect(within(modal).getByRole('button', { name: /^Create$/ })).toBeDisabled();

    const dateInput = within(modal).getByLabelText('Plan date');
    fireEvent.input(dateInput, { target: { value: expectedDate } });

    const candidateCheckbox = await within(modal).findByLabelText('Select candidate 26000001R');
    expect(candidateCheckbox).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: /^Create$/ })).toBeDisabled();
    await user.click(candidateCheckbox);
    await waitFor(() => {
      expect(within(modal).getByRole('button', { name: /^Create$/ })).not.toBeDisabled();
    });
    expect(
      listSpy.mock.calls.some(([key, opts]) =>
        key === 'route_plan_delivery_wave_candidates' &&
        opts?.filter?.planned_date === expectedDate &&
        Boolean(opts?.filter?.organization_id),
      ),
    ).toBe(true);

    listSpy.mockRestore();
  });

  it('New plan candidate shipment reference opens the shared shipment context drawer in place', async () => {
    const shipmentId = 'shp_route_plan_candidate_eligible';
    const marker = 'READ-BACKED-NEW-PLAN-CANDIDATE';
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_plan_delivery_wave_candidates') {
        return routePlanCandidateList(opts);
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });
    const getSpy = mockShipmentContextRead(shipmentId, marker, 'MX-ELIGIBLE');

    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: /New plan/ }));

      const reference = await screen.findByRole('button', {
        name: 'Open shipment context MX-ELIGIBLE',
      });
      await user.click(reference);

      const drawer = await waitFor(() => {
        const el = document.querySelector('.drawer') as HTMLElement | null;
        expect(el).not.toBeNull();
        return el!;
      });
      await waitFor(() => {
        expect(getSpy.mock.calls.some(([resource, id]) => resource === 'shipments' && id === shipmentId)).toBe(true);
      });
      expect(await within(drawer).findByText(marker)).toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
      getSpy.mockReset();
    }
  });

  it('Create fires ui_create_route_plan_v1 with backend-canonical branch_id/planned_date/input metadata from the modal', async () => {
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_stops') {
        return { rows: [], total: 0 };
      }
      if (key === 'route_plan_delivery_wave_candidates') {
        return routePlanCandidateList(opts);
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('button', { name: /New plan/ }));
    // The modal exposes pickers + a date input + a Create button.
    await waitFor(() => {
      expect(screen.getByLabelText('Pick hub')).toBeInTheDocument();
    });
    const shipmentCheckbox = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.modal input[type="checkbox"]')).find((el) =>
        /^Select candidate /.test((el as HTMLInputElement).getAttribute('aria-label') ?? '') &&
        !(el as HTMLInputElement).disabled,
      );
      expect(found).toBeTruthy();
      return found as HTMLInputElement;
    });
    if (!shipmentCheckbox.checked) {
      await user.click(shipmentCheckbox);
    }
    // Click Create — defaults are pre-populated by the module (first hub +
    // first wave + today's date), and the selected shipment becomes a
    // canonical route-plan stop under inputs.stops.
    const createBtn = await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /^Create$/.test((b.textContent ?? '').trim()),
      );
      expect(btn).toBeTruthy();
      return btn as HTMLElement;
    });
    await user.click(createBtn);
    await waitFor(() => {
      expect(CREATE_SPY).toHaveBeenCalled();
    });
    const [input] = CREATE_SPY.mock.calls[0] as [{
      branch_id: string;
      planned_date: string;
      inputs: {
        wave_id?: string;
        wave_label?: string | null;
        branch_code?: string | null;
        stops?: Array<{
          shipment_id?: string;
          client_id?: string;
          sequence_order?: number;
          metadata?: { source?: string; selected_by?: string; tracking_number?: string | null };
        }>;
      };
      metadata: { source?: string; wave_id?: string; wave_label?: string | null; selected_shipment_count?: number };
    }];
    expect(typeof input.branch_id).toBe('string');
    expect(input.branch_id.length).toBeGreaterThan(0);
    expect(typeof input.planned_date).toBe('string');
    expect(input.planned_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(input.inputs.wave_id).toBeTruthy();
    expect(input.inputs.wave_label).toBeTruthy();
    expect(input.inputs.stops).toHaveLength(1);
    expect(input.inputs.stops?.[0]?.shipment_id).toBeTruthy();
    expect(input.inputs.stops?.[0]?.client_id).toBeTruthy();
    expect(input.inputs.stops?.[0]?.sequence_order).toBe(1);
    expect(input.inputs.stops?.[0]?.metadata?.source).toBe('delivery_wave_builder');
    expect(input.inputs.stops?.[0]?.metadata?.selected_by).toBe('console_v2.route_plans.create');
    expect(input.metadata.source).toBe('console_v2.route_plans.create');
    expect(input.metadata.selected_shipment_count).toBe(1);
    expect(input).not.toHaveProperty('hub');
    expect(input).not.toHaveProperty('wave');
    expect(input).not.toHaveProperty('date');
    listSpy.mockRestore();
  });

  it('Create can plan first-tenant shipment 26007QJTZ through the canonical candidate picker', async () => {
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_stops') {
        return { rows: [], total: 0 };
      }
      if (key === 'route_plan_delivery_wave_candidates') {
        return firstTenantRoutePlanCandidateList(opts);
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /New plan/ }));

    const firstTenantCandidate = await screen.findByLabelText('Select candidate 26007QJTZ');
    await user.click(firstTenantCandidate);

    const createBtn = await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /^Create$/.test((b.textContent ?? '').trim()),
      );
      expect(btn).toBeTruthy();
      expect(btn).not.toBeDisabled();
      return btn as HTMLElement;
    });
    await user.click(createBtn);

    await waitFor(() => {
      expect(CREATE_SPY).toHaveBeenCalled();
    });
    const [input] = CREATE_SPY.mock.calls[0] as [{
      inputs: {
        stops?: Array<{
          shipment_id?: string;
          metadata?: { tracking_number?: string | null; source?: string };
        }>;
      };
      metadata: { selected_shipment_count?: number };
    }];
    expect(input.inputs.stops?.[0]?.shipment_id).toBe('7065299a-02bd-49a4-b037-1972b71eefa0');
    expect(input.inputs.stops?.[0]?.metadata?.tracking_number).toBe('26007QJTZ');
    expect(input.inputs.stops?.[0]?.metadata?.source).toBe('delivery_wave_builder');
    expect(input.metadata.selected_shipment_count).toBe(1);

    listSpy.mockRestore();
  });

  it('opens API shipment handoff links into the new-plan picker with the shipment preselected', async () => {
    const user = userEvent.setup();
    const shipmentId = '7065299a-02bd-49a4-b037-1972b71eefa0';
    let createdVisible = false;
    window.history.pushState(null, '', `/operate/route-plans?shipment=${shipmentId}`);
    mockRoutePlanResourceRead(async (resource, id) => {
      if (resource === 'shipments' && id === shipmentId) {
        return {
          id,
          tracking_number: '26007QJTZ',
          status: 'pending',
          service_type: 'standard',
          promised_delivery_date: '2026-05-07',
        };
      }
      return GET_RESOURCE(resource, id);
    });
    CREATE_SPY.mockImplementationOnce(async () => {
      createdVisible = true;
      return {
        ok: true,
        route_plan_id: 'rpl_fixture_created',
        status: 'draft',
        plan_id: 'RPL-FIX-CREATED',
      };
    });
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_stops') {
        return { rows: [], total: 0 };
      }
      if (key === 'route_plan_delivery_wave_candidates') {
        return firstTenantRoutePlanCandidateList(opts);
      }
      if (createdVisible && key === 'route_plans') {
        const base = await routePlanningListResource(key, opts, LIST_RESOURCE);
        return {
          rows: [
            ...base.rows,
            {
              id: 'rpl_fixture_created',
              organization_id: 'org_rashed',
              branch_id: 'hub_jed',
              planned_date: '2026-05-07',
              status: 'draft',
              updated_at: '2026-05-15T00:35:00.000Z',
              metadata: { wave_label: 'Morning' },
              inputs: { wave_id: 'wave_morning', wave_label: 'Morning' },
              solution: { stops: [] },
            },
          ],
          total: base.total + 1,
        };
      }
      if (createdVisible && key === 'route_plan_directory') {
        const base = await routePlanningListResource(key, opts, LIST_RESOURCE);
        return {
          rows: [
            ...base.rows,
            {
              id: 'rpl_fixture_created',
              organization_id: 'org_rashed',
              branch_id: 'hub_jed',
              planned_date: '2026-05-07',
              status: 'draft',
              plan_display_id: 'RPL-FIX-CREATED',
              branch_label: 'JED Main Hub',
              branch_code: 'JED',
              wave_label: 'Morning',
              wave_key: 'wave_morning',
              stop_count: 1,
              run_count: 0,
              drivers_notified_count: 0,
              is_applied: false,
              updated_at: '2026-05-15T00:35:00.000Z',
            },
          ],
          total: base.total + 1,
        };
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });

    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });

      expect(await screen.findByText('API shipment handoff')).toBeInTheDocument();
      expect(await screen.findByText('26007QJTZ')).toBeInTheDocument();
      await screen.findByLabelText('Select candidate 26007QJTZ');
      await waitFor(() => {
        expect(screen.getByLabelText('Select candidate 26007QJTZ')).toBeChecked();
      });

      const createBtn = await waitFor(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          /^Create$/.test((b.textContent ?? '').trim()),
        );
        expect(btn).toBeTruthy();
        expect(btn).not.toBeDisabled();
        return btn as HTMLElement;
      });
      await user.click(createBtn);

      await waitFor(() => expect(CREATE_SPY).toHaveBeenCalled());
      const [input] = CREATE_SPY.mock.calls[0] as [{
        branch_id?: string;
        planned_date?: string;
        inputs: { stops?: Array<{ shipment_id?: string }> };
      }];
      expect(input.branch_id).toBe('hub_jed');
      expect(input.planned_date).toBe('2026-05-07');
      expect(input.inputs.stops?.[0]?.shipment_id).toBe(shipmentId);
      expect(await screen.findByText('RPL-FIX-CREATED')).toBeInTheDocument();
      expect(screen.getByText(/3 plans/i)).toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
      window.history.pushState(null, '', '/operate/route-plans');
    }
  });

  it('pins a focused API shipment at the top even when it is already in the selected hub candidate list', async () => {
    const shipmentId = '7065299a-02bd-49a4-b037-1972b71eefa0';
    window.history.pushState(null, '', `/operate/route-plans?shipment=${shipmentId}`);
    mockRoutePlanResourceRead(async (resource, id) => {
      if (resource === 'shipments' && id === shipmentId) {
        return {
          id,
          tracking_number: 'FT-LIVE-PINNED',
          status: 'pending',
          service_type: 'standard',
          promised_delivery_date: '2026-05-07',
        };
      }
      return GET_RESOURCE(resource, id);
    });
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_stops') {
        return { rows: [], total: 0 };
      }
      if (key === 'route_plan_delivery_wave_candidates') {
        const plannedDate = String(opts?.filter?.planned_date ?? '2026-05-07');
        const branchId = String(opts?.filter?.branch_id ?? 'hub_jed');
        const focus = firstTenantRoutePlanCandidateList(opts).rows[0];
        return {
          rows: [
            {
              ...focus,
              id: 'shp_unrelated_first',
              shipment_id: 'shp_unrelated_first',
              branch_id: branchId,
              tracking_number: '260029TDC',
              promised_delivery_date: plannedDate,
              stop_payload: {
                ...focus.stop_payload,
                shipment_id: 'shp_unrelated_first',
                sequence_order: 1,
                metadata: { ...(focus.stop_payload.metadata ?? {}), tracking_number: '260029TDC' },
              },
            },
            {
              ...focus,
              sequence_order: 2,
              tracking_number: 'FT-LIVE-PINNED',
              stop_payload: {
                ...focus.stop_payload,
                sequence_order: 2,
                metadata: { ...(focus.stop_payload.metadata ?? {}), tracking_number: 'FT-LIVE-PINNED' },
              },
            },
          ],
          total: 2,
        };
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });

    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });

      const focused = await screen.findByRole('button', { name: /Open shipment context FT-LIVE-PINNED/i });
      const unrelated = await screen.findByRole('button', { name: /Open shipment context 260029TDC/i });
      expect(focused.compareDocumentPosition(unrelated) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      listSpy.mockRestore();
      window.history.pushState(null, '', '/operate/route-plans');
    }
  });

  it('reopens the focused new-plan picker when the same Route plans page receives a different shipment query', async () => {
    const shipmentId = '7065299a-02bd-49a4-b037-1972b71eefa0';
    window.history.pushState(null, '', '/operate/route-plans');
    mockRoutePlanResourceRead(async (resource, id) => {
      if (resource === 'shipments' && id === shipmentId) {
        return {
          id,
          tracking_number: '26007QJTZ',
          status: 'pending',
          service_type: 'standard',
          promised_delivery_date: '2026-05-07',
        };
      }
      return GET_RESOURCE(resource, id);
    });
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_stops') {
        return { rows: [], total: 0 };
      }
      if (key === 'route_plan_delivery_wave_candidates') {
        return firstTenantRoutePlanCandidateList(opts);
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });

    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.queryByText('API shipment handoff')).not.toBeInTheDocument());

      act(() => {
        window.history.pushState(null, '', `/operate/route-plans?shipment=${shipmentId}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      expect(await screen.findByText('API shipment handoff')).toBeInTheDocument();
      expect(await screen.findByText('26007QJTZ')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByLabelText('Select candidate 26007QJTZ')).toBeChecked();
      });
    } finally {
      listSpy.mockRestore();
      window.history.pushState(null, '', '/operate/route-plans');
    }
  });

  it('surfaces a focused API shipment when route-plan prerequisites are missing instead of hiding it', async () => {
    const shipmentId = 'shp_api_not_route_ready';
    window.history.pushState(null, '', `/operate/route-plans?shipment=${shipmentId}`);
    mockRoutePlanResourceRead(async (resource, id) => {
      if (resource === 'shipments' && id === shipmentId) {
        return {
          id,
          tracking_number: 'FT-LIVE-NOTREADY',
          status: 'pending',
          service_type: 'delivery',
          destination_address_id: 'addr_api_not_ready',
        };
      }
      return GET_RESOURCE(resource, id);
    });
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_stops') {
        return { rows: [], total: 0 };
      }
      if (key === 'route_plan_delivery_wave_candidates') {
        return { rows: [], total: 0 };
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });

    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });

      expect(await screen.findByText('API shipment handoff')).toBeInTheDocument();
      expect(await screen.findByText('FT-LIVE-NOTREADY')).toBeInTheDocument();
      expect(await screen.findByText('Focused API shipment is not route-ready')).toBeInTheDocument();
      expect(screen.getByText(/branch\/service offering match/i)).toBeInTheDocument();
      expect(screen.queryByText(/branch\/service-offering projection/i)).not.toBeInTheDocument();
      expect(screen.getAllByText(/promised delivery date/i).length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Open shipment context' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    } finally {
      listSpy.mockRestore();
      window.history.pushState(null, '', '/operate/route-plans');
    }
  });

  it('keeps a focused API shipment selected when the picker switches to the ready hub', async () => {
    const shipmentId = '7065299a-02bd-49a4-b037-1972b71eefa0';
    window.history.pushState(null, '', `/operate/route-plans?shipment=${shipmentId}`);
    mockRoutePlanResourceRead(async (resource, id) => {
      if (resource === 'shipments' && id === shipmentId) {
        return {
          id,
          tracking_number: '26007QJTZ',
          status: 'pending',
          service_type: 'delivery',
          promised_delivery_date: '2026-05-07',
        };
      }
      return GET_RESOURCE(resource, id);
    });
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_stops') {
        return { rows: [], total: 0 };
      }
      if (key === 'hubs') {
        return {
          rows: [
            { id: 'hub_empty', code: 'main', name: 'Main warehouse', city: 'Riyadh', cutoff_time: null },
            { id: 'hub_ready', code: 'main', name: 'Main warehouse', city: 'Riyadh', cutoff_time: null },
          ],
          total: 2,
        };
      }
      if (key === 'route_plan_delivery_wave_candidates') {
        const filter = opts?.filter ?? {};
        const branchId = String(filter.branch_id ?? '');
        if (!branchId || branchId === 'hub_ready') {
          return firstTenantRoutePlanCandidateList({
            ...opts,
            filter: { ...filter, branch_id: 'hub_ready' },
          });
        }
        return { rows: [], total: 0 };
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });

    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });

      const focusedCandidate = await screen.findByLabelText('Select candidate 26007QJTZ');
      await waitFor(() => {
        expect(focusedCandidate).toBeChecked();
      });
    } finally {
      listSpy.mockRestore();
      window.history.pushState(null, '', '/operate/route-plans');
    }
  });

  it('New plan auto-selects the hub that has first-tenant candidates and disambiguates duplicate hub labels', async () => {
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (key, opts) => {
      if (key === 'route_stops') {
        return { rows: [], total: 0 };
      }
      if (key === 'hubs') {
        return {
          rows: [
            { id: 'hub_empty', code: 'main', name: 'Main warehouse', city: 'Riyadh', cutoff_time: null },
            { id: 'hub_ready', code: 'main', name: 'Main warehouse', city: 'Riyadh', cutoff_time: null },
          ],
          total: 2,
        };
      }
      if (key === 'route_plan_delivery_wave_candidates') {
        const filter = opts?.filter ?? {};
        const branchId = String(filter.branch_id ?? '');
        if (!branchId || branchId === 'hub_ready') {
          return firstTenantRoutePlanCandidateList({
            ...opts,
            filter: { ...filter, branch_id: 'hub_ready' },
          });
        }
        return { rows: [], total: 0 };
      }
      return routePlanningListResource(key, opts, LIST_RESOURCE);
    });
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /New plan/ }));

    const firstTenantCandidate = await screen.findByLabelText('Select candidate 26007QJTZ');
    await waitFor(() => {
      expect(screen.getByLabelText('Pick hub')).toHaveTextContent('main · Main warehouse · 1 ready');
    });
    await user.click(firstTenantCandidate);
    await user.click(await screen.findByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(CREATE_SPY).toHaveBeenCalled();
    });
    const [input] = CREATE_SPY.mock.calls[0] as [{
      branch_id?: string;
      inputs: { stops?: Array<{ shipment_id?: string; metadata?: { tracking_number?: string | null } }> };
      metadata: { selected_shipment_count?: number };
    }];
    expect(input.branch_id).toBe('hub_ready');
    expect(input.inputs.stops?.[0]?.metadata?.tracking_number).toBe('26007QJTZ');

    listSpy.mockRestore();
  });

  it('Rebalance stop shipment reference opens the shared shipment context drawer in place', async () => {
    const marker = 'READ-BACKED-REBALANCE-STOP';
    const getSpy = vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (resource === 'shipments') {
        return {
          id,
          tracking_number: `TRK-${String(id).slice(-6)}`,
          status: 'created',
          service_type: 'standard',
          carrier_reference_number: marker,
        };
      }
      return GET_RESOURCE(resource, id);
    });

    try {
      renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
      const user = await openFirstRowDrawer();
      await user.click(findFooterButton(/Rebalance/));

      const stopCheckbox = await waitFor(() => {
        const found = Array.from(document.querySelectorAll('.modal input[type="checkbox"]')).find((el) =>
          /^Select stop /.test((el as HTMLInputElement).getAttribute('aria-label') ?? ''),
        );
        expect(found).toBeTruthy();
        return found as HTMLInputElement;
      });
      const shipmentId = stopCheckbox.getAttribute('aria-label')?.replace(/^Select stop /, '') ?? '';
      expect(shipmentId).toBeTruthy();
      const modalEl = document.querySelector('.modal') as HTMLElement;
      const reference = within(modalEl).getByRole('button', {
        name: `Open shipment context ${shipmentId}`,
      });

      await user.click(reference);

      const drawer = await waitFor(() => {
        const el = document.querySelector('.drawer') as HTMLElement | null;
        expect(el).not.toBeNull();
        return el!;
      });
      await waitFor(() => {
        expect(getSpy.mock.calls.some(([resource, id]) => resource === 'shipments' && id === shipmentId)).toBe(true);
      });
      expect(await within(drawer).findByText(marker)).toBeInTheDocument();
    } finally {
      getSpy.mockReset();
    }
  });

  it('Rebalance fires ui_rebalance_route_plan_v1 with source_route_plan_id/target_route_plan_id/shipment_ids', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    const user = await openFirstRowDrawer();
    await user.click(findFooterButton(/Rebalance/));
    const stopCheckbox = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.modal input[type="checkbox"]')).find((el) =>
        /^Select stop /.test((el as HTMLInputElement).getAttribute('aria-label') ?? ''),
      );
      expect(found).toBeTruthy();
      return found as HTMLInputElement;
    });
    await user.click(stopCheckbox);
    const rebalanceBtn = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.modal button')).find((b) =>
        /Rebalance.*1 stop/.test((b.textContent ?? '').trim()),
      );
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    await user.click(rebalanceBtn);
    await waitFor(() => {
      expect(REBALANCE_SPY).toHaveBeenCalled();
    });
    const [input] = REBALANCE_SPY.mock.calls[0] as [{
      source_route_plan_id: string;
      target_route_plan_id?: string | null;
      shipment_ids: string[];
      metadata?: { source?: string };
    }];
    expect(input.source_route_plan_id).toBeTruthy();
    expect(input.target_route_plan_id).toBeTruthy();
    expect(input.target_route_plan_id).not.toBe(input.source_route_plan_id);
    expect(input.shipment_ids).toHaveLength(1);
    expect(input.shipment_ids[0]).toMatch(/^shp_/);
    expect(input.metadata?.source).toBe('console_v2.route_plans.rebalance');
    expect(input).not.toHaveProperty('moves');
    expect(input).not.toHaveProperty('route_plan_id');
  });
});
