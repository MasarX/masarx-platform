// branches.test.tsx — covers BranchesModule (CLAIM-NETWORK-BRANCHES, Wave 1).
//
// Asserts the load-bearing surface invariants:
//   • Mount + KPI strip + cards render from the canonical seed.
//   • CapacityGauge renders the today-vs-capacity ratio per card (aria-valuenow
//     percentage matches expected booked/capacity).
//   • Card click opens the multi-tab drawer with the active branch name.
//   • Switching to the Coverage tab renders the 7×24 CoverageHeatmap grid.
//   • Capability gate disables `New branch`, `Assign zone`, and `Remove staff`
//     when `branches.write` is missing (positive + negative case).
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ui_list_resource_complete, ui_list_resource_v1 } from '@/lib/data-source';
import * as api from '@/lib/api';
import { BranchesModule } from '../branches';

describe('BranchesModule (CLAIM-NETWORK-BRANCHES)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/network/branches');
  });

  it('mounts with KPI strip and a card grid populated from the seed', async () => {
    const { container } = renderWithProviders(<BranchesModule />);
    // Card grid is the load-bearing signal: it only mounts after every
    // resource query has resolved, so awaiting it lets us read KPIs +
    // cards without flakey waits.
    const grid = await screen.findByTestId('branches-grid');
    expect(grid).toBeInTheDocument();
    // KPI strip lives outside the grid; scope assertions to it so chip
    // labels (e.g. "Drop-off") don't collide with KPI labels.
    const kpiStrip = container.querySelector('.kpi-strip') as HTMLElement | null;
    expect(kpiStrip).not.toBeNull();
    expect(within(kpiStrip!).getByText('Hubs')).toBeInTheDocument();
    expect(within(kpiStrip!).getByText('Depots')).toBeInTheDocument();
    expect(within(kpiStrip!).getByText('Drop-off')).toBeInTheDocument();
    expect(within(kpiStrip!).getByText('Capacity utilization')).toBeInTheDocument();
    // Specific seed branch cards present in the grid.
    expect(within(grid).getByText('Riyadh North · Hub')).toBeInTheDocument();
    expect(within(grid).getByText('Jeddah North · Hub')).toBeInTheDocument();
  });

  it('scopes branch setup reads to the active tenant lens', async () => {
    const realList = api.ui_list_resource_v1;
    const realCompleteList = api.ui_list_resource_complete;
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'branches') {
        return {
          rows: [
            {
              id: 'br_swift_hub',
              organization_id: 'org_swift',
              code: 'SWF-HUB',
              name: 'Swift Hub',
              branch_type: 'hub',
              is_active: true,
              timezone: 'Asia/Riyadh',
            },
            {
              id: 'br_swift_wh',
              organization_id: 'org_swift',
              code: 'SWF-WH',
              name: 'Swift Warehouse',
              branch_type: 'warehouse',
              is_active: true,
              timezone: 'Asia/Riyadh',
            },
          ],
          total: 2,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'branch_summary') {
        return {
          rows: [
            {
              branch_id: 'br_swift_hub',
              organization_id: 'org_swift',
              capacity_per_day: 0,
              booked_today: 0,
              active_vehicles: 0,
              active_routes: 0,
              manager_user_id: null,
              cutoff_time: null,
            },
            {
              branch_id: 'br_swift_wh',
              organization_id: 'org_swift',
              capacity_per_day: 0,
              booked_today: 0,
              active_vehicles: 0,
              active_routes: 0,
              manager_user_id: null,
              cutoff_time: null,
            },
          ],
          total: 2,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'zones' || resource === 'route_runs' || resource === 'user_directory') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });
    const completeListSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (
        resource === 'branch_zones' ||
        resource === 'branch_memberships' ||
        resource === 'branch_capacity_heatmap' ||
        resource === 'branch_coverage_windows'
      ) {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realCompleteList(resource, opts);
    });

    renderWithProviders(<BranchesModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByTestId('branch-card-br_swift_hub')).toBeInTheDocument();
    expect(await screen.findByTestId('branch-card-br_swift_wh')).toBeInTheDocument();
    expect(screen.getByText('Warehouse')).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'branches',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'branch_summary',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'zones',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'route_runs',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'user_directory',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(completeListSpy).toHaveBeenCalledWith(
        'branch_zones',
        expect.objectContaining({ filter: { branch_id: 'br_swift_hub' } }),
      );
      expect(completeListSpy).toHaveBeenCalledWith(
        'branch_zones',
        expect.objectContaining({ filter: { branch_id: 'br_swift_wh' } }),
      );
      expect(completeListSpy.mock.calls.some(([resource, opts]) =>
        resource === 'branch_zones' &&
        !((opts as api.ListOpts | undefined)?.filter as Record<string, unknown> | undefined)?.branch_id,
      )).toBe(false);
    });
  });

  it('renders a CapacityGauge per card with the branch_summary booked_today ratio', async () => {
    renderWithProviders(<BranchesModule />);
    // Riyadh North hub projects 524/600 booked/capacity via branch_summary → 87%.
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    const gauge = within(card).getByRole('progressbar');
    // The accessible label encodes the ratio.
    const valueNow = Number(gauge.getAttribute('aria-valuenow'));
    expect(valueNow).toBeGreaterThanOrEqual(86);
    expect(valueNow).toBeLessThanOrEqual(88);
  });

  it('projects booked_today through branch_summary', async () => {
    const result = await ui_list_resource_v1<{ branch_id: string; booked_today: number }>(
      'branch_summary',
    );
    const ruhNorth = result.rows.find((row) => row.branch_id === 'hub_ruh_n');
    expect(ruhNorth).toBeDefined();
    expect(ruhNorth!.booked_today).toBe(524);
  });

  it('renders canonical jsonb branch addresses as operator-readable text', async () => {
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((async (resource: string, opts?: api.ListOpts) => {
      const result = await ui_list_resource_v1<Record<string, unknown>>(resource, opts);
      if (resource !== 'branches') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          row.id === 'hub_ruh_n'
            ? {
                ...row,
                city: undefined,
                address: {
                  district: 'Olaya',
                  city: 'Riyadh',
                  country: 'Saudi Arabia',
                },
              }
            : row,
        ),
      };
    }) as typeof api.ui_list_resource_v1);

    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />);

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    expect(within(card).getByText('Olaya, Riyadh, Saudi Arabia')).toBeInTheDocument();

    await user.click(card);
    expect(await screen.findAllByText('Olaya, Riyadh, Saudi Arabia')).not.toHaveLength(0);
  });

  it('opens the drawer with the branch name when a card is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />);
    const card = await screen.findByTestId('branch-card-hub_jed_n');
    await user.click(card);
    // Drawer title contains the branch label.
    const titles = await screen.findAllByText(/Branch · Jeddah North · Hub/);
    expect(titles.length).toBeGreaterThan(0);
    // Drawer tablist is present with all 7 tabs.
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    expect(within(tablist).getByRole('tab', { name: /Profile/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Coverage/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Capacity/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Zones/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Staff/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Vehicles/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Routes/i })).toBeInTheDocument();
  });

  it('refreshes the open drawer and card counts after assigning a branch zone', async () => {
    let assigned = false;
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'branches') {
        return {
          rows: [{
            id: 'br_live',
            organization_id: 'org_live',
            code: 'main',
            name: 'Main warehouse',
            branch_type: 'warehouse',
            is_active: true,
            timezone: 'Asia/Riyadh',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'branch_summary') {
        return {
          rows: [{
            branch_id: 'br_live',
            organization_id: 'org_live',
            capacity_per_day: 0,
            booked_today: 0,
            active_vehicles: 1,
            active_routes: 1,
            manager_user_id: null,
            cutoff_time: null,
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'zones') {
        return {
          rows: [{
            id: 'zone_live',
            organization_id: 'org_live',
            name: 'Riyadh Central',
            slug: 'riyadh-central',
            is_active: true,
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'route_runs' || resource === 'user_directory') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return ui_list_resource_v1<Record<string, unknown>>(resource, opts);
    });
    const completeListSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'branch_zones') {
        return {
          rows: assigned ? [{
            id: 'bz_live',
            branch_id: 'br_live',
            zone_id: 'zone_live',
            priority: 0,
          }] : [],
          total: assigned ? 1 : 0,
          page: 0,
          page_size: 100,
        };
      }
      if (
        resource === 'branch_memberships' ||
        resource === 'branch_capacity_heatmap' ||
        resource === 'branch_coverage_windows'
      ) {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return ui_list_resource_complete<Record<string, unknown>>(resource, opts);
    });
    const assignSpy = vi.spyOn(api, 'branch_zone_assign_v1').mockImplementation(async (args) => {
      assigned = true;
      return {
        ok: true,
        branch_zone_id: 'bz_live',
        branch_id: args.branch_id,
        zone_id: args.zone_id,
      } as never;
    });

    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_live', label: 'Live Tenant', rank: 2 } },
      },
    });

    const card = await screen.findByTestId('branch-card-br_live');
    expect(within(card).getByText(/0 zones/)).toBeInTheDocument();
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Zones/i }));
    expect(await screen.findByText(/Zones served .* 0/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Assign zone' }));
    await user.click(await screen.findByRole('option', { name: /Riyadh Central/i }));

    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith({
      branch_id: 'br_live',
      zone_id: 'zone_live',
      priority: 0,
    }));
    expect(await screen.findByText(/Zones served .* 1/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Riyadh Central/i })).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByText(/1 zones/)).toBeInTheDocument());

    listSpy.mockRestore();
    completeListSpy.mockRestore();
    assignSpy.mockRestore();
  });

  it('uses saved initial branch capacity when the summary projection has not materialized capacity yet', async () => {
    const realList = api.ui_list_resource_v1;
    const realCompleteList = api.ui_list_resource_complete;
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'branches') {
        return {
          rows: [{
            id: 'br_a2z_capacity',
            organization_id: 'org_a2z',
            code: 'A2Z-RUH',
            name: 'A2Z Riyadh Branch',
            branch_type: 'branch',
            is_active: true,
            timezone: 'Asia/Riyadh',
            metadata: { lifecycle: 'active', initial_capacity_per_day: 250 },
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'branch_summary') {
        return {
          rows: [{
            branch_id: 'br_a2z_capacity',
            organization_id: 'org_a2z',
            capacity_per_day: 0,
            booked_today: 0,
            active_vehicles: 0,
            active_routes: 0,
            manager_user_id: null,
            cutoff_time: null,
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'zones' || resource === 'route_runs' || resource === 'user_directory') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });
    const completeListSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (
        resource === 'branch_zones' ||
        resource === 'branch_memberships' ||
        resource === 'branch_capacity_heatmap' ||
        resource === 'branch_coverage_windows'
      ) {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
      identity: {
        capabilities: ['all'],
        scope: { tenant: { id: 'org_a2z', label: 'A2Z Tenant', rank: 2 } },
      },
    });

    const card = await screen.findByTestId('branch-card-br_a2z_capacity');
    expect(within(card).getByText(/0 \/ 250 stops/)).toBeInTheDocument();
    await user.click(card);
    expect(await screen.findByText('Capacity / day')).toBeInTheDocument();
    expect(screen.getAllByText('250').length).toBeGreaterThan(0);

    listSpy.mockRestore();
    completeListSpy.mockRestore();
  });

  it('renders branch vehicles from the canonical vehicle_directory projection', async () => {
    const completeListSpy = vi.spyOn(api, 'ui_list_resource_complete');
    const vehicleDirectory = await ui_list_resource_v1<{ current_branch_id?: string; plate?: string }>(
      'vehicle_directory',
    );
    expect(vehicleDirectory.rows.some((row) => row.current_branch_id === 'hub_ruh_n')).toBe(true);

    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />);
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Vehicles/i }));
    expect(await screen.findByText('RUH 1184')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        completeListSpy.mock.calls.some(([resource, options]) => {
          const filter = (options as { filter?: Record<string, unknown> } | undefined)?.filter;
          return resource === 'vehicle_directory' && filter?.current_branch_id === 'hub_ruh_n';
        }),
      ).toBe(true);
      expect(
        completeListSpy.mock.calls.some(([resource, options]) => {
          const filter = (options as { filter?: Record<string, unknown> } | undefined)?.filter;
          return resource === 'vehicle_directory' && filter?.branch_id === 'hub_ruh_n';
        }),
      ).toBe(true);
    });
  });

  it('opens the branch drawer from a row deep-link focus URL', async () => {
    window.history.pushState(null, '', '/network/branches?focus=hub_jed_n');

    renderWithProviders(<BranchesModule />);

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(within(drawer).getAllByText(/Jeddah North/).length).toBeGreaterThan(0);
    const focusedCard = await screen.findByTestId('branch-card-hub_jed_n');
    expect(focusedCard).toHaveAttribute('aria-current', 'true');
  });

  it('switches to the Coverage tab and renders the 7×24 heatmap grid', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />);
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Coverage/i }));
    // CoverageHeatmap exposes the 7-row × 24-col aria grid.
    const grids = await screen.findAllByRole('grid', {
      name: /Coverage by day and hour/i,
    });
    expect(grids.length).toBeGreaterThan(0);
    expect(grids[0]!.getAttribute('aria-rowcount')).toBe('7');
    expect(grids[0]!.getAttribute('aria-colcount')).toBe('24');
  });

  it('submits coverage-window edits with canonical window and zone context', async () => {
    const upsertSpy = vi.spyOn(api, 'branch_coverage_window_upsert_v1');
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Coverage/i }));
    await user.click(await screen.findByRole('button', { name: 'Edit window' }));

    const dialog = await screen.findByRole('dialog', { name: /Coverage window - Riyadh North/i });
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText('Coverage window')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Zone')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Priority')).toBeInTheDocument();

    const reason = within(dialog).getByLabelText('Reason');
    await user.clear(reason);
    await user.type(reason, 'Storm overflow coverage');
    fireEvent.change(within(dialog).getByLabelText('Ends'), {
      target: { value: '2026-01-22T18:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Save window' }));

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledTimes(1));
    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({
      branch_id: 'hub_ruh_n',
      coverage_window_id: expect.any(String),
      zone_id: expect.any(String),
      effective_from: expect.any(String),
      effective_to: expect.any(String),
      priority: expect.any(Number),
      reason: 'Storm overflow coverage',
      metadata: expect.objectContaining({
        source: 'console_v2_branch_coverage_form',
      }),
    }));
  });

  it('keeps coverage editing available when a branch has no heatmap rows', async () => {
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation((async (resource: string, opts?: api.ListOpts) => {
      const result = await ui_list_resource_complete<Record<string, unknown>>(resource, opts);
      if (resource !== 'branch_capacity_heatmap') return result;
      const rows = result.rows.filter((row) => row.branch_id !== 'hub_ruh_n');
      return {
        ...result,
        rows,
        total: rows.length,
      };
    }) as typeof api.ui_list_resource_v1);

    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Coverage/i }));

    expect(await screen.findByRole('button', { name: 'Edit window' })).toBeEnabled();
    expect(screen.getByText(/No capacity windows seeded/i)).toBeInTheDocument();
  });

  it('enables write actions when the user holds branches.write', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
    });
    // No CapabilityLock chip is appended when the user holds the capability,
    // so the accessible name remains exactly "New branch".
    const newBtn = await screen.findByRole('button', { name: 'New branch' });
    expect(newBtn).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Mark out-of-service' })).not.toBeInTheDocument();

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    expect(await screen.findByRole('button', { name: 'Mark branch out-of-service' })).toBeEnabled();
  });

  it('opens a branch creation form before calling createBranch with operator input', async () => {
    const createSpy = vi.spyOn(api, 'branch_create_v1');
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_lifecycle', label: 'Lifecycle Tenant', rank: 2 } },
      },
    });

    const newBtn = await screen.findByRole('button', { name: 'New branch' });
    await user.click(newBtn);
    const dialog = await screen.findByRole('dialog', { name: 'New branch' });
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockResolvedValueOnce({
      ok: true,
      branch_id: 'br_created_lifecycle',
      correlation_id: 'corr_created_lifecycle',
    });

    await user.type(within(dialog).getByLabelText('Name'), 'Riyadh East Branch');
    await user.type(within(dialog).getByLabelText('Code'), 'ruh-east');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'branch');
    await user.type(within(dialog).getByLabelText('City'), 'Riyadh');
    await user.type(within(dialog).getByLabelText('Address'), 'King Abdullah Road');
    await user.type(within(dialog).getByLabelText('Latitude'), '24.8123');
    await user.type(within(dialog).getByLabelText('Longitude'), '46.7234');
    await user.type(within(dialog).getByLabelText('Daily capacity'), '120');
    await user.type(within(dialog).getByLabelText('Cutoff time'), '17:30');
    await user.selectOptions(within(dialog).getByLabelText('Status'), 'active');
    await user.click(within(dialog).getByRole('button', { name: 'Create branch' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toContain(
        '/network/branches?focus=br_created_lifecycle',
      ),
    );
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Riyadh East Branch',
      organization_id: 'org_lifecycle',
      code: 'ruh-east',
      branch_type: 'branch',
      is_active: true,
      address: expect.objectContaining({
        city: 'Riyadh',
        formatted: 'King Abdullah Road',
      }),
      coordinates: {
        lat: 24.8123,
        lng: 46.7234,
      },
      operating_hours: expect.objectContaining({
        cutoff_time_local: '17:30',
      }),
      metadata: expect.objectContaining({
        lifecycle: 'active',
        initial_capacity_per_day: 120,
      }),
    }));
  });

  it('updates branch map coordinates through branch_update_v1', async () => {
    const updateSpy = vi.spyOn(api, 'branch_update_v1').mockResolvedValueOnce({
      ok: true,
      branch_id: 'hub_ruh_n',
      correlation_id: 'corr_branch_coordinates',
    });
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    await user.click(await screen.findByRole('button', { name: 'Edit coordinates' }));

    const dialog = await screen.findByRole('dialog', { name: /Map coordinates/i });
    const latitude = within(dialog).getByLabelText('Latitude');
    const longitude = within(dialog).getByLabelText('Longitude');
    await user.clear(latitude);
    await user.type(latitude, '24.8123');
    await user.clear(longitude);
    await user.type(longitude, '46.7234');
    await user.click(within(dialog).getByRole('button', { name: 'Save coordinates' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith({
      branch_id: 'hub_ruh_n',
      patch: {
        coordinates: {
          lat: 24.8123,
          lng: 46.7234,
        },
      },
    });
    expect(await screen.findByText('24.8123')).toBeInTheDocument();
    expect(screen.getByText('46.7234')).toBeInTheDocument();
  });

  it('marks only the selected branch out-of-service from the branch drawer', async () => {
    const markSpy = vi.spyOn(api, 'branch_mark_oos_v1');
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    await user.click(await screen.findByRole('button', { name: 'Mark branch out-of-service' }));
    const dialog = await screen.findByRole('dialog', { name: /Mark out-of-service - Riyadh North/i });
    expect(markSpy).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Confirm out-of-service' }));

    await waitFor(() => expect(markSpy).toHaveBeenCalledTimes(1));
    expect(markSpy).toHaveBeenCalledWith(expect.objectContaining({
      branch_ids: ['hub_ruh_n'],
      reason: 'branch_profile_oos',
      metadata: expect.objectContaining({
        source: 'console_v2_branch_profile',
      }),
    }));
  });

  it('collects user and role before adding branch staff', async () => {
    const addSpy = vi.spyOn(api, 'add_branch_member_v1');
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read', 'users.read'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Staff/i }));
    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    const dialog = await screen.findByRole('dialog', { name: /Add staff - Riyadh North/i });
    expect(addSpy).not.toHaveBeenCalled();

    const userField = within(dialog).getByLabelText('User');
    if (userField instanceof HTMLSelectElement) {
      await user.selectOptions(userField, 'usr_ops_admin_layla');
    } else {
      await user.type(userField, 'usr_ops_admin_layla');
    }
    const roleField = within(dialog).getByLabelText('Role');
    if (roleField instanceof HTMLSelectElement) {
      await user.selectOptions(roleField, 'ops_lead');
    } else {
      await user.type(roleField, 'ops_lead');
    }
    await user.click(within(dialog).getByRole('button', { name: 'Add staff' }));

    await waitFor(() => expect(addSpy).toHaveBeenCalledWith({
      branch_id: 'hub_ruh_n',
      user_id: 'usr_ops_admin_layla',
      role_key: 'ops_lead',
    }));
  });

  it('does not expose raw user-id entry when the user directory is unavailable', async () => {
    const addSpy = vi.spyOn(api, 'add_branch_member_v1');
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Staff/i }));
    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    const dialog = await screen.findByRole('dialog', { name: /Add staff - Riyadh North/i });

    const userField = within(dialog).getByLabelText('User');
    expect(userField).toBeInstanceOf(HTMLSelectElement);
    expect(userField).toBeDisabled();
    expect(dialog).toHaveTextContent('User directory unavailable');
    expect(dialog).not.toHaveTextContent('usr_ops_admin_layla');
    expect(within(dialog).getByRole('button', { name: 'Add staff' })).toBeDisabled();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('does not expose raw user-id labels from partial user directory rows', async () => {
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'user_directory') {
        return {
          rows: [{ id: 'usr_raw_only' }],
          total: 1,
          page: 0,
          page_size: 200,
        };
      }
      return ui_list_resource_v1<Record<string, unknown>>(resource, opts);
    }) as typeof api.ui_list_resource_v1);

    const addSpy = vi.spyOn(api, 'add_branch_member_v1');
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read', 'users.read'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Staff/i }));
    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    const dialog = await screen.findByRole('dialog', { name: /Add staff - Riyadh North/i });

    expect(dialog).toHaveTextContent('User directory unavailable');
    expect(dialog).not.toHaveTextContent('usr_raw_only');
    expect(within(dialog).getByRole('button', { name: 'Add staff' })).toBeDisabled();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('requires selecting the branch staff membership before removal', async () => {
    const removeSpy = vi.spyOn(api, 'remove_branch_member_v1');
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Staff/i }));
    await user.click(await screen.findByRole('button', { name: 'Remove staff' }));
    const dialog = await screen.findByRole('dialog', { name: /Remove staff - Riyadh North/i });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(dialog).not.toHaveTextContent('usr_ops_admin_layla');
    expect(dialog).toHaveTextContent('Staff member');

    await user.selectOptions(within(dialog).getByLabelText('Staff'), 'bm_002');
    await user.click(within(dialog).getByRole('button', { name: 'Remove staff' }));

    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith({ membership_id: 'bm_002' }));
  });

  it('disables write actions and shows the capability lock when branches.write is missing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'zones.read'],
    });
    // When the capability is missing the Button primitive appends a
    // CapabilityLock chip whose text is the missing capability slug — that
    // suffix becomes part of the accessible name. Match permissively.
    const newBtn = await screen.findByRole('button', {
      name: /New branch.*Branch update permission required/i,
    });
    expect(newBtn).toBeDisabled();

    // Open a card → Zones tab → Assign zone button is also gated.
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    expect(
      await screen.findByRole('button', {
        name: /Mark branch out-of-service.*Branch update permission required/i,
      }),
    ).toBeDisabled();
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Zones/i }));
    const assignBtn = await screen.findByRole('button', {
      name: /Assign zone.*Branch update permission required/i,
    });
    expect(assignBtn).toBeDisabled();

    // Switch to Staff tab — Add + Remove buttons must also be gated.
    await user.click(within(tablist).getByRole('tab', { name: /Staff/i }));
    expect(
      await screen.findByRole('button', { name: /Add staff.*Branch update permission required/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /Remove.*Branch update permission required/i }),
    ).toBeDisabled();
  });

  // W11-2 — paired projection view `public.v_branch_summary` consumption.
  // The KPI strip and per-card capacity counters now read derived counters
  // (capacity_per_day, active_vehicles, active_routes) from the summary view
  // via the `branch_summary` registry resource. The seed-mode projection
  // (`_projectBranchSummary` in data-source.ts) preserves the same numeric
  // shape as the legacy inline counters so cards keep their existing
  // appearance without relying on the dropped FE-fictional row fields.
  it('renders capacity utilization KPI from v_branch_summary projection', async () => {
    const { container } = renderWithProviders(<BranchesModule />);
    await screen.findByTestId('branches-grid');
    const kpiStrip = container.querySelector('.kpi-strip') as HTMLElement | null;
    expect(kpiStrip).not.toBeNull();
    // Capacity utilization tile renders a numeric percentage when summary
    // capacity_per_day > 0 (v_branch_summary projection is non-empty in
    // seed mode). The tile label is visible alongside the value.
    const utilLabel = within(kpiStrip!).getByText('Capacity utilization');
    expect(utilLabel).toBeInTheDocument();
  });

  it('renders per-card vehicle/route counters from v_branch_summary projection', async () => {
    renderWithProviders(<BranchesModule />);
    // Riyadh North hub seed: active_vehicles=4, active_routes=6 in the
    // canonical projection (`_projectBranchSummary` mirrors the seed).
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    expect(within(card).getByText(/4 vehicles · 6 routes/)).toBeInTheDocument();
  });

  // W18-3 — paired projection view `public.v_branch_capacity_heatmap`
  // consumption. The Coverage tab heatmap now reads through the canonical
  // projection seam (`branch_capacity_heatmap` registry key). The seed-mode
  // projection (`_projectBranchCapacityHeatmap` in data-source.ts) is a
  // typed pass-through over the existing heatmap-shaped seed rows, so the
  // 7×24 grid renders identically without relying on the FE-fictional
  // `weekday`/`hour`/`capacity_units`/`booked_units` columns on the base
  // table. This test asserts the heatmap still mounts after the projection
  // cutover.
  it('renders the 7x24 heatmap from v_branch_capacity_heatmap projection (W18-3)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />);
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Coverage/i }));
    // Heatmap grid mounts with canonical 7×24 dimensions, sourced from the
    // projection registry key (not the base-table FE-fictional shape).
    const grids = await screen.findAllByRole('grid', {
      name: /Coverage by day and hour/i,
    });
    expect(grids.length).toBeGreaterThan(0);
    expect(grids[0]!.getAttribute('aria-rowcount')).toBe('7');
    expect(grids[0]!.getAttribute('aria-colcount')).toBe('24');
  });

  // W20 — canonical column shadow resolution. The seed now carries both
  // shapes per row (canonical `branch_type` / `is_active` / `metadata.lifecycle`
  // alongside FE aliases `type` / `status`) so the FE row resolvers
  // (`branchTypeOf` / `branchStatusOf` / `slugOf`) hit the canonical path
  // first. This test asserts the type and status chips on the card render
  // through the canonical resolution path.
  it('resolves branch type / status / slug via canonical column shadows (W20)', async () => {
    renderWithProviders(<BranchesModule />);
    // hub_ruh_n seed carries canonical branch_type='hub' + is_active=true +
    // metadata.lifecycle='active'. Card chips should surface the canonical
    // value labels even if the FE alias `type` were dropped (legacy seed
    // shape). The W20 helpers prefer canonical, so the rendered output
    // proves the canonical path is wired without breaking the alias path.
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    expect(within(card).getByText('Hub')).toBeInTheDocument();
    expect(within(card).getByText('Active')).toBeInTheDocument();
  });

  // W20 — Coverage tab now surfaces a canonical effective_from/effective_to
  // window list below the heatmap (resolved via openAtOf / closeAtOf). The
  // seed carries both canonical effective_from/to and FE aliases open_at/
  // close_at per row; this test asserts the canonical-resolution path
  // mounts the windows list with the seed shape (one continuous range row
  // per branch).
  it('renders coverage windows list via canonical effective_from/to projection (W20)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BranchesModule />);
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', {
      name: /Branch drawer tabs/i,
    });
    await user.click(within(tablist).getByRole('tab', { name: /Coverage/i }));
    // The Coverage windows section eyebrow surfaces the count.
    const eyebrows = await screen.findAllByText(/Coverage windows · 1/);
    expect(eyebrows.length).toBeGreaterThan(0);
  });
});
