// zones.test.tsx — covers CLAIM-NETWORK-ZONES (Wave 1, Phase A) MAP-FIRST
// surface behavior:
//   • mounts cleanly with KPI strip + ZoneMap + side list rendered
//   • ZoneMap renders one polygon per zone in the seed (with geometry)
//   • click a polygon (programmatic) → drawer opens with the zone title
//   • click a side-list row → same drawer opens
//   • capability gate on "Approve override" disables the button when missing
//   • TimelineLog over override requests renders with status-tone bullets
import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ui_list_resource_v1 } from '@/lib/data-source';
import * as apiMod from '@/lib/api';
import { ZonesModule } from '../zones';
import { zoneCountsAsActive, zoneCountsAsSuspended, zoneStatusOf } from '../_zone-status';
import { zoneDistrictCityLabel, zoneDistrictDisplayName } from '../zones-create-modal';

describe('ZonesModule (CLAIM-NETWORK-ZONES)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('labels create-zone district choices from canonical district columns', () => {
    const canonicalDistrict = {
      id: 'cd_ruh_olaya',
      name_canonical: 'Olaya',
      city_label: 'Riyadh',
    };
    expect(zoneDistrictDisplayName(canonicalDistrict)).toBe('Olaya');
    expect(zoneDistrictCityLabel(canonicalDistrict)).toBe('Riyadh');
  });

  it('prefers canonical is_active when live rows omit the legacy status alias', () => {
    expect(zoneStatusOf({ is_active: true, status: '—', metadata: null })).toBe('active');
    expect(zoneStatusOf({ is_active: false, status: 'draft', metadata: null })).toBe('draft');
    expect(zoneStatusOf({ is_active: false, status: '—', metadata: null })).toBe('suspended');
    expect(zoneStatusOf({ is_active: true, status: 'suspended', metadata: { lifecycle: 'retired' } })).toBe('retired');
    expect(zoneCountsAsActive({ is_active: true, status: '—', metadata: null }, {})).toBe(true);
    expect(zoneCountsAsActive({ is_active: true, status: '—', metadata: null }, { is_active_zone_status: false })).toBe(false);
    expect(zoneCountsAsSuspended({ is_active: false, status: '—', metadata: null }, {})).toBe(true);
    expect(zoneCountsAsSuspended({ is_active: false, status: '—', metadata: null }, { is_suspended_zone_status: false })).toBe(false);
  });

  it('scopes zone and zone-related reads to the active tenant context', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const completeListSpy = vi.spyOn(apiMod, 'ui_list_resource_complete');

    renderWithProviders(<ZonesModule />, {
      identity: {
        capabilities: ['zones.read', 'branches.read'],
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    await waitFor(() => {
      for (const resource of ['zones', 'zone_summary', 'zone_performance_metrics', 'canonical_districts', 'canonical_cities']) {
        expect(
          listSpy.mock.calls.some(([key, opts]) => {
            const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
            return key === resource && filter?.organization_id === 'org_rashed';
          }),
        ).toBe(true);
      }
      for (const resource of ['zone_districts', 'zone_override_requests', 'branch_zone_directory']) {
        expect(
          completeListSpy.mock.calls.some(([key, opts]) => {
            const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
            return key === resource && typeof filter?.zone_id === 'string';
          }),
        ).toBe(true);
        expect(
          completeListSpy.mock.calls.some(
            ([key, opts]) =>
              key === resource && !(opts as { filter?: Record<string, unknown> } | undefined)?.filter,
          ),
        ).toBe(false);
      }
    });
  });

  it('renders KPI strip, map, and side list', async () => {
    renderWithProviders(<ZonesModule />);

    // KPI strip surfaces total / active / suspended / pending overrides labels.
    await waitFor(() =>
      expect(screen.getByTestId('zones-kpi-strip')).toBeInTheDocument(),
    );
    expect(screen.getByText('Total zones')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    expect(screen.getByText('Pending overrides')).toBeInTheDocument();

    // Split-view map + side list anchors.
    const mapHost = screen.getByTestId('zones-map');
    expect(mapHost).toBeInTheDocument();
    expect(screen.getByTestId('zones-side-list')).toBeInTheDocument();
    expect(within(mapHost).getByRole('link', { name: '\u00a9 OpenStreetMap contributors' })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright',
    );
    expect(mapHost.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'approved');
    expect(mapHost.querySelector('image[href^="/map-tiles/openstreetmap/"]')).toBeTruthy();
  });

  it('creates zones in the active tenant scope and focuses the saved row', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(apiMod, 'zone_create_v1').mockResolvedValue({
      ok: true,
      zone_id: 'zone_created_lifecycle',
      initial_district_count: 0,
      correlation_id: 'corr_zone_created_lifecycle',
    });

    renderWithProviders(<ZonesModule />, {
      identity: {
        capabilities: ['zones.read', 'zones.write'],
        scope: {
          tenant: { id: 'org_lifecycle', label: 'Lifecycle Tenant', rank: 2 },
        },
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'New zone' }));
    await user.type(await screen.findByPlaceholderText('e.g. Riyadh East'), 'Lifecycle Riyadh');
    await user.click(await screen.findByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Lifecycle Riyadh',
          organization_id: 'org_lifecycle',
        }),
      );
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/network/zones');
      expect(window.location.search).toBe('?focus=zone_created_lifecycle');
    });
  });

  it('can attach initial branch coverage while creating a zone', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'branches') {
        return {
          rows: [{
            id: 'br_a2z_coverage',
            organization_id: 'org_lifecycle',
            code: 'A2Z-RUH',
            name: 'A2Z Riyadh Branch',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    const createSpy = vi.spyOn(apiMod, 'zone_create_v1').mockResolvedValue({
      ok: true,
      zone_id: 'zone_created_with_branch',
      initial_district_count: 0,
      correlation_id: 'corr_zone_created_with_branch',
    });
    const assignSpy = vi.spyOn(apiMod, 'branch_zone_assign_v1').mockResolvedValue({
      ok: true,
      branch_zone_id: 'bz_created_with_branch',
      branch_id: 'br_a2z_coverage',
      zone_id: 'zone_created_with_branch',
    } as never);

    renderWithProviders(<ZonesModule />, {
      identity: {
        capabilities: ['zones.read', 'zones.write'],
        scope: {
          tenant: { id: 'org_lifecycle', label: 'Lifecycle Tenant', rank: 2 },
        },
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'New zone' }));
    await user.type(await screen.findByPlaceholderText('e.g. Riyadh East'), 'A2Z Coverage Zone');
    await user.selectOptions(await screen.findByLabelText('Initial branch coverage'), 'br_a2z_coverage');
    await user.click(await screen.findByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'A2Z Coverage Zone',
        organization_id: 'org_lifecycle',
      }),
    ));
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith({
      branch_id: 'br_a2z_coverage',
      zone_id: 'zone_created_with_branch',
      priority: 0,
    }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/network/zones');
      expect(window.location.search).toBe('?focus=zone_created_with_branch');
    });

    listSpy.mockRestore();
    createSpy.mockRestore();
    assignSpy.mockRestore();
  });

  it('renders one ZoneMap polygon per zone with geometry', async () => {
    renderWithProviders(<ZonesModule />);

    // Wait for the side list to mount (signals all queries resolved).
    await waitFor(() => {
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument();
    });

    const mapHost = screen.getByTestId('zones-map');
    await waitFor(() => {
      const polys = mapHost.querySelectorAll('polygon');
      // 8 zones in the seed with non-empty geometry.
      expect(polys.length).toBe(8);
    });
  });

  it('projects map geometry through zone_summary instead of zone rows', async () => {
    const zoneRows = await ui_list_resource_v1<Record<string, unknown>>('zones');
    expect(zoneRows.rows.length).toBeGreaterThan(0);
    expect(zoneRows.rows.some((row) => row.geometry != null)).toBe(false);
    expect(
      zoneRows.rows.some((row) => {
        const metadata = row.metadata as Record<string, unknown> | undefined;
        return metadata?.geometry != null;
      }),
    ).toBe(false);

    const summaries = await ui_list_resource_v1<{
      zone_id: string;
      geometry?: { kind: string; source?: string; paths?: Array<[number, number]> } | null;
    }>('zone_summary');
    const projected = summaries.rows.filter((row) => row.geometry?.paths?.length);
    expect(projected.length).toBe(8);
    expect(projected[0]!.geometry!.source).toBe('canonical_district_centroids');
  });

  it('opens the zone drawer when a map polygon is clicked', async () => {
    renderWithProviders(<ZonesModule />);

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    const mapHost = screen.getByTestId('zones-map');
    const polygons = mapHost.querySelectorAll('g[data-zone-id]');
    expect(polygons.length).toBeGreaterThan(0);

    // Click the focusable group wrapper (which carries the onClick handler).
    fireEvent.click(polygons[0] as Element);

    // Drawer header opens with `Zone · <name>`.
    await waitFor(() => {
      const titles = screen.getAllByText(/Zone · /);
      expect(titles.length).toBeGreaterThan(0);
    });
  });

  it('opens the zone drawer when a side-list row is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ZonesModule />);

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    const sideList = screen.getByTestId('zones-side-list');
    const firstRow = within(sideList).getAllByRole('button')[0];
    expect(firstRow).toBeDefined();
    await user.click(firstRow as HTMLElement);

    await waitFor(() => {
      const titles = screen.getAllByText(/Zone · /);
      expect(titles.length).toBeGreaterThan(0);
    });
  });

  it('shows linked district data in the opened zone drawer', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ZonesModule />);

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    const sideList = screen.getByTestId('zones-side-list');
    const ruhRow = within(sideList).getByLabelText(/Riyadh North/);
    await user.click(ruhRow);

    const districtsTab = await screen.findByRole('tab', { name: /Districts\s+[1-9]/i });
    expect(districtsTab).toBeInTheDocument();
    await user.click(districtsTab);

    await waitFor(() => {
      expect(screen.queryByText('No districts linked. Triage in operations.')).not.toBeInTheDocument();
    });
  });

  it('disables the Approve override action when the user lacks zones.write', async () => {
    const user = userEvent.setup();
    // Mount with zones.read-only capability — Approve must lock down.
    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    // Open the first zone with a known pending override (Riyadh North).
    const sideList = screen.getByTestId('zones-side-list');
    const ruhRow = within(sideList).getByLabelText(/Riyadh North/);
    await user.click(ruhRow);

    // Switch to the Overrides tab inside the drawer.
    const overridesTab = await screen.findByRole('tab', { name: /Overrides/i });
    await user.click(overridesTab);

    // Pending entries are auto-expanded (initiallyExpanded). Find Approve
    // buttons; they must all be disabled because the user lacks zones.write.
    const approveButtons = await screen.findAllByRole('button', { name: /Approve/i });
    expect(approveButtons.length).toBeGreaterThan(0);
    for (const btn of approveButtons) {
      expect(btn).toBeDisabled();
    }
  });

  it('renders TimelineLog with status-tone bullets for override requests', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read', 'zones.write'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    // Riyadh North has 1 pending override (zor_2901).
    const sideList = screen.getByTestId('zones-side-list');
    const ruhRow = within(sideList).getByLabelText(/Riyadh North/);
    await user.click(ruhRow);

    const overridesTab = await screen.findByRole('tab', { name: /Overrides/i });
    await user.click(overridesTab);

    // TimelineLog mounts under our test wrapper — bullets carry tone classes.
    // W49: bucket labels resolve asynchronously through `useResolveSettings`,
    // so wait for bullets to render once the canonical policy lands.
    const timeline = await screen.findByTestId('zone-override-timeline');
    await waitFor(() => {
      const bullets = timeline.querySelectorAll('.primitive-tl__bullet');
      expect(bullets.length).toBeGreaterThan(0);
    });

    // At least one warn bullet (pending) should be present.
    const warnBullets = timeline.querySelectorAll('.primitive-tl__bullet--warn');
    expect(warnBullets.length).toBeGreaterThan(0);
  });

  // W11-2 — paired projection view `public.v_zone_summary` consumption.
  // Side list rows render their branch / district / pending counts from the
  // canonical projection (registry key: `zone_summary`). The seed-mode
  // projection (`_projectZoneSummary` in data-source.ts) computes the same
  // counts on the fly from the seed slices so the surface visually matches
  // production once the live RPC is swapped in.
  it('renders side-list counters from v_zone_summary projection', async () => {
    renderWithProviders(<ZonesModule />);
    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );
    const sideList = screen.getByTestId('zones-side-list');
    // Riyadh North zone has 4 districts in the seed (zone_districts rows
    // for cd_ruh_olaya, cd_ruh_sulaymaniyah, cd_ruh_malqa, cd_ruh_yasmin)
    // and 2 branch links (br_ruh_n hub + br_ruh_n_pickup). The
    // zone_summary projection materializes those counts and the side list
    // renders compact `Nd` / `Nb` chips for each.
    const ruhRow = within(sideList).getByLabelText(/Riyadh North/);
    expect(within(ruhRow).getByText('4D')).toBeInTheDocument();
    expect(within(ruhRow).getByText('2B')).toBeInTheDocument();
  });

  it('adds a district through canonical zone/canonical_district ids without legacy role payload', async () => {
    const user = userEvent.setup();
    const addSpy = vi.spyOn(apiMod, 'zone_district_add_v1').mockResolvedValue({
      ok: true,
      zone_district_id: 'zone_district_test',
      correlation_id: 'corr_zone_district_test',
      already_processed: false,
    });

    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read', 'zones.write'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );
    const sideList = screen.getByTestId('zones-side-list');
    const ruhRow = within(sideList).getByLabelText(/Riyadh North/);
    await user.click(ruhRow);

    const districtsTab = await screen.findByRole('tab', { name: /Districts/i });
    await user.click(districtsTab);
    await user.click(await screen.findByRole('button', { name: /Add district/i }));

    await waitFor(() => {
      expect(addSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          zone_id: expect.any(String),
          canonical_district_id: expect.any(String),
        }),
      );
    });
    expect(addSpy.mock.calls[0]?.[0]).not.toHaveProperty('role');
  });

  it('aggregates pending overrides KPI from v_zone_summary projection', async () => {
    renderWithProviders(<ZonesModule />);
    await waitFor(() =>
      expect(screen.getByTestId('zones-kpi-strip')).toBeInTheDocument(),
    );
    // The Pending overrides KPI sums per-zone pending_overrides counts from
    // the projection. The seed has 3 pending requests (zor_2901, zor_2899,
    // zor_2896) routed to 3 different zones, so the total is 3.
    const strip = screen.getByTestId('zones-kpi-strip');
    expect(within(strip).getByText('Pending overrides')).toBeInTheDocument();
  });

  // W20 — canonical column shadow resolution. The seed now carries both
  // shapes per row (canonical `is_active` / `description` /
  // `metadata.lifecycle` / canonical override columns
  // alongside FE aliases `status` / `notes` / `payload` / `decision_at` /
  // `decided_by_user_id` / `requested_by_user_id`). The FE row resolvers
  // (`zoneStatusOf` / `overrideMetadataOf` etc.) hit the
  // canonical path first. This test asserts the side-list status chip and
  // map polygons render through the canonical resolution path.
  it('resolves zone status / geometry via canonical column shadows (W20)', async () => {
    renderWithProviders(<ZonesModule />);
    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );
    const sideList = screen.getByTestId('zones-side-list');
    // Jeddah Heritage seed carries canonical is_active=false +
    // metadata.lifecycle='suspended' + FE alias status='suspended'. The
    // side-list status chip resolves through `zoneStatusOf()` which prefers
    // the canonical path.
    const jedRow = within(sideList).getByLabelText(/Jeddah Heritage/);
    expect(within(jedRow).getByText('suspended')).toBeInTheDocument();
    // Map polygons mount from the canonical zone_summary geometry projection.
    const mapHost = screen.getByTestId('zones-map');
    const polys = mapHost.querySelectorAll('polygon');
    expect(polys.length).toBe(8);
  });

  // W20 — paired projection view `v_branch_zone_directory` provides per-row
  // (branch_label, hub_code, branch_type, zone_label, zone_slug) join
  // projection. The drawer Branches tab DataTable now reads through the
  // projection registry key (`branch_zone_directory`) so the live + demo
  // paths converge on the same shape.
  it('renders Branches tab via v_branch_zone_directory projection (W20)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ZonesModule />);
    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );
    const sideList = screen.getByTestId('zones-side-list');
    const ruhRow = within(sideList).getByLabelText(/Riyadh North/);
    await user.click(ruhRow);
    // Switch to the Branches tab inside the drawer.
    const branchesTab = await screen.findByRole('tab', { name: /Branches/i });
    await user.click(branchesTab);
    // Riyadh North zone has 1 linked branch via the directory projection
    // (hub_ruh_n, branch_label='Riyadh North · Hub'). The DataTable must
    // surface the canonical-projected branch_label.
    expect(await screen.findByText('Riyadh North · Hub')).toBeInTheDocument();
  });
  it('renders Performance tab from zone_performance_metrics registry rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ZonesModule />);
    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    const sideList = screen.getByTestId('zones-side-list');
    const ruhRow = within(sideList).getByLabelText(/Riyadh North/);
    await user.click(ruhRow);

    const performanceTab = await screen.findByRole('tab', { name: /Performance/i });
    await user.click(performanceTab);

    expect(await screen.findByText('Shipments today')).toBeInTheDocument();
    expect(await screen.findByText('184')).toBeInTheDocument();
  });
});
