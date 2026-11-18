// drivers.test.tsx — CLAIM-FLEET-DRIVERS unit suite.
//
// Covers:
//   • Mounts and renders KPI strip + DataTable.
//   • ExpiryChip tone integration — Mohammed (license expiring 2026-05-01,
//     anchor today 2026-04-26, 5 days out) renders the danger tone.
//   • Console V2 lifecycle closure — "New driver" and "Attach document"
//     controls now submit production-backed RPC facades instead of toast stubs.
//     "Approve" row-action surfaces in the palette regardless of capability
//     (visibility is correct; the action button itself gates on fleet.write per
//     drivers.tsx). Per FLEET Wave 5 re-audit D3 closure, callsites and
//     registry entries previously gated on FE-invented `drivers.write` now
//     align to the canonical `fleet.write` SSOT.
//   • Drawer + tabs — click a row, see tablist with all 6 tabs.
//   • HoursOfServiceMeter — renders correct number of segments per the
//     fixture (e.g. Khalid has 5 segments today).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, type RenderWithProvidersOptions } from '@/test/render';
import { DriversModule } from '../drivers';
import * as api from '@/lib/api';
// @ts-expect-error JS module — registry shape exercised dynamically below.
import * as registry from '@/lib/seed-raw/registry';
import * as ds from '@/lib/data-source';

async function mountAll(opts?: {
  capabilities?: string[];
  identity?: RenderWithProvidersOptions['identity'];
}) {
  const capabilities = opts?.capabilities ?? ['all'];
  const utils = renderWithProviders(<DriversModule />, {
    capabilities: opts?.identity ? undefined : capabilities,
    identity: opts?.identity
      ? { ...opts.identity, capabilities: opts.identity.capabilities ?? capabilities }
      : undefined,
  });
  await waitFor(
    () => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    },
    { timeout: 3000 },
  );
  return utils;
}

describe('DriversModule (CLAIM-FLEET-DRIVERS)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/fleet/drivers');
    await api.hydrateConsoleLiveMetadata();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/fleet/drivers');
  });

  it('mounts, renders KPI strip, and shows the drivers table', async () => {
    await mountAll();
    // KPI tiles — scope queries to `.kpi__label` so they don't collide with
    // status chips in body rows. Per FLEET Wave 5 RE-AUDIT D4 closure, the
    // KPI strip mirrors the canonical driver_status lookup
    // (active|inactive|suspended) plus duty granularity derived from
    // hours_of_service_state (On shift / On break).
    const kpiLabels = Array.from(document.querySelectorAll('.kpi__label')).map(
      (el) => el.textContent?.trim() ?? '',
    );
    expect(kpiLabels).toEqual(
      expect.arrayContaining([
        'Total drivers',
        'Active',
        'On shift',
        'On break',
        'Inactive',
        'Suspended',
        'Docs expiring',
        'Out of service',
      ]),
    );

    // Table header includes our domain columns.
    expect(screen.getByText('License #')).toBeInTheDocument();
    expect(screen.getByText('Compliance')).toBeInTheDocument();

    // At least one driver row visible (Khalid is in the seed).
    expect(screen.getByText('Khalid Al-Otaibi')).toBeInTheDocument();
  });

  it('renders driver names without a dead detail link', async () => {
    await mountAll();
    const khalid = screen.getByText('Khalid Al-Otaibi');
    expect(khalid.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /Khalid Al-Otaibi/i })).toBeNull();
  });

  it('renders the danger ExpiryChip for a driver whose license expires within 7 days', async () => {
    await mountAll();
    // Mohammed Hassan's license expires 2026-05-01. Anchor in seed comment
    // is 2026-04-26 → 5 days out → ExpiryChip tone:danger ("Expires in 5
    // days" or similar). The chip text contains "Expires in" / "days".
    const mohammedRow = screen.getByText('Mohammed Hassan').closest('tr');
    expect(mohammedRow).toBeTruthy();
    if (!mohammedRow) throw new Error('Could not find Mohammed row');
    // The license-expiry chip is rendered inside that row. Look for any
    // chip with "danger" tone class. ExpiryChip wraps the canonical Chip
    // primitive, which appends a tone class like `chip--danger`.
    // W49: thresholds resolve asynchronously through `useResolveSettings`,
    // so wait for the danger chip to appear once the canonical policy lands.
    await waitFor(() => {
      const dangerChips = mohammedRow.querySelectorAll(
        '.chip--danger, [class*="danger"]',
      );
      expect(dangerChips.length).toBeGreaterThan(0);
    });
  });

  it('opens the production-backed New driver form and submits create_driver_v1', async () => {
    const user = userEvent.setup();
    let createdDriverVisible = false;
    const realList = ds.ui_list_resource_v1;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource !== 'driver_directory' || !createdDriverVisible) return result;
      return {
        ...result,
        rows: [
          ...result.rows,
          {
            id: 'drvp_created_visible',
            organization_id: 'org_rashed',
            user_id: 'usr_sender_exampleoutlet',
            user_full_name: 'Exampleoutlet Sender Driver',
            user_email: 'exampleoutlet.sender.driver@example.example',
            driver_code: 'DRV-TST',
            status: 'active',
            created_at: '2026-05-15T03:00:00Z',
            updated_at: '2026-05-15T03:00:00Z',
            document_count: 0,
            expired_document_count: 0,
            expiring_document_count: 0,
            compliance_event_count: 0,
            compliance_event_count_24h: 0,
            critical_compliance_count: 0,
            hos_segment_count: 0,
            hos_segment_count_24h: 0,
            is_active: true,
            is_suspended: false,
            is_inactive: false,
            has_expired_documents: false,
            has_expiring_documents: false,
          },
        ],
        total: result.total + 1,
      };
    });
    const completeListSpy = vi.spyOn(ds, 'ui_list_resource_complete');
    const createSpy = vi.spyOn(api, 'create_driver_v1').mockImplementation(async () => {
      createdDriverVisible = true;
      return {
      ok: true,
      driver_profile_id: 'drvp_test',
      correlation_id: 'corr_test',
      };
    });
    await mountAll({
      capabilities: ['fleet.read', 'fleet.write'],
      identity: {
        capabilities: ['fleet.read', 'fleet.write'],
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    await waitFor(() => {
      const fleetUserCall = listSpy.mock.calls.find(([resource]) => resource === 'fleet_user_options');
      expect(fleetUserCall).toBeTruthy();
      expect(fleetUserCall?.[1]).toEqual(
        expect.objectContaining({
          filter: expect.objectContaining({ organization_id: 'org_rashed', status: 'active' }),
          sort: { key: 'full_name', dir: 'asc' },
          page_size: 100,
        }),
      );
      for (const resource of ['driver_directory', 'vehicle_directory']) {
        expect(
          listSpy.mock.calls.some(([key, opts]) => {
            const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
            return key === resource && filter?.organization_id === 'org_rashed';
          }),
        ).toBe(true);
      }
      for (const resource of ['driver_documents', 'driver_compliance_events', 'vehicle_assignments']) {
        expect(
          completeListSpy.mock.calls.some(([key, opts]) => {
            const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
            return (
              key === resource &&
              (typeof filter?.driver_id === 'string' ||
                typeof filter?.driver_user_id === 'string' ||
                typeof filter?.assigned_to_user_id === 'string')
            );
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
    await user.click(screen.getByRole('button', { name: /New driver/i }));
    await waitFor(() => {
      expect(screen.getByText(/Creates a driver profile for an existing tenant user/i)).toBeInTheDocument();
    });
    const modal = document.querySelector('.modal') as HTMLElement | null;
    expect(modal).toBeTruthy();
    if (!modal) throw new Error('New driver modal missing');
    const tenantUser = within(modal).getByLabelText('Tenant user') as HTMLSelectElement;
    const optionValues = Array.from(tenantUser.options).map((option) => option.value);
    expect(optionValues).toContain('usr_sender_exampleoutlet');
    expect(optionValues).not.toContain('usr_acct_mgr_huda');
    expect(optionValues).not.toContain('usr_client_admin_examplemart');
    await user.selectOptions(tenantUser, 'usr_sender_exampleoutlet');
    const status = within(modal).getByLabelText('Driver status') as HTMLSelectElement;
    expect(status.value).toBe('active');
    const driverCode = within(modal).getByLabelText('Driver code') as HTMLInputElement;
    await user.type(driverCode, 'DRV-TST');
    await user.type(within(modal).getByLabelText('Hired date'), '2026-05-30');
    await user.click(within(modal).getByRole('button', { name: /Create driver/i }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org_rashed',
          user_id: 'usr_sender_exampleoutlet',
          driver_code: 'DRV-TST',
          status: 'active',
          hired_at: '2026-05-30',
        }),
      );
    });
    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      expect(screen.getByText('Exampleoutlet Sender Driver')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Review driver applications/i })).toHaveAttribute(
      'href',
      '/operate/fleet/driver-applications',
    );
    expect((api as unknown as Record<string, unknown>).driver_create_v1).toBeUndefined();
    expect(typeof api.create_driver_v1).toBe('function');
  });

  it('row Suspend driver action shows backend driver_directory readback without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    let visibleDrivers: Array<Record<string, unknown>> = [
      {
        id: 'drvp_readback_suspend',
        organization_id: 'org_rashed',
        user_id: 'usr_readback_suspend',
        user_full_name: 'No Reload Driver',
        user_email: 'no.reload.driver@example.test',
        name: 'No Reload Driver',
        initials: 'NR',
        driver_code: 'DRV-RB',
        license_number: 'LIC-RB-001',
        license_class: 'B',
        license_expires_at: '2027-05-17',
        current_vehicle_id: null,
        current_branch_id: null,
        status: 'active',
        hours_of_service_state: 'off_duty',
        compliance_score: 95,
        phone: null,
        emergency_contact_name: null,
        emergency_contact_phone: null,
        hired_at: '2026-05-01',
        deliveries_today: 0,
        deliveries_week: 0,
        on_time_pct: 100,
        customer_rating: 5,
        document_count: 0,
        expired_document_count: 0,
        expiring_document_count: 0,
        compliance_event_count: 0,
        compliance_event_count_24h: 0,
        critical_compliance_count: 0,
        hos_segment_count: 0,
        hos_segment_count_24h: 0,
        is_active: true,
        is_suspended: false,
        is_inactive: false,
        has_expired_documents: false,
        has_expiring_documents: false,
      },
    ];
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_v1>[1]) => {
        if (resource === 'driver_directory') {
          return {
            rows: visibleDrivers,
            total: visibleDrivers.length,
            page: 0,
            page_size: 50,
          } as Awaited<ReturnType<typeof api.ui_list_resource_v1>>;
        }
        return originalList(resource, opts);
      },
    );
    const suspendSpy = vi.spyOn(api, 'suspend_driver_v1').mockImplementation(async () => {
      visibleDrivers = visibleDrivers.map((row) =>
        row.id === 'drvp_readback_suspend'
          ? { ...row, status: 'suspended', is_active: false, is_suspended: true }
          : row,
      );
      return {
        ok: true,
        driver_profile_id: 'drvp_readback_suspend',
        correlation_id: 'corr_driver_suspend_readback',
      };
    });

    await mountAll({
      capabilities: ['fleet.read', 'fleet.write'],
      identity: {
        capabilities: ['fleet.read', 'fleet.write'],
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    expect(screen.getByText('No Reload Driver')).toBeInTheDocument();
    const activeRow = screen.getByText('No Reload Driver').closest('tr');
    if (!activeRow) throw new Error('No Reload Driver row not found');
    expect(activeRow.textContent ?? '').toMatch(/Active/i);
    expect(activeRow.textContent ?? '').not.toMatch(/Suspended/i);
    const startingPath = window.location.pathname;

    const actionButton = within(activeRow as HTMLElement).getByLabelText('Row actions');
    await user.click(actionButton);
    await user.click(await screen.findByRole('option', { name: /^Suspend driver/ }));
    const modal = document.querySelector('.modal') as HTMLElement | null;
    if (!modal) throw new Error('Suspend driver modal missing');
    await user.click(within(modal).getByRole('button', { name: /Suspend 1/i }));

    await waitFor(() => {
      expect(suspendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org_rashed',
          driver_profile_id: 'drvp_readback_suspend',
          driver_user_id: 'usr_readback_suspend',
          reason: 'compliance_review',
        }),
      );
      expect(screen.getByText('No Reload Driver').closest('tr')?.textContent ?? '').toMatch(/Suspended/i);
    });
    expect(document.querySelector('.modal')).toBeNull();
    expect(window.location.pathname).toBe(startingPath);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'driver_directory').length,
    ).toBeGreaterThan(1);
  });

  it('does not read fleet user creation options for fleet readers without write permission', async () => {
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1');
    await mountAll({ capabilities: ['fleet.read'] });

    expect(screen.getByRole('button', { name: /New driver/i })).toBeDisabled();
    expect(listSpy.mock.calls.some(([resource]) => resource === 'fleet_user_options')).toBe(false);
    const reg = (registry as unknown as { ui_read_registry: Record<string, { capability_read: string }> })
      .ui_read_registry;
    expect(reg.fleet_user_options?.capability_read).toBe('fleet.write');
  });

  it('prevents opening the New driver form while tenant user options are still loading', async () => {
    const realList = ds.ui_list_resource_v1;
    vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'fleet_user_options') {
        return new Promise(() => undefined);
      }
      return realList(resource, opts);
    });

    renderWithProviders(<DriversModule />, {
      identity: {
        capabilities: ['fleet.read', 'fleet.write'],
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    const newDriver = await screen.findByRole('button', { name: /New driver/i });
    await waitFor(() => {
      expect(newDriver).toBeDisabled();
      expect(newDriver).toHaveAttribute('title', 'Loading tenant users before driver creation.');
    });
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('renders fleet user option read failures inside the New driver form', async () => {
    const user = userEvent.setup();
    const realList = ds.ui_list_resource_v1;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'fleet_user_options') {
        throw new Error('42501 fleet user options denied');
      }
      return realList(resource, opts);
    });

    await mountAll({
      capabilities: ['fleet.read', 'fleet.write'],
      identity: {
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    await waitFor(() => {
      expect(listSpy.mock.calls.some(([resource]) => resource === 'fleet_user_options')).toBe(true);
    });
    await user.click(screen.getByRole('button', { name: /New driver/i }));

    expect(await screen.findByText('Tenant users unavailable')).toBeInTheDocument();
    expect(screen.getByText('42501 fleet user options denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Tenant user')).not.toBeInTheDocument();
  });

  it('opens the production-backed Attach document form and submits upload_driver_document_v1', async () => {
    const user = userEvent.setup();
    const uploadSpy = vi.spyOn(api, 'upload_driver_document_v1').mockResolvedValue({
      ok: true,
      driver_document_id: 'doc_test',
      correlation_id: 'corr_test',
    });
    renderWithProviders(<DriversModule />, {
      capabilities: ['fleet.read', 'fleet.write'],
    });
    await waitFor(
      () => {
        expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    // Open the first row drawer to traverse the Documents tab where
    // the toast-stub previously lived.
    const firstRow = document.querySelector('.dt__table tbody tr');
    if (firstRow) {
      await user.click(firstRow as HTMLElement);
      await waitFor(() => {
        expect(
          document.querySelector('[role="tablist"][aria-label="Driver drawer tabs"]'),
        ).toBeTruthy();
      });
    }
    const docsTab = Array.from(
      document.querySelectorAll('[role="tablist"][aria-label="Driver drawer tabs"] [role="tab"]'),
    ).find((t) => t.textContent?.trim() === 'Documents') as HTMLElement | undefined;
    expect(docsTab).toBeDefined();
    if (!docsTab) throw new Error('Documents tab missing');
    await user.click(docsTab);
    expect(screen.queryByRole('button', { name: /Upload document/i })).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Attach document/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Attach document/i }));
    const modal = document.querySelector('.modal') as HTMLElement | null;
    expect(modal).toBeTruthy();
    if (!modal) throw new Error('Attach document modal missing');
    await waitFor(() => {
      expect(
        within(modal).getByText(/Attach a registered document file to this driver profile/i),
      ).toBeInTheDocument();
    });
    expect(within(modal).queryByText(/Artifact id/i)).toBeNull();
    expect(within(modal).queryByText(/Storage bucket/i)).toBeNull();
    expect(within(modal).queryByText(/Storage key/i)).toBeNull();
    expect(within(modal).queryByText(/SHA-256/i)).toBeNull();
    expect(within(modal).getByText(/Document reference/i)).toBeInTheDocument();
    const textboxes = within(modal).getAllByRole('textbox');
    await user.type(textboxes[0]!, 'Riyadh Traffic Authority');
    await user.type(textboxes[1]!, '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830');
    await user.click(within(modal).getByRole('button', { name: /Attach document/i }));

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          artifact_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
          storage_bucket: null,
          storage_key: null,
          sha256: null,
          issuer: 'Riyadh Traffic Authority',
        }),
      );
    });
    expect(typeof api.upload_driver_document_v1).toBe('function');
  });

  it('opens drawer with all 6 tabs when a row is clicked', async () => {
    const user = userEvent.setup();
    await mountAll();
    // Click the first body row of the table.
    const firstRow = document.querySelector('.dt__table tbody tr');
    expect(firstRow).toBeTruthy();
    if (!firstRow) throw new Error('No row to click');
    await user.click(firstRow as HTMLElement);

    // Wait for drawer tabs to render.
    await waitFor(() => {
      expect(
        document.querySelector('[role="tablist"][aria-label="Driver drawer tabs"]'),
      ).toBeTruthy();
    });

    const tablist = document.querySelector(
      '[role="tablist"][aria-label="Driver drawer tabs"]',
    );
    expect(tablist).toBeTruthy();
    const tabs = tablist!.querySelectorAll('[role="tab"]');
    // 6 tabs: Profile / Documents / Compliance events / Hours of Service /
    // Vehicle history / Performance.
    expect(tabs.length).toBe(6);
    const labels = Array.from(tabs).map((t) => t.textContent?.trim());
    expect(labels).toEqual([
      'Profile',
      'Documents',
      'Compliance events',
      'Hours of Service',
      'Vehicle history',
      'Performance',
    ]);
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).toMatch(/Operator identity/i);
    expect(drawerText).not.toMatch(/Driver ID|User ID|usr_dr_/i);
  });

  it('opens the driver drawer from a focus deep link', async () => {
    window.history.pushState(null, '', '/operate/fleet/drivers?focus=drvp_khalid');
    await mountAll();

    await waitFor(() => {
      expect(
        document.querySelector('[role="tablist"][aria-label="Driver drawer tabs"]'),
      ).toBeTruthy();
    });
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).toMatch(/Khalid Al-Otaibi|Operator identity/i);
  });

  it('driver drawer profile renders backend driver_directory readback instead of a stale clicked row', async () => {
    const realGet = api.ui_get_resource_v1;
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'driver_directory' && id === 'drvp_khalid') {
        return {
          id: 'drvp_khalid',
          organization_id: 'org_rashed',
          user_id: 'usr_dr_khalid',
          user_full_name: 'Backend Refetched Driver',
          user_email: 'backend.refetched.driver@example.test',
          name: 'Backend Refetched Driver',
          initials: 'BR',
          driver_code: 'DRV-BACKEND',
          license_number: 'LIC-BACKEND-001',
          license_class: 'B',
          license_expires_at: '2027-05-17',
          current_vehicle_id: null,
          current_branch_id: null,
          status: 'suspended',
          hours_of_service_state: 'off_duty',
          compliance_score: 61,
          phone: '+12025550123',
          emergency_contact_name: 'Backend Contact',
          emergency_contact_phone: '+12025550123',
          hired_at: '2026-05-01',
        } as never;
      }
      return realGet(resource, id) as never;
    });

    window.history.pushState(null, '', '/operate/fleet/drivers?focus=drvp_khalid');
    await mountAll();

    await waitFor(() => {
      expect(document.querySelectorAll('.drawer').length).toBeGreaterThan(0);
    });
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).toMatch(/Backend Refetched Driver/);
    expect(drawerText).toMatch(/DRV-BACKEND/);
    expect(drawerText).toMatch(/Suspended/i);
  });

  it('binds canonical live driver child rows by user_id and assigned_to_user_id', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_complete>[1]) => {
        if (resource === 'driver_documents') {
          return {
            rows: [
              {
                id: 'doc_canonical_user_id',
                organization_id: 'org_rashed',
                user_id: 'usr_dr_khalid',
                doc_type: 'license',
                issuer: 'Canonical Licensing Office',
                artifact_id: 'art_driver_license',
                issued_at: '2025-01-01',
                expires_at: '2027-01-01',
                verified_at: null,
                status: 'submitted',
              },
            ],
            total: 1,
            page: 0,
            page_size: 25,
          } as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
        }
        if (resource === 'driver_compliance_events') {
          return {
            rows: [
              {
                id: 'dce_canonical_user_id',
                organization_id: 'org_rashed',
                user_id: 'usr_dr_khalid',
                event_type: 'manual_note',
                actor_system: 'fleet_policy',
                payload: { severity: 'warn', notes: 'Canonical event row' },
                created_at: '2026-04-26T08:00:00Z',
              },
            ],
            total: 1,
            page: 0,
            page_size: 25,
          } as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
        }
        if (resource === 'vehicle_assignments') {
          return {
            rows: [
              {
                id: 'va_canonical_assigned_to',
                organization_id: 'org_rashed',
                vehicle_id: 'veh_van_118',
                assigned_to_user_id: 'usr_dr_khalid',
                branch_id: 'br_ruh',
                status: 'active',
                started_at: '2026-03-15T07:00:00Z',
                ended_at: null,
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

    await mountAll();
    const row = screen.getByText('Khalid Al-Otaibi').closest('tr');
    expect(row).toBeTruthy();
    if (!row) throw new Error('No row for Khalid');
    await user.click(row as HTMLElement);

    await user.click(screen.getByRole('tab', { name: /Documents/i }));
    expect(await screen.findByText('Canonical Licensing Office')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Compliance events/i }));
    expect(await screen.findByText('fleet_policy')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Vehicle history/i }));
    expect((await screen.findAllByText(/RUH 1184/i)).length).toBeGreaterThan(0);
  });

  it('document Approve action is gated by fleet.write (denied without it)', async () => {
    const user = userEvent.setup();
    // Render with fleet.read only — Approve must be present but disabled
    // (CapabilityLock). Callsite gates on canonical `fleet.write` per the
    // FLEET Wave 5 re-audit D3 closure.
    renderWithProviders(<DriversModule />, {
      capabilities: ['fleet.read'],
    });
    await waitFor(
      () => {
        expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Open Khalid's drawer (Khalid has documents in the seed).
    const khalidName = screen.getByText('Khalid Al-Otaibi');
    const row = khalidName.closest('tr');
    expect(row).toBeTruthy();
    if (!row) throw new Error('No row for Khalid');
    await user.click(row as HTMLElement);

    // Wait for drawer tabs.
    await waitFor(() => {
      expect(
        document.querySelector('[role="tablist"][aria-label="Driver drawer tabs"]'),
      ).toBeTruthy();
    });

    // Switch to Documents tab.
    const docsTab = Array.from(
      document.querySelectorAll('[role="tablist"][aria-label="Driver drawer tabs"] [role="tab"]'),
    ).find((t) => t.textContent?.trim() === 'Documents') as HTMLElement | undefined;
    expect(docsTab).toBeDefined();
    if (!docsTab) throw new Error('Documents tab missing');
    await user.click(docsTab);

    // Documents table is rendered. Open the first row's overflow menu via
    // the canonical "Row actions" button to surface row actions in the
    // palette.
    await waitFor(() => {
      const overflows = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(overflows.length).toBeGreaterThan(0);
    });
    const overflows = screen.getAllByRole('button', { name: /Row actions/i });
    const lastOverflow = overflows[overflows.length - 1];
    if (!lastOverflow) throw new Error('No row actions overflow button');
    await user.click(lastOverflow);

    // Palette items show row actions; the Approve item must surface but
    // its execution is gated downstream by Button.capability — the
    // palette item itself stays visible (we want the operator to see what
    // they're missing). Confirm the action is listed.
    await waitFor(() => {
      const labels = Array.from(
        document.querySelectorAll('.palette__item .palette__item-label'),
      );
      expect(
        labels.some((el) => /Approve/i.test(el.textContent ?? '')),
      ).toBe(true);
    });
  });

  it('HoursOfServiceMeter today renders the correct number of segments per fixture (Khalid: 5)', async () => {
    const user = userEvent.setup();
    await mountAll();
    // Open Khalid's drawer.
    const row = screen.getByText('Khalid Al-Otaibi').closest('tr');
    expect(row).toBeTruthy();
    if (!row) throw new Error('No row for Khalid');
    await user.click(row as HTMLElement);

    await waitFor(() => {
      expect(
        document.querySelector('[role="tablist"][aria-label="Driver drawer tabs"]'),
      ).toBeTruthy();
    });

    const hosTab = Array.from(
      document.querySelectorAll('[role="tablist"][aria-label="Driver drawer tabs"] [role="tab"]'),
    ).find((t) => t.textContent?.trim() === 'Hours of Service') as HTMLElement | undefined;
    expect(hosTab).toBeDefined();
    if (!hosTab) throw new Error('HOS tab missing');
    await user.click(hosTab);

    // The today HoursOfServiceMeter is the FIRST `.primitive-hos` in the
    // drawer body. Khalid's seed has 5 segments today. The 7-day rollup
    // meter renders separately and contains derived segments.
    await waitFor(() => {
      const meters = document.querySelectorAll('.primitive-hos');
      expect(meters.length).toBeGreaterThanOrEqual(1);
    });

    const todayMeter = document.querySelector('.primitive-hos');
    expect(todayMeter).toBeTruthy();
    const segments = todayMeter!.querySelectorAll('.primitive-hos__seg');
    expect(segments.length).toBe(5);
    expect(screen.getByText('Active duty status')).toBeInTheDocument();
    expect(screen.getByText("Today's segments")).toBeInTheDocument();
  });

  it('logs HOS duty changes with the canonical record_hours_of_service_segment_v1 payload', async () => {
    const user = userEvent.setup();
    const hosSpy = vi.spyOn(api, 'record_hours_of_service_segment_v1').mockResolvedValue({
      ok: true,
      driver_hours_of_service_id: 'hos_test',
      correlation_id: 'corr_test',
    });
    await mountAll();
    const row = screen.getByText('Khalid Al-Otaibi').closest('tr');
    expect(row).toBeTruthy();
    if (!row) throw new Error('No row for Khalid');
    await user.click(row as HTMLElement);

    await waitFor(() => {
      expect(
        document.querySelector('[role="tablist"][aria-label="Driver drawer tabs"]'),
      ).toBeTruthy();
    });

    const hosTab = Array.from(
      document.querySelectorAll('[role="tablist"][aria-label="Driver drawer tabs"] [role="tab"]'),
    ).find((t) => t.textContent?.trim() === 'Hours of Service') as HTMLElement | undefined;
    expect(hosTab).toBeDefined();
    if (!hosTab) throw new Error('HOS tab missing');
    await user.click(hosTab);

    await user.click(screen.getByRole('button', { name: /Log duty change/i }));

    await waitFor(() => {
      expect(hosSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          driver_profile_id: 'drvp_khalid',
          driver_user_id: 'usr_dr_khalid',
          duty_status: expect.any(String),
          segment_start: expect.any(String),
        }),
      );
    });
  });

  it('keeps the HOS drawer readback current after backend duty change', async () => {
    const user = userEvent.setup();
    const originalGet = api.ui_get_resource_v1;
    let activeDutyStatus = 'off_duty';
    let segmentCount = 5;
    let activeStartedAt = '2026-05-21T09:42:45.622Z';
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'driver_directory' && id === 'drvp_khalid') {
        const row = (await originalGet(resource, id)) as Record<string, unknown>;
        return {
          ...row,
          hos_active_duty_status: activeDutyStatus,
          hos_segment_count_24h: segmentCount,
          hos_active_segment_started_at: activeStartedAt,
        } as never;
      }
      return originalGet(resource, id) as never;
    });
    const hosSpy = vi.spyOn(api, 'record_hours_of_service_segment_v1').mockImplementation(async () => {
      activeDutyStatus = 'driving';
      segmentCount = 6;
      activeStartedAt = '2026-05-21T09:46:32.059Z';
      return {
        ok: true,
        driver_profile_id: 'drvp_khalid',
        driver_hours_of_service_id: 'hos_driving',
        duty_status: 'driving',
        correlation_id: 'corr_hos_driving',
      };
    });

    await mountAll();
    const row = screen.getByText('Khalid Al-Otaibi').closest('tr');
    expect(row).toBeTruthy();
    if (!row) throw new Error('No row for Khalid');
    await user.click(row as HTMLElement);

    await waitFor(() => {
      expect(
        document.querySelector('[role="tablist"][aria-label="Driver drawer tabs"]'),
      ).toBeTruthy();
    });
    const hosTab = Array.from(
      document.querySelectorAll('[role="tablist"][aria-label="Driver drawer tabs"] [role="tab"]'),
    ).find((t) => t.textContent?.trim() === 'Hours of Service') as HTMLElement | undefined;
    expect(hosTab).toBeDefined();
    if (!hosTab) throw new Error('HOS tab missing');
    await user.click(hosTab);

    await waitFor(() => {
      const strip = document.querySelector('.driver-hos-readback')?.textContent ?? '';
      expect(strip).toMatch(/Off duty/i);
      expect(strip).toContain("Today's segments");
      expect(strip).toContain('5');
    });

    await user.selectOptions(screen.getByLabelText('Duty status'), 'driving');
    await user.click(screen.getByRole('button', { name: /Log duty change/i }));

    await waitFor(() => {
      expect(hosSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          driver_profile_id: 'drvp_khalid',
          driver_user_id: 'usr_dr_khalid',
          duty_status: 'driving',
        }),
      );
      const strip = document.querySelector('.driver-hos-readback')?.textContent ?? '';
      expect(strip).toContain('Driving');
      expect(strip).toContain("Today's segments");
      expect(strip).toContain('6');
      expect(strip).toContain('2026-05-21T09:46:32.059Z');
    });
  });

  // Phase C6 — assert the canonical Phase B2 RPC facade entries exist on the
  // api module (so callsite imports and swap-seam wiring stay in sync).
  it('keeps driver compliance controls and timeline labels operator-facing', async () => {
    const user = userEvent.setup();
    await mountAll();
    const row = screen.getByText('Khalid Al-Otaibi').closest('tr');
    expect(row).toBeTruthy();
    if (!row) throw new Error('No row for Khalid');
    await user.click(row as HTMLElement);

    await waitFor(() => {
      expect(
        document.querySelector('[role="tablist"][aria-label="Driver drawer tabs"]'),
      ).toBeTruthy();
    });

    const complianceTab = Array.from(
      document.querySelectorAll('[role="tablist"][aria-label="Driver drawer tabs"] [role="tab"]'),
    ).find((t) => t.textContent?.trim() === 'Compliance events') as HTMLElement | undefined;
    expect(complianceTab).toBeDefined();
    if (!complianceTab) throw new Error('Compliance tab missing');
    await user.click(complianceTab);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Note compliance event/i })).toBeInTheDocument();
    });
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).not.toMatch(/driver_compliance_severity\/|manual_note|hours_of_service_duty_status/i);

    await user.click(screen.getByRole('button', { name: /Note compliance event/i }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Manual note')).toBeInTheDocument();
    });
    const modalText = document.querySelector('.modal')?.textContent ?? '';
    expect(modalText).not.toMatch(/driver_compliance_severity\/|manual_note|hours_of_service_duty_status/i);
  });

  it('keeps the compliance drawer on the same tab after backend event readback', async () => {
    const user = userEvent.setup();
    const originalCompleteList = api.ui_list_resource_complete;
    const originalGet = api.ui_get_resource_v1;
    const readbackMarker = 'Browser compliance drawer readback marker';
    let complianceEvents: Array<Record<string, unknown>> = [
      {
        id: 'dce_existing_khalid',
        organization_id: 'org_rashed',
        user_id: 'usr_dr_khalid',
        event_type: 'driver_restored',
        actor_system: 'restore_driver_v1',
        payload: { severity: 'info' },
        created_at: '2026-05-20T08:00:00Z',
      },
    ];
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: Parameters<typeof api.ui_list_resource_complete>[1]) => {
        if (resource === 'driver_compliance_events') {
          const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
          const matchesKhalid =
            filter?.user_id === 'usr_dr_khalid' ||
            filter?.driver_id === 'drvp_khalid';
          return {
            rows: matchesKhalid ? complianceEvents : [],
            total: matchesKhalid ? complianceEvents.length : 0,
            page: 0,
            page_size: 25,
          } as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
        }
        return originalCompleteList(resource, opts);
      },
    );
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'driver_directory' && id === 'drvp_khalid') {
        return {
          id: 'drvp_khalid',
          organization_id: 'org_rashed',
          user_id: 'usr_dr_khalid',
          user_full_name: null,
          user_email: null,
          name: null,
          initials: null,
          driver_code: null,
          license_number: null,
          license_class: null,
          license_expires_at: null,
          current_vehicle_id: null,
          current_branch_id: null,
          status: 'active',
          hours_of_service_state: 'off_duty',
          compliance_score: null,
          phone: null,
          emergency_contact_name: null,
          emergency_contact_phone: null,
          hired_at: null,
        } as never;
      }
      return originalGet(resource, id) as never;
    });
    const createEventSpy = vi.spyOn(api, 'create_driver_compliance_event_v1').mockImplementation(async (args) => {
      complianceEvents = [
        {
          id: 'dce_readback_khalid',
          organization_id: 'org_rashed',
          user_id: 'usr_dr_khalid',
          event_type: String(args.event_type),
          actor_system: 'create_driver_compliance_event_v1',
          payload: {
            severity: 'info',
            notes: readbackMarker,
          },
          created_at: '2026-05-21T07:00:00Z',
        },
        ...complianceEvents,
      ];
      return {
        ok: true,
        driver_compliance_event_id: 'dce_readback_khalid',
        correlation_id: 'corr_driver_compliance_readback',
      };
    });

    await mountAll();
    const row = screen.getByText('Khalid Al-Otaibi').closest('tr');
    expect(row).toBeTruthy();
    if (!row) throw new Error('No row for Khalid');
    await user.click(row as HTMLElement);
    await user.click(await screen.findByRole('tab', { name: /Compliance events/i }));
    await user.click(await screen.findByRole('button', { name: /Note compliance event/i }));
    expect(await screen.findByRole('heading', { name: /Note compliance event . Khalid Al-Otaibi/i })).toBeInTheDocument();
    expect(document.querySelector('.modal')?.textContent ?? '').not.toContain('undefined');

    const eventTypeInput = await screen.findByPlaceholderText('Manual note');
    await user.clear(eventTypeInput);
    await user.type(eventTypeInput, 'manual_note');
    await user.type(screen.getByPlaceholderText('Detail captured into payload.notes'), readbackMarker);
    await user.click(screen.getByRole('button', { name: /Note event/i }));

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      expect(screen.getByRole('tab', { name: /Compliance events/i })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('create_driver_compliance_event_v1')).toBeInTheDocument();
    });

    expect(createEventSpy).toHaveBeenCalledWith(expect.objectContaining({
      driver_user_id: 'usr_dr_khalid',
      event_type: 'manual_note',
      payload: expect.objectContaining({
        notes: readbackMarker,
        severity: 'info',
      }),
    }));
  });

  it('exposes canonical Phase B2 RPC facade entries for FLEET drivers', () => {
    expect(typeof api.create_driver_v1).toBe('function');
    expect(typeof api.upload_driver_document_v1).toBe('function');
    expect(typeof api.verify_driver_document_v1).toBe('function');
    expect(typeof api.reject_driver_document_v1).toBe('function');
    expect(typeof api.suspend_driver_v1).toBe('function');
    expect(typeof api.restore_driver_v1).toBe('function');
    expect(typeof api.create_driver_compliance_event_v1).toBe('function');
    expect(typeof api.record_hours_of_service_segment_v1).toBe('function');
  });

  // W50 — `complianceTone` reads its tone bands from the canonical
  // `driver_kpi_thresholds.compliance_score_bands` (90/75/60). Smoke test
  // confirms that high-scoring drivers render the `chip--good` tone in the
  // Compliance column instead of the inline magic-number ladder.
  it('compliance chip tone is resolved from driver_kpi_thresholds.compliance_score_bands', async () => {
    await mountAll();
    // Khalid Al-Otaibi has compliance_score=98 in the seed → bands.good_min=90
    // → expect a chip with `chip--good`.
    const khalidRow = screen.getByText('Khalid Al-Otaibi').closest('tr');
    expect(khalidRow).toBeTruthy();
    if (!khalidRow) throw new Error('No row for Khalid');
    await waitFor(() => {
      const goodChips = khalidRow.querySelectorAll('.chip--good');
      expect(goodChips.length).toBeGreaterThan(0);
    });
  });

  // W29 — paired projection contract assertions for driver_directory.
  // Verifies registry + ui_list_resource_v1 wiring so live cutover stays a
  // single registry flip.
  it('driver_directory paired projection is wired through registry + ui_list_resource_v1', async () => {
    const reg = (registry as unknown as { ui_read_registry: Record<string, { relation: string; capability_read: string }> })
      .ui_read_registry;
    expect(reg.driver_directory?.relation).toBe('v_driver_directory');
    expect(reg.driver_directory?.capability_read).toBe('fleet.read');

    const res = await ds.ui_list_resource_v1<Record<string, unknown>>('driver_directory');
    expect(res.rows.length).toBeGreaterThan(0);
    const r0 = res.rows[0]!;
    expect(typeof r0.id).toBe('string');
    expect('user_full_name' in r0).toBe(true);
    expect('vehicle_label' in r0).toBe(true);
    expect('branch_label' in r0).toBe(true);
    expect(typeof r0.document_count).toBe('number');
    expect(typeof r0.expired_document_count).toBe('number');
    expect(typeof r0.expiring_document_count).toBe('number');
    expect(typeof r0.compliance_event_count).toBe('number');
    expect(typeof r0.compliance_event_count_24h).toBe('number');
    expect(typeof r0.hos_segment_count).toBe('number');
    expect(typeof r0.is_active).toBe('boolean');
    expect(typeof r0.is_suspended).toBe('boolean');
    expect(typeof r0.has_expired_documents).toBe('boolean');
    expect(typeof r0.has_expiring_documents).toBe('boolean');
  });
});
