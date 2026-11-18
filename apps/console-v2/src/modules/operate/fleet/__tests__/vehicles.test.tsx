// vehicles.test.tsx — CLAIM-FLEET-VEHICLES (Wave 1, Phase A) tests.
//
// Asserts the post-build contract:
//   • mounts without crashing and renders the KPI strip + DataTable
//   • "New vehicle" submits the production-backed create_vehicle_v1 RPC
//   • drawer opens on row click and the 6 tabs are present (Profile,
//     Assignments, Maintenance, Events, Documents, Telemetry)
//   • Assign-new-driver flow opens the ReferencePicker, picks a driver, and
//     fires `runCommand('fleet.vehicles.assign_driver', …)` with canonical
//     `{ organization_id, vehicle_id, driver_user_id }` payload
//   • Schedule-maintenance flow opens the modal, picks a date+kind, and fires
//     `runCommand('fleet.vehicles.schedule_maintenance', …)` with canonical
//     `{ organization_id, vehicle_id, planned_start, planned_end,
//        scheduled_kind }` payload

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { VehiclesModule } from '../vehicles';
import * as api from '@/lib/api';
// @ts-expect-error JS module — registry shape exercised dynamically below.
import * as registry from '@/lib/seed-raw/registry';
import * as ds from '@/lib/data-source';

async function mountAndWait() {
  const utils = renderWithProviders(<VehiclesModule />, {
    identity: {
      capabilities: ['all'],
      user: {
        organization_id: 'org_rashed',
        access_scope_type: 'tenant',
        access_scope_id: null,
      },
      scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
    },
  });
  await waitFor(() => {
    // KPI label is the most reliable signal that the module finished its
    // first render (it depends on the vehicles list query resolving).
    expect(screen.getAllByText(/Total fleet/i).length).toBeGreaterThan(0);
  }, { timeout: 3000 });
  return utils;
}

describe('VehiclesModule (CLAIM-FLEET-VEHICLES)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/fleet/vehicles');
    await api.hydrateConsoleLiveMetadata();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/fleet/vehicles');
  });

  it('mounts and renders KPI strip + vehicle table', async () => {
    await mountAndWait();
    // KPI strip — scope to .kpi__label so the assertions don't collide with
    // the same status labels appearing inside lookup chips on table rows.
    const kpiLabels = Array.from(document.querySelectorAll('.kpi__label')).map(
      (el) => el.textContent ?? '',
    );
    expect(kpiLabels.some((l) => /Total fleet/i.test(l))).toBe(true);
    expect(kpiLabels.some((l) => /On shift/i.test(l))).toBe(true);
    expect(kpiLabels.some((l) => /In maintenance/i.test(l))).toBe(true);
    expect(kpiLabels.some((l) => /Out of service/i.test(l))).toBe(true);
    expect(screen.getByText(/Vehicles ready for dispatch/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/on_shift \/ total/i);
    // DataTable rows are rendered (seed has 9 vehicles)
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(4);
    });
  });

  it('honors branch deep links with a filtered vehicle roster', async () => {
    window.history.pushState(null, '', '/operate/fleet/vehicles?branch=hub_jed_n');
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');
    await mountAndWait();

    expect(screen.getByText(/filtered by branch jeddah north/i)).toBeInTheDocument();
    expect(screen.getByText('JED 0918')).toBeInTheDocument();
    expect(screen.queryByText('RUH 1184')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        listSpy.mock.calls.some(([resource, options]) => {
          const filter = (options as { filter?: Record<string, unknown> } | undefined)?.filter;
          return (
            resource === 'vehicle_directory' &&
            filter?.current_branch_id === 'hub_jed_n' &&
            filter?.organization_id === 'org_rashed'
          );
        }),
      ).toBe(true);
    });
    expect(
      listSpy.mock.calls.some(
        ([resource, options]) =>
          resource === 'vehicle_directory' &&
          !((options as { filter?: Record<string, unknown> } | undefined)?.filter),
      ),
    ).toBe(false);
  });

  it('scopes vehicle roster, driver picker, documents, and relation reads to the active tenant context', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    const completeListSpy = vi.spyOn(api, 'ui_list_resource_complete');
    await mountAndWait();
    const allListCalls = () => [...listSpy.mock.calls, ...completeListSpy.mock.calls];

    await waitFor(() => {
      for (const resource of ['vehicle_directory', 'driver_directory', 'vehicle_documents']) {
        expect(
          allListCalls().some(([key, opts]) => {
            const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
            return key === resource && filter?.organization_id === 'org_rashed';
          }),
        ).toBe(true);
      }
      for (const resource of ['vehicle_assignments', 'vehicle_events', 'vehicle_maintenance_directory']) {
        expect(
          allListCalls().some(([key, opts]) => {
            const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
            return key === resource && typeof filter?.vehicle_id === 'string';
          }),
        ).toBe(true);
        expect(
          allListCalls().some(
            ([key, opts]) =>
              key === resource && !(opts as { filter?: Record<string, unknown> } | undefined)?.filter,
          ),
        ).toBe(false);
      }
    });
  });

  it('opens focused vehicle deep links with decorated plate context', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/operate/fleet/vehicles?focus=veh_van_118');
    await mountAndWait();

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });
    expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/RUH 1184/);

    await user.click(screen.getByRole('tab', { name: /Documents/i }));
    await user.click(screen.getByRole('button', { name: /Attach document/i }));

    await waitFor(() => {
      const modalText = document.querySelector('.modal')?.textContent ?? '';
      expect(modalText).toMatch(/Attach document - RUH 1184/);
      expect(modalText).not.toMatch(/undefined/);
    });
  });

  // W35b — regression guard for the canonical OOS KPI predicate. The seed has
  // exactly one vehicle (`veh_car_512`) with canonical `status='oos'`. If
  // anyone reverts the FE filter to legacy `'out_of_service'` (or the seed
  // back to that value), this assertion fails closed. Closes REAUDIT3 P1-1.
  it('Out of service KPI counts vehicles with canonical status="oos"', async () => {
    await mountAndWait();
    // The KPI value sits in a sibling `.kpi__value` inside the same `.kpi__card`
    // as the `.kpi__label` matching /Out of service/i. Find by walking up.
    const labels = Array.from(document.querySelectorAll('.kpi__label')) as HTMLElement[];
    const oosLabel = labels.find((el) => /Out of service/i.test(el.textContent ?? ''));
    expect(oosLabel).toBeDefined();
    const card = oosLabel!.closest('.kpi__card') ?? oosLabel!.parentElement;
    expect(card).not.toBeNull();
    const valueEl = card!.querySelector('.kpi__value');
    expect(valueEl).not.toBeNull();
    expect(Number(valueEl!.textContent)).toBeGreaterThan(0);
  });

  it('New vehicle action is visible but gated by fleet.write', async () => {
    renderWithProviders(<VehiclesModule />, { capabilities: ['fleet.read'] });
    await waitFor(() => {
      expect(screen.getAllByText(/Total fleet/i).length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(screen.getByRole('button', { name: /New vehicle/i })).toBeDisabled();
  });

  it('permission-gates fleet vehicle write actions without firing backend mutations', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(api, 'create_vehicle_v1').mockResolvedValue({
      ok: true,
      vehicle_id: 'veh_denied_should_not_create',
      correlation_id: 'corr_denied_should_not_create',
    });
    const oosSpy = vi.spyOn(api, 'mark_vehicle_oos_v1').mockResolvedValue({
      ok: true,
      vehicle_id: 'veh_denied_should_not_oos',
      correlation_id: 'corr_denied_should_not_oos',
    });
    const restoreSpy = vi.spyOn(api, 'restore_vehicle_v1').mockResolvedValue({
      ok: true,
      vehicle_id: 'veh_denied_should_not_restore',
      correlation_id: 'corr_denied_should_not_restore',
    });

    renderWithProviders(<VehiclesModule />, { capabilities: ['fleet.read'] });
    await waitFor(() => {
      expect(screen.getAllByText(/Total fleet/i).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const newVehicle = screen.getByRole('button', { name: /New vehicle/i });
    expect(newVehicle).toBeDisabled();
    await user.click(newVehicle);
    expect(screen.queryByText(/Creates a fleet asset in the vehicle roster/i)).toBeNull();

    const actionButtons = screen
      .getAllByLabelText('Row actions')
      .filter((node) => node.tagName === 'BUTTON');
    expect(actionButtons.length).toBeGreaterThan(0);
    await user.click(actionButtons[0]!);

    const markOos = await screen.findByRole('option', { name: /^Mark out-of-service/ });
    const restore = await screen.findByRole('option', { name: /^Restore in-service/ });
    expect(markOos).toHaveClass('is-disabled');
    expect(markOos).toHaveTextContent(/requires fleet update permission/i);
    expect(restore).toHaveClass('is-disabled');
    expect(restore).toHaveTextContent(/requires fleet update permission/i);
    await user.click(markOos).catch(() => undefined);
    await user.click(restore).catch(() => undefined);

    expect(createSpy).not.toHaveBeenCalled();
    expect(oosSpy).not.toHaveBeenCalled();
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('permission-gates fleet vehicle tab write actions without firing backend mutations', async () => {
    const user = userEvent.setup();
    const uploadSpy = vi.spyOn(api, 'upload_vehicle_document_v1').mockResolvedValue({
      ok: true,
      vehicle_document_id: 'vdoc_denied_should_not_upload',
      correlation_id: 'corr_denied_should_not_upload',
    });
    const scheduleSpy = vi.spyOn(api, 'schedule_maintenance_v1').mockResolvedValue({
      ok: true,
      maintenance_window_id: 'vmw_denied_should_not_schedule',
      correlation_id: 'corr_denied_should_not_schedule',
      settings_resolution_id: 'srlv_denied_should_not_schedule',
    });
    const completeSpy = vi.spyOn(api, 'complete_maintenance_v1').mockResolvedValue({
      ok: true,
      vehicle_maintenance_window_id: 'vmw_3003',
      correlation_id: 'corr_denied_should_not_complete',
      settings_resolution_id: 'srlv_denied_should_not_complete',
    });
    const cancelSpy = vi.spyOn(api, 'cancel_maintenance_v1').mockResolvedValue({
      ok: true,
      vehicle_maintenance_window_id: 'vmw_3003',
      correlation_id: 'corr_denied_should_not_cancel',
      settings_resolution_id: 'srlv_denied_should_not_cancel',
    });
    const recordSpy = vi.spyOn(api, 'record_vehicle_event_v1').mockResolvedValue({
      ok: true,
      vehicle_event_id: 'vev_denied_should_not_record',
      correlation_id: 'corr_denied_should_not_record',
    });

    renderWithProviders(<VehiclesModule />, {
      identity: {
        capabilities: ['fleet.read'],
        user: {
          organization_id: 'org_rashed',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });
    await waitFor(() => {
      expect(screen.getAllByText(/Total fleet/i).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const vehicleCell = await screen.findByText('DMM 3124');
    const row = vehicleCell.closest('tr');
    if (!row) throw new Error('DMM 3124 row not found');
    await user.click(row);
    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('tab', { name: /Documents/i }));
    const attachDocument = screen.getByRole('button', { name: /Attach document/i });
    expect(attachDocument).toBeDisabled();
    await user.click(attachDocument);
    expect(screen.queryByText(/Attach a registered document file to this vehicle profile/i)).toBeNull();

    await user.click(screen.getByRole('tab', { name: /Maintenance/i }));
    const scheduleMaintenance = screen.getByRole('button', { name: /Schedule maintenance/i });
    expect(scheduleMaintenance).toBeDisabled();
    await user.click(scheduleMaintenance);
    expect(screen.queryByText(/Adds a planned maintenance window for this vehicle/i)).toBeNull();
    const completeBtn = await screen.findByRole('button', { name: /Mark complete/i });
    expect(completeBtn).toBeDisabled();
    const actionRow = completeBtn.closest('div');
    if (!actionRow) throw new Error('maintenance action row not found');
    const cancelBtn = within(actionRow as HTMLElement).getByRole('button', { name: /Cancel/i });
    expect(cancelBtn).toBeDisabled();
    await user.click(completeBtn);
    await user.click(cancelBtn);

    await user.click(screen.getByRole('tab', { name: /Events/i }));
    const addEvent = screen.getByRole('button', { name: /Add event/i });
    expect(addEvent).toBeDisabled();
    await user.click(addEvent);
    expect(screen.queryByText(/Logs a vehicle event with the selected event type/i)).toBeNull();

    await user.click(screen.getByRole('tab', { name: /Telemetry/i }));
    const recordTelemetry = screen.getByRole('button', { name: /Record telemetry/i });
    expect(recordTelemetry).toBeDisabled();
    await user.click(recordTelemetry);
    expect(screen.queryByText(/Records odometer and fuel telemetry for this vehicle/i)).toBeNull();

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(completeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('New vehicle submits create_vehicle_v1 with canonical fleet payload', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'create_vehicle_v1').mockResolvedValue({
      ok: true,
      vehicle_id: 'veh_test',
      correlation_id: 'cor_vehicle',
    });
    await mountAndWait();

    await user.click(screen.getByRole('button', { name: /New vehicle/i }));
    await waitFor(() => {
      expect(screen.getByText(/Creates a fleet asset in the vehicle roster/i)).toBeInTheDocument();
    });
    const modal = document.querySelector('.modal') as HTMLElement | null;
    expect(modal).not.toBeNull();
    const plate = modal!.querySelector('input[type="text"]') as HTMLInputElement | null;
    expect(plate).not.toBeNull();
    await user.type(plate!, 'MX-UNIT-900');
    await user.click(within(modal!).getByRole('button', { name: /Create vehicle/i }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          plate_number: 'MX-UNIT-900',
          vehicle_type_id: expect.any(String),
          branch_id: expect.any(String),
        }),
      );
    });
    expect(typeof api.create_vehicle_v1).toBe('function');
    spy.mockRestore();
  });

  it('Assign-new-driver flow refreshes the same drawer from backend assignment readback', async () => {
    const user = userEvent.setup();
    const realGet = api.ui_get_resource_v1;
    const realComplete = api.ui_list_resource_complete;
    let assignmentState: 'none' | 'active' | 'ended' = 'none';

    vi.spyOn(api, 'assign_driver_to_vehicle_v1').mockImplementation(async () => {
      assignmentState = 'active';
      return {
        ok: true,
        vehicle_assignment_id: 'va_live_readback',
        vehicle_id: 'veh_van_118',
        assigned_to_user_id: 'usr_dr_khalid',
        correlation_id: 'cor_assign_readback',
      };
    });
    vi.spyOn(api, 'unassign_driver_v1').mockImplementation(async () => {
      assignmentState = 'ended';
      return {
        ok: true,
        vehicle_assignment_id: 'va_live_readback',
        vehicle_id: 'veh_van_118',
        correlation_id: 'cor_unassign_readback',
      };
    });
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'vehicle_directory' && id === 'veh_van_118') {
        return {
          id,
          organization_id: 'org_rashed',
          plate_number: 'RUH 1184',
          vin: 'VIN-RUH-1184',
          type_id: 'vt_van',
          vehicle_type_id: 'vt_van',
          type_name: 'Van',
          vehicle_type_label: 'Van',
          current_driver_user_id: assignmentState === 'active' ? 'usr_dr_khalid' : null,
          current_driver_label: assignmentState === 'active' ? 'Khalid Al-Farhan' : null,
          current_branch_id: 'hub_riyadh',
          branch_id: 'hub_riyadh',
          branch_label: 'Riyadh hub',
          current_branch_label: 'Riyadh hub',
          status: 'active',
          fuel_level: 0,
          odometer_km: 0,
          last_telemetry_at: null,
          is_oos: false,
          is_in_maintenance: false,
        } as never;
      }
      return realGet(resource, id) as never;
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_complete>[1]) => {
        const filter = opts?.filter as Record<string, unknown> | undefined;
        if (resource === 'vehicle_assignments' && filter?.vehicle_id === 'veh_van_118') {
          const rows = assignmentState === 'none'
            ? []
            : [
                {
                  id: 'va_live_readback',
                  organization_id: 'org_rashed',
                  vehicle_id: 'veh_van_118',
                  assigned_to_user_id: 'usr_dr_khalid',
                  driver_user_id: 'usr_dr_khalid',
                  driver_name: 'Khalid Al-Farhan',
                  status: assignmentState,
                  started_at: '2026-05-21T06:23:02.000Z',
                  ended_at: assignmentState === 'ended' ? '2026-05-21T06:25:10.000Z' : null,
                },
              ];
          return { rows, total: rows.length, page: 0, page_size: 100 } as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
        }
        return realComplete(resource, opts);
      },
    );

    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);
    await user.click(screen.getByRole('tab', { name: /Assignments/i }));

    await user.click(screen.getByRole('button', { name: /Assign new driver/i }));
    await waitFor(() => {
      expect(document.querySelectorAll('.palette__item').length).toBeGreaterThan(0);
    });
    const driverEntries = Array.from(
      document.querySelectorAll('.palette__item .palette__item-label'),
    ) as HTMLElement[];
    const target = driverEntries.find((el) => /Khalid/i.test(el.textContent ?? ''));
    if (!target) throw new Error('Driver entry not found in picker');
    await user.click(target);

    await waitFor(() => {
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toMatch(/Khalid Al-Farhan/);
      expect(drawerText).toMatch(/Active/i);
    });

    await user.click(screen.getByRole('button', { name: /End assignment/i }));
    await waitFor(() => {
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toMatch(/Khalid Al-Farhan/);
      expect(drawerText).toMatch(/Historical/i);
    });
  });

  it('New vehicle create shows backend vehicle_directory readback in the roster without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    const baseVehicle = {
      id: 'veh_readback_seed',
      organization_id: 'org_rashed',
      plate: 'MX-SEED-100',
      plate_number: 'MX-SEED-100',
      vin: 'VIN-SEED-100',
      type_id: 'vt_van',
      vehicle_type_id: 'vt_van',
      type_name: 'Cargo van',
      vehicle_type_label: 'Cargo van',
      current_driver_user_id: null,
      current_driver_label: null,
      current_branch_id: 'hub_riyadh',
      branch_id: 'hub_riyadh',
      branch_label: 'Riyadh hub',
      current_branch_label: 'Riyadh hub',
      status: 'active',
      fuel_level: 75,
      odometer_km: 12000,
      last_telemetry_at: null,
      is_oos: false,
      is_in_maintenance: false,
      event_count_24h: 0,
      maintenance_window_count: 0,
      active_maintenance_count: 0,
      maintenance_due: false,
    };
    let visibleVehicles: Array<Record<string, unknown>> = [baseVehicle];
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_v1>[1]) => {
        if (resource === 'vehicle_directory') {
          return {
            rows: visibleVehicles,
            total: visibleVehicles.length,
            page: 0,
            page_size: 50,
          } as Awaited<ReturnType<typeof api.ui_list_resource_v1>>;
        }
        return originalList(resource, opts);
      },
    );
    const createSpy = vi.spyOn(api, 'create_vehicle_v1').mockImplementation(async (payload) => {
      const plate = String(payload.plate_number);
      visibleVehicles = [
        ...visibleVehicles,
        {
          ...baseVehicle,
          id: 'veh_readback_created',
          plate,
          plate_number: plate,
          vin: String(payload.vin ?? ''),
          vehicle_type_id: payload.vehicle_type_id,
          branch_id: payload.branch_id,
        },
      ];
      return {
        ok: true,
        vehicle_id: 'veh_readback_created',
        correlation_id: 'corr_vehicle_readback',
      };
    });

    await mountAndWait();
    expect(screen.getByText('MX-SEED-100')).toBeInTheDocument();
    expect(screen.queryByText('MX-READBACK-901')).not.toBeInTheDocument();
    const startingPath = window.location.pathname;

    await user.click(screen.getByRole('button', { name: /New vehicle/i }));
    const modal = document.querySelector('.modal') as HTMLElement | null;
    if (!modal) throw new Error('New vehicle modal missing');
    await user.type(within(modal).getAllByRole('textbox')[0]!, 'MX-READBACK-901');
    await user.click(within(modal).getByRole('button', { name: /Create vehicle/i }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ plate_number: 'MX-READBACK-901' }));
      expect(document.querySelector('.modal')).toBeNull();
      const readbackRow = screen.getByText('MX-READBACK-901').closest('tr');
      expect(readbackRow?.textContent ?? '').toMatch(/VIN|Cargo van|Riyadh hub|Active/i);
    });
    expect(window.location.pathname).toBe(startingPath);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'vehicle_directory').length,
    ).toBeGreaterThan(1);
  });

  it('row action marks a vehicle out-of-service from backend readback in the same roster', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    let visibleVehicles: Array<Record<string, unknown>> = [
      {
        id: 'veh_readback_oos',
        organization_id: 'org_rashed',
        plate: 'MX-OOS-100',
        plate_number: 'MX-OOS-100',
        vin: 'VIN-OOS-100',
        type_id: 'vt_van',
        vehicle_type_id: 'vt_van',
        type_name: 'Cargo van',
        vehicle_type_label: 'Cargo van',
        current_driver_user_id: null,
        current_driver_label: null,
        current_branch_id: 'hub_riyadh',
        branch_id: 'hub_riyadh',
        branch_label: 'Riyadh hub',
        current_branch_label: 'Riyadh hub',
        status: 'active',
        fuel_level: 75,
        odometer_km: 12000,
        last_telemetry_at: null,
        is_oos: false,
        is_in_maintenance: false,
        event_count_24h: 0,
        maintenance_window_count: 0,
        active_maintenance_count: 0,
        maintenance_due: false,
      },
    ];
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_v1>[1]) => {
        if (resource === 'vehicle_directory') {
          return {
            rows: visibleVehicles,
            total: visibleVehicles.length,
            page: 0,
            page_size: 50,
          } as Awaited<ReturnType<typeof api.ui_list_resource_v1>>;
        }
        return originalList(resource, opts);
      },
    );
    const oosSpy = vi.spyOn(api, 'mark_vehicle_oos_v1').mockImplementation(async () => {
      visibleVehicles = visibleVehicles.map((row) =>
        row.id === 'veh_readback_oos'
          ? { ...row, status: 'oos', is_oos: true }
          : row,
      );
      return {
        ok: true,
        vehicle_id: 'veh_readback_oos',
        correlation_id: 'corr_vehicle_oos_readback',
      };
    });

    await mountAndWait();
    expect(screen.getByText('MX-OOS-100')).toBeInTheDocument();
    const vehicleRow = screen.getByText('MX-OOS-100').closest('tr');
    if (!vehicleRow) throw new Error('MX-OOS-100 row not found');
    expect(vehicleRow.textContent ?? '').not.toMatch(/Out of service/i);
    const actionButtons = screen
      .getAllByLabelText('Row actions')
      .filter((node) => node.tagName === 'BUTTON');
    expect(actionButtons).toHaveLength(1);

    await user.click(actionButtons[0]!);
    await user.click(await screen.findByRole('option', { name: /^Mark out-of-service/ }));
    const modal = document.querySelector('.modal') as HTMLElement | null;
    expect(modal).not.toBeNull();
    await user.type(within(modal!).getByLabelText(/Out-of-service reason/i), 'Live maintenance hold');
    await user.click(within(modal!).getByRole('button', { name: /^Mark out-of-service$/i }));

    await waitFor(() => {
      expect(oosSpy).toHaveBeenCalledWith(expect.objectContaining({
        vehicle_id: 'veh_readback_oos',
        reason: 'Live maintenance hold',
      }));
      expect(vehicleRow.textContent ?? '').toMatch(/Out of service/i);
      expect(document.querySelector('.modal')).toBeNull();
    });
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'vehicle_directory').length,
    ).toBeGreaterThan(1);
  });

  it('row action restores an out-of-service vehicle from backend readback in the same roster', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    let visibleVehicles: Array<Record<string, unknown>> = [
      {
        id: 'veh_readback_restore',
        organization_id: 'org_rashed',
        plate: 'MX-RESTORE-100',
        plate_number: 'MX-RESTORE-100',
        vin: 'VIN-RESTORE-100',
        type_id: 'vt_van',
        vehicle_type_id: 'vt_van',
        type_name: 'Cargo van',
        vehicle_type_label: 'Cargo van',
        current_driver_user_id: null,
        current_driver_label: null,
        current_branch_id: 'hub_riyadh',
        branch_id: 'hub_riyadh',
        branch_label: 'Riyadh hub',
        current_branch_label: 'Riyadh hub',
        status: 'oos',
        fuel_level: 72,
        odometer_km: 12100,
        last_telemetry_at: null,
        is_oos: true,
        is_in_maintenance: false,
        event_count_24h: 1,
        maintenance_window_count: 0,
        active_maintenance_count: 0,
        maintenance_due: false,
      },
    ];
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_v1>[1]) => {
        if (resource === 'vehicle_directory') {
          return {
            rows: visibleVehicles,
            total: visibleVehicles.length,
            page: 0,
            page_size: 50,
          } as Awaited<ReturnType<typeof api.ui_list_resource_v1>>;
        }
        return originalList(resource, opts);
      },
    );
    const restoreSpy = vi.spyOn(api, 'restore_vehicle_v1').mockImplementation(async () => {
      visibleVehicles = visibleVehicles.map((row) =>
        row.id === 'veh_readback_restore'
          ? { ...row, status: 'active', is_oos: false }
          : row,
      );
      return {
        ok: true,
        vehicle_id: 'veh_readback_restore',
        correlation_id: 'corr_vehicle_restore_readback',
      };
    });

    await mountAndWait();
    expect(screen.getByText('MX-RESTORE-100')).toBeInTheDocument();
    const vehicleRow = screen.getByText('MX-RESTORE-100').closest('tr');
    if (!vehicleRow) throw new Error('MX-RESTORE-100 row not found');
    expect(vehicleRow.textContent ?? '').toMatch(/Out of service/i);
    const startingPath = window.location.pathname;

    const actionButtons = screen
      .getAllByLabelText('Row actions')
      .filter((node) => node.tagName === 'BUTTON');
    expect(actionButtons).toHaveLength(1);

    await user.click(actionButtons[0]!);
    await user.click(await screen.findByRole('option', { name: /^Restore in-service/ }));

    await waitFor(() => {
      expect(restoreSpy).toHaveBeenCalledWith(expect.objectContaining({
        vehicle_id: 'veh_readback_restore',
      }));
      expect(vehicleRow.textContent ?? '').toMatch(/Active/i);
      expect(vehicleRow.textContent ?? '').not.toMatch(/Out of service/i);
    });
    expect(window.location.pathname).toBe(startingPath);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'vehicle_directory').length,
    ).toBeGreaterThan(1);
  });

  it('row click opens drawer with all 6 tabs', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    expect(firstRow).not.toBeNull();
    await user.click(firstRow as Element);

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    // All 6 tabs are present (role="tab").
    const tabs = screen.getAllByRole('tab');
    const labels = tabs.map((t) => t.textContent?.trim() ?? '');
    expect(labels).toEqual(
      expect.arrayContaining(['Profile', 'Assignments', 'Maintenance', 'Events', 'Documents', 'Telemetry']),
    );
  });

  // Phase C6 — wire-through to canonical Phase B2 RPCs. Old `runCommand`
  // assertions replaced by direct facade spies on the canonical contract.
  it('opens the drawer when live vehicle readback has a null odometer', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_complete>[1]) => {
        const result = await originalList(resource, opts);
        if (resource !== 'vehicle_directory') return result;
        return {
          ...result,
          rows: result.rows.map((row, index) => (
            index === 0 ? { ...row, odometer_km: null } : row
          )),
        };
      },
    );

    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    expect(firstRow).not.toBeNull();
    await user.click(firstRow as Element);

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).toMatch(/Odometer \(km\)/);
    expect(drawerText).not.toMatch(/Cannot read properties/);
  });

  it('vehicle Documents tab submits upload_vehicle_document_v1', async () => {
    const user = userEvent.setup();
    const uploadSpy = vi.spyOn(api, 'upload_vehicle_document_v1').mockResolvedValue({
      ok: true,
      vehicle_document_id: 'vdoc_test',
      correlation_id: 'corr_doc',
    });

    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);
    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('tab', { name: /Documents/i }));
    expect(screen.queryByText(/PREVIEW/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: /Attach document/i }));
    await waitFor(() => {
      expect(screen.getByText(/Attach a registered document file to this vehicle profile/i)).toBeInTheDocument();
    });
    const modal = document.querySelector('.modal') as HTMLElement | null;
    if (!modal) throw new Error('Attach document modal missing');
    const textboxes = within(modal).getAllByRole('textbox');
    await user.type(textboxes[0]!, 'Fleet Authority');
    await user.type(textboxes[1]!, '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830');
    await user.click(within(modal).getByRole('button', { name: /Attach document/i }));

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          vehicle_id: expect.any(String),
          doc_type: expect.any(String),
          artifact_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
          issuer: 'Fleet Authority',
        }),
      );
    });
    expect(typeof api.upload_vehicle_document_v1).toBe('function');
    uploadSpy.mockRestore();
  });

  it('vehicle document modal uses canonical plate_number after live drawer refetch', async () => {
    const user = userEvent.setup();
    const realGet = api.ui_get_resource_v1;
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'vehicle_directory') {
        return {
          id,
          organization_id: 'org_rashed',
          plate_number: 'LIVE-PLATE-ONLY',
          vin: 'VIN-LIVE-PLATE-ONLY',
          type_id: 'vt_van',
          vehicle_type_id: 'vt_van',
          type_name: 'Van',
          vehicle_type_label: 'Van',
          current_driver_user_id: null,
          current_driver_label: null,
          current_branch_id: 'hub_riyadh',
          branch_id: 'hub_riyadh',
          branch_label: 'Riyadh hub',
          current_branch_label: 'Riyadh hub',
          status: 'active',
          fuel_level: 0,
          odometer_km: 0,
          last_telemetry_at: null,
          is_oos: false,
          is_in_maintenance: false,
        } as never;
      }
      return realGet(resource, id) as never;
    });

    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/LIVE-PLATE-ONLY/);
    });

    await user.click(screen.getByRole('tab', { name: /Documents/i }));
    await user.click(screen.getByRole('button', { name: /Attach document/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Attach document - LIVE-PLATE-ONLY/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog', { name: /undefined/i })).not.toBeInTheDocument();
  });

  it('vehicle Documents tab refreshes the open drawer after attaching a backend document', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_complete;
    let uploadCompleted = false;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_complete>[1]) => {
        if (resource === 'vehicle_documents') {
          const vehicleId = String(opts?.filter?.vehicle_id ?? 'veh_van_118');
          return {
            rows: uploadCompleted
              ? [
                  {
                    id: 'vdoc_after_attach',
                    organization_id: 'org_rashed',
                    vehicle_id: vehicleId,
                    doc_type: 'registration',
                    issuer: 'Fleet Authority',
                    artifact_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
                    status: 'submitted',
                    issued_at: null,
                    expires_at: null,
                  },
                ]
              : [],
            total: uploadCompleted ? 1 : 0,
            page: 0,
            page_size: 100,
          } as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
        }
        return originalList(resource, opts);
      },
    );
    const uploadSpy = vi.spyOn(api, 'upload_vehicle_document_v1').mockImplementation(async () => {
      uploadCompleted = true;
      return {
        ok: true,
        vehicle_document_id: 'vdoc_after_attach',
        correlation_id: 'corr_doc_after_attach',
      };
    });

    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);
    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('tab', { name: /Documents/i }));
    expect(screen.getByText(/No documents on file/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Attach document/i }));
    const modal = document.querySelector('.modal') as HTMLElement | null;
    if (!modal) throw new Error('Attach document modal missing');
    const textboxes = within(modal).getAllByRole('textbox');
    await user.type(textboxes[0]!, 'Fleet Authority');
    await user.type(textboxes[1]!, '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830');
    await user.click(within(modal).getByRole('button', { name: /Attach document/i }));

    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/Fleet Authority/);
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/Registered document/);
    });
    expect(uploadSpy).toHaveBeenCalled();
  });

  it('vehicle Telemetry tab records telemetry through record_vehicle_event_v1', async () => {
    const user = userEvent.setup();
    const recordSpy = vi.spyOn(api, 'record_vehicle_event_v1').mockResolvedValue({
      ok: true,
      vehicle_event_id: 'vev_test',
      correlation_id: 'corr_event',
    });

    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);
    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('tab', { name: /Telemetry/i }));
    expect(screen.queryByText(/PREVIEW/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: /Record telemetry/i }));
    await waitFor(() => {
      expect(screen.getByText(/Records odometer and fuel telemetry for this vehicle/i)).toBeInTheDocument();
    });
    const modal = document.querySelector('.modal') as HTMLElement | null;
    if (!modal) throw new Error('Record telemetry modal missing');
    await user.click(within(modal).getByRole('button', { name: /Record telemetry/i }));

    await waitFor(() => {
      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          vehicle_id: expect.any(String),
          event_type: expect.any(String),
        }),
      );
    });
    recordSpy.mockRestore();
  });

  it('renders vehicle event timeline with operator-facing event labels', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('tab', { name: /Events/i }));
    const timelineToggle = screen.getByRole('button', { name: /Timeline/i });
    await user.click(timelineToggle);

    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).not.toMatch(/Unconfigured event type [a-z_]+|vehicle_event_type|event_type/i);
  });

  it('redacts sensitive vehicle event payload fields in table and timeline views', async () => {
    const originalList = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_complete>[1]) => {
        if (resource === 'vehicle_events') {
          return {
            rows: [
              {
                id: 'vev_sensitive',
                organization_id: 'org_rashed',
                vehicle_id: 'veh_van_118',
                event_type: 'telemetry',
                occurred_at: '2026-04-26T08:00:00Z',
                actor_user_id: 'usr_admin_rashed',
                actor_name: 'Fleet Ops',
                metadata: {
                  api_key: 'sk_live_should_not_render',
                  nested: { refresh_token: 'refresh_should_not_render' },
                  odometer_km: 10120,
                },
              },
            ],
            total: 1,
            page: 0,
            page_size: 25,
          } as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
        }
        return originalList(resource, opts);
      },
    );

    const user = userEvent.setup();
    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);
    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('tab', { name: /Events/i }));
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/\[redacted\]/i);
    });

    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).not.toMatch(/sk_live_should_not_render|refresh_should_not_render/i);
    const timelineToggle = screen.getByRole('button', { name: /Timeline/i });
    await user.click(timelineToggle);
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/\[redacted\]/i);
    });
    const timelineText = document.querySelector('.drawer')?.textContent ?? '';
    expect(timelineText).not.toMatch(/sk_live_should_not_render|refresh_should_not_render/i);
  });

  it('Assign-new-driver flow fires assign_driver_to_vehicle_v1 with canonical p_args', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'assign_driver_to_vehicle_v1').mockResolvedValue({
      ok: true,
      vehicle_assignment_id: 'va_test',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });

    await mountAndWait();

    // Open drawer for the first vehicle
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    // Switch to Assignments tab
    const assignmentsTab = screen.getByRole('tab', { name: /Assignments/i });
    await user.click(assignmentsTab);

    // Click "Assign new driver" → opens the ReferencePicker (palette)
    const assignBtn = screen.getByRole('button', { name: /Assign new driver/i });
    await user.click(assignBtn);

    await waitFor(() => {
      expect(document.querySelectorAll('.palette__item').length).toBeGreaterThan(0);
    });
    const pickerText = document.querySelector('.palette')?.textContent ?? '';
    expect(pickerText).not.toMatch(/usr_dr_/i);
    expect(pickerText).toMatch(/Available for assignment|Currently assigned/i);

    // Pick a driver (Khalid). The picker is a palette wrapper.
    const driverEntries = Array.from(
      document.querySelectorAll('.palette__item .palette__item-label'),
    ) as HTMLElement[];
    const target = driverEntries.find((el) => /Khalid/i.test(el.textContent ?? ''));
    if (!target) throw new Error('Driver entry not found in picker');
    await user.click(target);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      vehicle_id: expect.any(String),
      driver_user_id: 'usr_dr_khalid',
    });
    spy.mockRestore();
  });

  // W29 — paired projection contract assertions for vehicle_directory +
  // vehicle_maintenance_directory. Verifies (a) the registry exposes the
  // canonical relation name, (b) the seed-mode adapter (via
  // ui_list_resource_v1) returns the expected derived columns so live
  // cutover stays a single registry flip.
  it('vehicle_directory and vehicle_maintenance_directory paired projections are wired through registry + ui_list_resource_v1', async () => {
    const reg = (registry as unknown as { ui_read_registry: Record<string, { relation: string; capability_read: string; capability_write?: string }> })
      .ui_read_registry;
    expect(reg.vehicle_directory?.relation).toBe('v_vehicle_directory');
    expect(reg.vehicle_directory?.capability_read).toBe('fleet.read');
    expect(reg.vehicle_documents?.relation).toBe('vehicle_documents');
    expect(reg.vehicle_documents?.capability_read).toBe('fleet.read');
    expect(reg.vehicle_documents?.capability_write).toBe('fleet.write');
    expect(reg.vehicle_maintenance_directory?.relation).toBe('v_vehicle_maintenance_directory');
    expect(reg.vehicle_maintenance_directory?.capability_read).toBe('fleet.read');
    expect(reg.hubs?.capability_read).toBe('fleet.read');

    // Seed-mode projection must surface canonical labels, lifecycle
    // counters, and status booleans on every row.
    const vehicleRes = await ds.ui_list_resource_v1<Record<string, unknown>>('vehicle_directory');
    expect(vehicleRes.rows.length).toBeGreaterThan(0);
    const v0 = vehicleRes.rows[0]!;
    expect(typeof v0.id).toBe('string');
    expect('branch_label' in v0).toBe(true);
    expect('vehicle_type_label' in v0).toBe(true);
    expect('current_driver_label' in v0).toBe(true);
    expect('fuel_level' in v0).toBe(true);
    expect('odometer_km' in v0).toBe(true);
    expect('last_telemetry_at' in v0).toBe(true);
    expect(typeof v0.event_count_24h).toBe('number');
    expect(typeof v0.maintenance_window_count).toBe('number');
    expect(typeof v0.maintenance_due).toBe('boolean');
    expect(typeof v0.is_oos).toBe('boolean');
    expect(typeof v0.is_in_maintenance).toBe('boolean');

    const docsRes = await ds.ui_list_resource_v1<Record<string, unknown>>('vehicle_documents');
    expect(docsRes.rows.length).toBeGreaterThan(0);
    expect(docsRes.rows[0]).toMatchObject({
      vehicle_id: expect.any(String),
      doc_type: expect.any(String),
    });

    const maintRes = await ds.ui_list_resource_v1<Record<string, unknown>>('vehicle_maintenance_directory');
    expect(maintRes.rows.length).toBeGreaterThan(0);
    const m0 = maintRes.rows[0]!;
    expect(typeof m0.id).toBe('string');
    expect('vehicle_label' in m0).toBe(true);
    expect(typeof m0.is_scheduled).toBe('boolean');
    expect(typeof m0.is_completed).toBe('boolean');
    expect(typeof m0.is_cancelled).toBe('boolean');
    expect(typeof m0.is_in_progress).toBe('boolean');
    expect(typeof m0.is_overdue).toBe('boolean');
    expect(typeof m0.is_terminal).toBe('boolean');
  });

  it('Schedule-maintenance flow fires schedule_maintenance_v1 with canonical p_args', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'schedule_maintenance_v1').mockResolvedValue({
      ok: true,
      maintenance_window_id: 'mw_test',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });

    await mountAndWait();

    // Open drawer
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    // Switch to Maintenance tab
    const maintenanceTab = screen.getByRole('tab', { name: /Maintenance/i });
    await user.click(maintenanceTab);

    // Click "Schedule maintenance" → opens modal
    const scheduleBtn = screen.getByRole('button', { name: /Schedule maintenance/i });
    await user.click(scheduleBtn);

    await waitFor(() => {
      expect(document.querySelectorAll('.modal').length).toBeGreaterThan(0);
    });

    // Submit (defaults populate every field).
    const submitBtn = (await screen.findAllByRole('button', { name: /^Schedule$/i }, { timeout: 5000 }))
      .find((b) => !b.hasAttribute('disabled'));
    if (!submitBtn) throw new Error('Schedule submit button not found');
    await user.click(submitBtn);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    // Canonical column names are window_start_at / window_end_at / reason
    // (per migration 202601231000_fleet_foundation_v1.sql + Phase B2 RPC).
    expect(payload).toMatchObject({
      vehicle_id: expect.any(String),
      window_start_at: expect.any(String),
      window_end_at: expect.any(String),
      reason: expect.any(String),
    });
    spy.mockRestore();
  });

  it('Schedule-maintenance flow shows backend readback in the same drawer without reload', async () => {
    const user = userEvent.setup();
    const originalGet = api.ui_get_resource_v1;
    let scheduledPayload: Record<string, unknown> | null = null;
    const scheduleSpy = vi.spyOn(api, 'schedule_maintenance_v1').mockImplementation(async (payload) => {
      scheduledPayload = payload;
      return {
        ok: true,
        vehicle_maintenance_window_id: 'vmw_schedule_drawer_readback',
        vehicle_id: payload.vehicle_id,
        correlation_id: 'corr_schedule_drawer_readback',
        settings_resolution_id: 'srlv_schedule_drawer_readback',
      };
    });
    const getSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'vehicle_maintenance_directory' && id === 'vmw_schedule_drawer_readback') {
        return {
          id: 'vmw_schedule_drawer_readback',
          vehicle_id: String(scheduledPayload?.vehicle_id ?? 'veh_van_118'),
          window_start_at: String(scheduledPayload?.window_start_at ?? '2031-01-10T08:00:00Z'),
          window_end_at: String(scheduledPayload?.window_end_at ?? '2031-01-10T10:00:00Z'),
          reason: 'brake_service',
          status: 'scheduled',
          is_scheduled: true,
          is_completed: false,
          is_cancelled: false,
          is_terminal: false,
          is_in_progress: false,
          is_overdue: false,
        } as never;
      }
      return originalGet(resource, id) as never;
    });

    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);
    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });
    const startingPath = window.location.pathname;

    await user.click(screen.getByRole('tab', { name: /Maintenance/i }));
    await user.click(screen.getByRole('button', { name: /Schedule maintenance/i }));
    const submitBtn = (await screen.findAllByRole('button', { name: /^Schedule$/i }, { timeout: 5000 }))
      .find((b) => !b.hasAttribute('disabled'));
    if (!submitBtn) throw new Error('Schedule submit button not found');
    await user.click(submitBtn);

    await waitFor(() => {
      expect(scheduleSpy).toHaveBeenCalled();
      expect(getSpy).toHaveBeenCalledWith('vehicle_maintenance_directory', 'vmw_schedule_drawer_readback');
      expect(document.querySelector('.modal')).toBeNull();
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toMatch(/Brake Service/i);
      expect(drawerText).toMatch(/scheduled/i);
    });
    expect(window.location.pathname).toBe(startingPath);
  });

  it('Add-event flow shows backend event readback in the same drawer without reload', async () => {
    const user = userEvent.setup();
    const originalGet = api.ui_get_resource_v1;
    let recordedPayload: Record<string, unknown> | null = null;
    const recordSpy = vi.spyOn(api, 'record_vehicle_event_v1').mockImplementation(async (payload) => {
      recordedPayload = payload;
      return {
        ok: true,
        vehicle_event_id: 'vev_drawer_readback',
        vehicle_id: payload.vehicle_id,
        correlation_id: 'corr_event_drawer_readback',
      };
    });
    const getSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'vehicle_events' && id === 'vev_drawer_readback') {
        return {
          id: 'vev_drawer_readback',
          vehicle_id: String(recordedPayload?.vehicle_id ?? 'veh_van_118'),
          event_type: String(recordedPayload?.event_type ?? 'maintenance'),
          occurred_at: '2031-01-10T09:00:00Z',
          actor_user_id: 'usr_admin_rashed',
          actor_name: 'Fleet Ops',
          metadata: {
            notes: 'EvtReadback29',
          },
        } as never;
      }
      return originalGet(resource, id) as never;
    });

    await mountAndWait();
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);
    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });
    const startingPath = window.location.pathname;

    await user.click(screen.getByRole('tab', { name: /Events/i }));
    await user.click(screen.getByRole('button', { name: /Add event/i }));
    const modal = document.querySelector('.modal') as HTMLElement | null;
    if (!modal) throw new Error('Record event modal missing');
    await user.type(within(modal).getByPlaceholderText(/Detail captured/i), 'EvtReadback29');
    await user.click(within(modal).getByRole('button', { name: /Record event/i }));

    await waitFor(() => {
      expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({
        vehicle_id: expect.any(String),
        event_type: expect.any(String),
      }));
      expect(getSpy).toHaveBeenCalledWith('vehicle_events', 'vev_drawer_readback');
      expect(document.querySelector('.modal')).toBeNull();
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/EvtReadback29/i);
    });
    expect(window.location.pathname).toBe(startingPath);
  });

  it('fails closed when vehicle maintenance default window policy lacks start or end time', async () => {
    const user = userEvent.setup();
    const realResolveSettings = api.resolveSettings;
    vi.spyOn(api, 'resolveSettings').mockImplementation((category: string, scope?: unknown) => {
      if (category === 'vehicle_maintenance_default_window') {
        return Promise.resolve({
          value: { default_offset_hours: 24 },
          resolved_from: 'global',
          ladder_path: [],
          settings_resolution_id: 'srlv_incomplete_maintenance_window',
          override_of: null,
        } as never);
      }
      return realResolveSettings(category, scope as never) as never;
    });
    const scheduleSpy = vi.spyOn(api, 'schedule_maintenance_v1').mockResolvedValue({
      ok: true,
      maintenance_window_id: 'mw_should_not_schedule',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });

    await mountAndWait();

    const firstRow = document.querySelector('.dt__table tbody tr');
    if (!firstRow) throw new Error('no row');
    await user.click(firstRow);

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('tab', { name: /Maintenance/i }));
    await user.click(screen.getByRole('button', { name: /Schedule maintenance/i }));

    await screen.findByText('Maintenance policy incomplete');
    expect(screen.getByText(/default_window_start and default_window_end/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Schedule$/i })).not.toBeInTheDocument();
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('Mark complete fires complete_maintenance_v1 with vehicle_maintenance_window_id', async () => {
    const user = userEvent.setup();
    let vehicleOdometerReadback = 12000;
    const spy = vi.spyOn(api, 'complete_maintenance_v1').mockImplementation(async () => {
      vehicleOdometerReadback = 99001;
      return {
        ok: true,
        vehicle_maintenance_window_id: 'vmw_3003',
        correlation_id: 'cor_x',
        settings_resolution_id: 'srlv_x',
      };
    });
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'vehicle_directory' && id === 'veh_box_312') {
        return {
          id: 'veh_box_312',
          organization_id: 'org_rashed',
          plate: 'DMM 3124',
          plate_number: 'DMM 3124',
          vin: 'VIN-DMM-3124',
          type_id: 'vt_box',
          vehicle_type_id: 'vt_box',
          type_name: 'Box truck',
          vehicle_type_label: 'Box truck',
          current_driver_user_id: null,
          current_driver_label: null,
          current_branch_id: 'hub_riyadh',
          branch_id: 'hub_riyadh',
          branch_label: 'Riyadh hub',
          current_branch_label: 'Riyadh hub',
          status: 'active',
          fuel_level: 0.75,
          odometer_km: vehicleOdometerReadback,
          last_telemetry_at: null,
          is_oos: false,
          is_in_maintenance: false,
          event_count_24h: 0,
          maintenance_window_count: 1,
          active_maintenance_count: 0,
          maintenance_due: false,
        } as never;
      }
      if (resource === 'vehicle_maintenance_directory' && id === 'vmw_3003') {
        return {
          id: 'vmw_3003',
          vehicle_id: 'veh_box_312',
          window_start_at: '2026-04-22T09:00:00Z',
          window_end_at: '2026-04-22T17:00:00Z',
          reason: 'major_repair',
          status: 'completed',
          is_terminal: true,
          is_completed: true,
          is_cancelled: false,
        } as never;
      }
      return null;
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (
        resource === 'vehicle_maintenance_directory'
        && (opts as { filter?: Record<string, unknown> } | undefined)?.filter?.id === 'vmw_3003'
      ) {
        return {
          rows: [{
            id: 'vmw_3003',
            vehicle_id: 'veh_box_312',
            window_start_at: '2026-04-22T09:00:00Z',
            window_end_at: '2026-04-22T17:00:00Z',
            reason: 'major_repair',
            status: 'completed',
            is_terminal: true,
            is_completed: true,
            is_cancelled: false,
          }],
          total: 1,
          page: 0,
          page_size: 1,
        } as never;
      }
      return ds.ui_list_resource_complete(resource, opts as never) as never;
    });

    await mountAndWait();

    const vehicleCell = await screen.findByText('DMM 3124');
    const row = vehicleCell.closest('tr');
    if (!row) throw new Error('DMM 3124 row not found');
    await user.click(row);

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    const maintenanceTab = screen.getByRole('tab', { name: /Maintenance/i });
    await user.click(maintenanceTab);
    const completeBtn = await screen.findByRole('button', { name: /Mark complete/i });
    await user.click(completeBtn);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toEqual({ vehicle_maintenance_window_id: 'vmw_3003' });
    expect(payload).not.toHaveProperty('window_id');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Mark complete/i })).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('tab', { name: /Profile/i }));
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/99,001/);
    });
    spy.mockRestore();
  });

  it('Maintenance cancel fires cancel_maintenance_v1 with vehicle_maintenance_window_id and canonical reason', async () => {
    const user = userEvent.setup();
    const realGetLookups = api.getLookups;
    vi.spyOn(api, 'getLookups').mockImplementation((category: string) =>
      category === 'maintenance_cancel_reason' ? [] : realGetLookups(category),
    );
    const liveLookupSpy = vi.spyOn(api, 'getLookupsLive').mockResolvedValue([{
      value: 'operator_cancelled',
      label: 'Operator cancelled',
      rank: 10,
      metadata: {},
    }]);
    const spy = vi.spyOn(api, 'cancel_maintenance_v1').mockResolvedValue({
      ok: true,
      vehicle_maintenance_window_id: 'vmw_3003',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'vehicle_maintenance_directory' && id === 'vmw_3003') {
        return {
          id: 'vmw_3003',
          vehicle_id: 'veh_box_312',
          window_start_at: '2026-04-22T09:00:00Z',
          window_end_at: '2026-04-22T17:00:00Z',
          reason: 'major_repair',
          status: 'cancelled',
          is_terminal: true,
          is_completed: false,
          is_cancelled: true,
        } as never;
      }
      return null;
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (
        resource === 'vehicle_maintenance_directory'
        && (opts as { filter?: Record<string, unknown> } | undefined)?.filter?.id === 'vmw_3003'
      ) {
        return {
          rows: [{
            id: 'vmw_3003',
            vehicle_id: 'veh_box_312',
            window_start_at: '2026-04-22T09:00:00Z',
            window_end_at: '2026-04-22T17:00:00Z',
            reason: 'major_repair',
            status: 'cancelled',
            is_terminal: true,
            is_completed: false,
            is_cancelled: true,
          }],
          total: 1,
          page: 0,
          page_size: 1,
        } as never;
      }
      return ds.ui_list_resource_complete(resource, opts as never) as never;
    });

    await mountAndWait();

    const vehicleCell = await screen.findByText('DMM 3124');
    const row = vehicleCell.closest('tr');
    if (!row) throw new Error('DMM 3124 row not found');
    await user.click(row);

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });

    const maintenanceTab = screen.getByRole('tab', { name: /Maintenance/i });
    await user.click(maintenanceTab);
    const completeBtn = await screen.findByRole('button', { name: /Mark complete/i });
    const actionRow = completeBtn.closest('div');
    if (!actionRow) throw new Error('maintenance action row not found');
    const cancelBtn = within(actionRow as HTMLElement).getByRole('button', { name: /Cancel/i });
    await user.click(cancelBtn);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      vehicle_maintenance_window_id: 'vmw_3003',
      reason: 'operator_cancelled',
    });
    expect(payload).not.toHaveProperty('window_id');
    expect(liveLookupSpy).toHaveBeenCalledWith('maintenance_cancel_reason');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Cancel/i })).not.toBeInTheDocument();
    });
    spy.mockRestore();
  });

});
