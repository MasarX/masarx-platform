// dispatch.test.tsx — covers CLAIM-B Dispatch Canvas hardening.
//
// Targets:
//   1. Module mounts with the 3-pane layout and KPI strip.
//   2. Header `Reconcile scan-out` and `Confirm departure` use backend-aligned gates.
//   3. Pane-2 `↻ Reassign` button is disabled when no stops are selected and
//      enabled (with capability) when ≥1 are selected.
//   4. Selecting a run + multi-selecting stops + clicking ↻ Reassign opens the
//      target-run picker (ReferencePicker palette).
//   5. The insight rail shows the route_assignment_policy LadderViz rows.
//   6. The COD float card surfaces the static demo limit (no cod_float_policy
//      backend SSOT exists yet — see CLAIM-B-FIX2 revision).

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { DispatchModule, routeRunAssignTargetForDriver } from '@/modules/operate/dispatch';
import * as api from '@/lib/api';
import { ui_get_resource_v1, ui_list_resource_complete } from '@/lib/data-source';

function pageActions(container: HTMLElement) {
  return within(container.querySelector<HTMLElement>('.page-header__actions')!);
}

function stopActions() {
  return within(screen.getByText('Stop sequence').closest<HTMLElement>('.pane__header')!);
}

beforeEach(() => {
  window.history.pushState(null, '', '/operate/dispatch');
});

afterEach(() => {
  document.body.style.pointerEvents = '';
  window.history.pushState(null, '', '/operate/dispatch');
});

describe('DispatchModule', () => {
  it('sends the selected tenant and the active vehicle with the driver assignment', () => {
    expect(routeRunAssignTargetForDriver({ id: 'test-driver', vehicle_id: 'test-vehicle' }, 'test-tenant'))
      .toEqual({ driver_user_id: 'test-driver', vehicle_id: 'test-vehicle', organization_id: 'test-tenant' });
    expect(routeRunAssignTargetForDriver({ id: 'test-driver', vehicle_id: null }, 'test-tenant'))
      .toEqual({ driver_user_id: 'test-driver', organization_id: 'test-tenant' });
  });

  it('mounts with the page header and KPI strip', async () => {
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('.kpi').length).toBeGreaterThan(0);
    });
  });

  it('renders the 3-pane Dispatch canvas (runs / stops / insight rail)', async () => {
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.pane').length).toBe(3);
    });
    expect(document.querySelectorAll('.run-row').length).toBeGreaterThan(0);
  });

  it('renders a backend-backed active run stop map with the approved open map policy', async () => {
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    const map = await screen.findByTestId('dispatch-active-run-map');
    await waitFor(() => {
      expect(map.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'approved');
    });
    expect(within(map).getByRole('application', { name: 'Active run stop map' })).toBeInTheDocument();
    expect(map.textContent).toMatch(/OpenStreetMap contributors/);
  });

  it('focuses a route stop from the route_stop query parameter', async () => {
    window.history.pushState(null, '', '/operate/dispatch?route_stop=rs_44000');
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelector('.dnd-stop.is-selected')?.textContent ?? '').toMatch(/SHP-9381201|9381201/);
    });
  });

  it('allows dispatch reads but disables route execution writes for read-only operators', async () => {
    const user = userEvent.setup();
    const reconcileSpy = vi.spyOn(api, 'route_run_scan_out_reconciliation_v1');
    try {
      const { container } = renderWithProviders(<DispatchModule />, { capabilities: ['routes.read'] });
      const activeRun = await waitFor(() => {
        const row = container.querySelector<HTMLElement>('.run-row.is-active');
        expect(row).not.toBeNull();
        return row!;
      });
      const actions = pageActions(container);
      const reconcile = actions.getByRole('button', { name: /Reconcile scan-out/ });
      const confirm = actions.getByRole('button', { name: /Confirm departure/ });
      const assignDriver = within(activeRun).getByRole('button', { name: /Assign driver/i });
      const reassign = stopActions().getByRole('button', { name: /Reassign/ });

      expect(reconcile).toBeDisabled();
      expect(confirm).toBeDisabled();
      expect(assignDriver).toBeDisabled();
      expect(reassign).toBeDisabled();
      expect(screen.getAllByText(/Route update permission required/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Task completion permission required/i).length).toBeGreaterThan(0);

      await user.click(reconcile);
      expect(reconcileSpy).not.toHaveBeenCalled();
    } finally {
      reconcileSpy.mockRestore();
    }
  });

  it('disables `Confirm departure` when routes.write exists without tasks.complete', async () => {
    const { container } = renderWithProviders(<DispatchModule />, { capabilities: ['routes.read', 'routes.write'] });
    await waitFor(() => {
      expect(document.querySelector('.run-row.is-active')).not.toBeNull();
    });
    const actions = pageActions(container);
    const reconcile = actions.getByRole('button', { name: /Reconcile scan-out/ });
    const confirm = actions.getByRole('button', { name: /Confirm departure/ });
    expect(reconcile).not.toBeDisabled();
    expect(confirm).toBeDisabled();
    expect(screen.getAllByText(/Task completion permission required/i).length).toBeGreaterThan(0);
  });

  it('disables `Confirm departure` when tasks.complete exists without routes.write', () => {
    const { container } = renderWithProviders(<DispatchModule />, { capabilities: ['routes.read', 'tasks.complete'] });
    const confirm = pageActions(container).getByRole('button', { name: /Confirm departure/ });
    expect(confirm).toBeDisabled();
    expect(screen.getAllByText(/Route update permission required/i).length).toBeGreaterThan(0);
  });

  it('invalidates dispatch projections after scan-out reconciliation', async () => {
    const user = userEvent.setup();
    const reconcileSpy = vi
      .spyOn(api, 'route_run_scan_out_reconciliation_v1')
      .mockResolvedValue({
        ok: true,
        expected: 3,
        scanned: 3,
        discrepancies: [],
        run_id: 'rr_test',
      });
    try {
      const { container, queryClient } = renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelector('.run-row.is-active')).not.toBeNull();
      });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await user.click(pageActions(container).getByRole('button', { name: /Reconcile scan-out/ }));
      await waitFor(() => {
        const calls = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg));
        expect(calls.some((call) => call.includes('"route_runs"'))).toBe(true);
        expect(calls.some((call) => call.includes('"route_stops"'))).toBe(true);
        expect(calls.some((call) => call.includes('"route_run_directory"'))).toBe(true);
      });
    } finally {
      reconcileSpy.mockRestore();
    }
  });

  it('Refresh refetches the dispatch route resources', async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');
    try {
      const { container } = renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelector('.run-row')).not.toBeNull();
      });
      const runsHeader = container.querySelector('#dispatch-pane-runs-title')!.closest<HTMLElement>('.pane__header')!;
      const refresh = within(runsHeader).getByRole('button', { name: /^Refresh$/i });
      await waitFor(() => {
        // Rendering the active stops starts dependent reads that can disable Refresh.
        expect(container.querySelector('.dnd-stop')).not.toBeNull();
        expect(refresh).not.toBeDisabled();
      });

      listSpy.mockClear();
      await user.click(refresh);

      await waitFor(() => {
        const resources = listSpy.mock.calls.map(([resource]) => resource);
        expect(resources).toEqual(expect.arrayContaining([
          'route_runs',
          'route_stops',
          'route_run_directory',
          'route_run_assignments',
          'route_run_assignment_events',
        ]));
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('builds vehicle scanner matches from backend vehicle_directory reads and refetches the selected drawer', async () => {
    const user = userEvent.setup();
    const listVehicle = {
      id: 'veh_van_118',
      organization_id: 'org_rashed',
      plate_number: 'BACKEND-VHL-001',
      plate: 'BACKEND-VHL-001',
      code: 'BACKEND-VHL-CODE',
      status: 'available',
      vehicle_type_label: 'List-only vehicle type',
    };
    const detailVehicle = {
      ...listVehicle,
      plate_number: 'BACKEND-VHL-DETAIL',
      vehicle_type_label: 'Backend detail refrigerated van',
    };
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'vehicle_directory') {
        return { rows: [listVehicle], total: 1, page: 0, page_size: 100 };
      }
      return ui_list_resource_complete(resource, opts);
    });
    const getSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'vehicle_directory' && id === 'veh_van_118') return detailVehicle;
      return ui_get_resource_v1(resource, id);
    });

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      const scannerPanel = within(await screen.findByTestId('ops-scanner-panel'));
      const scanner = scannerPanel.getByTestId('ops-scanner-input');
      await waitFor(() => {
        expect(listSpy.mock.calls.some(([resource]) => resource === 'vehicle_directory')).toBe(true);
      });

      await user.type(scanner, 'BACKEND-VHL-001');
      const match = await waitFor(() => {
        const result = scannerPanel.getByTestId('ops-scanner-match');
        expect(result).toHaveTextContent('Vehicle');
        return result;
      });
      await user.click(within(match).getByRole('button', { name: /Open Vehicle context BACKEND-VHL-001/i }));

      const drawer = await screen.findByTestId('dispatch-vehicle-context-drawer');
      await waitFor(() => {
        expect(within(drawer).getByText('BACKEND-VHL-DETAIL')).toBeInTheDocument();
      });
      expect(within(drawer).getByText('Backend detail refrigerated van')).toBeInTheDocument();
      expect(getSpy).toHaveBeenCalledWith('vehicle_directory', 'veh_van_118');
    } finally {
      listSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it('builds basket scanner matches from backend basket reads and refetches the selected drawer', async () => {
    const user = userEvent.setup();
    const listBasket = {
      id: 'bsk_ruh_north_001',
      organization_id: 'org_rashed',
      basket_type: 'zone_based',
      state: 'forming',
      current_count: 0,
      capacity_count: 25,
      barcode: 'BASKET-BACKEND-SCAN',
      code: 'BASKET-BACKEND-CODE',
      label: 'Backend list basket',
    };
    const detailBasket = {
      ...listBasket,
      state: 'ready',
      current_count: 4,
      capacity_count: 40,
      label: 'Backend detail basket',
    };
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'baskets') {
        return { rows: [listBasket], total: 1, page: 0, page_size: 100 };
      }
      return ui_list_resource_complete(resource, opts);
    });
    const getSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'baskets' && id === 'bsk_ruh_north_001') return detailBasket;
      return ui_get_resource_v1(resource, id);
    });

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      const scannerPanel = within(await screen.findByTestId('ops-scanner-panel'));
      const scanner = scannerPanel.getByTestId('ops-scanner-input');
      await waitFor(() => {
        expect(listSpy.mock.calls.some(([resource]) => resource === 'baskets')).toBe(true);
      });

      await user.type(scanner, 'BASKET-BACKEND-SCAN');
      const match = await waitFor(() => {
        const result = scannerPanel.getByTestId('ops-scanner-match');
        expect(result).toHaveTextContent('Basket');
        return result;
      });
      await user.click(within(match).getByRole('button', { name: /Open Basket context Backend list basket/i }));

      const drawer = await screen.findByTestId('dispatch-basket-context-drawer');
      await waitFor(() => {
        expect(within(drawer).getByText('Backend detail basket')).toBeInTheDocument();
      });
      expect(within(drawer).getByText('4 / 40')).toBeInTheDocument();
      expect(getSpy).toHaveBeenCalledWith('baskets', 'bsk_ruh_north_001');
    } finally {
      listSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it('disables the bulk reassign button until stops are selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dnd-stop').length).toBeGreaterThan(0);
    });
    const reassignBtn = stopActions().getByRole('button', { name: /Reassign/ });
    expect(reassignBtn).toBeDisabled();

    // Select one stop.
    const firstStopCheckbox = document.querySelector('.dnd-stop input[type="checkbox"]') as HTMLInputElement;
    expect(firstStopCheckbox).not.toBeNull();
    await user.click(firstStopCheckbox);
    await waitFor(() => {
      expect(stopActions().getByRole('button', { name: /Reassign · 1/ })).not.toBeDisabled();
    });
  });

  it('opens the target-run ReferencePicker when bulk reassign is invoked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dnd-stop').length).toBeGreaterThan(0);
    });
    const checkbox = document.querySelector('.dnd-stop input[type="checkbox"]') as HTMLInputElement;
    await user.click(checkbox);
    await waitFor(() => {
      expect(stopActions().getByRole('button', { name: /Reassign · 1/ })).not.toBeDisabled();
    });
    await user.click(stopActions().getByRole('button', { name: /Reassign · 1/ }));
    await waitFor(() => {
      expect(document.querySelector('.palette')).not.toBeNull();
    });
  });

  it('insight rail shows the operator-facing route assignment policy panel with LadderViz', async () => {
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Route assignment policy/);
      expect(document.body.textContent).not.toMatch(/route_assignment_policy/);
      expect(document.body.textContent).not.toMatch(/route_stop_execute|driver_user_id|driver: usr/i);
    });
    // LadderViz renders steps with `.ladder__step` class.
    await waitFor(() => {
      expect(document.querySelectorAll('.ladder__step').length).toBeGreaterThan(0);
    });
  });

  it('insight rail surfaces an operator-facing COD float card', async () => {
    // The COD float chip resolves from settings without exposing internal
    // setting keys in the operator UI.
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/COD float/);
    });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/COD float limit/);
    });
    expect(document.body.textContent).not.toMatch(/static demo limit/);
    expect(document.body.textContent).not.toMatch(/no cod_float_policy SSOT yet/);
    expect(document.body.textContent).not.toMatch(/cod\.float\.max_per_driver/);
  });
});
