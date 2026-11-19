// senders.test.tsx — Behavior tests for operator-managed Senders module.
//
// Coverage anchors
//   1. Capability pill uses canonical `senders.read · senders.write` strings.
//   2. Scope ladder rank chip resolves dynamically (rank 3 from `scope_type` lookup), not hardcoded.
//   3. Drawer surfaces brand_name, status, auto_provisioned, auto_recreate, settings_override.
//   4. Suspend row action fires `sender_suspend_v1` with the canonical { sender_id, reason } payload (Phase C3).
//   5. Reactivate row action fires `sender_reactivate_v1` with the canonical { sender_id } payload (Phase C3).
//   6. Sender suspend/reactivate keeps the operator in-place and refreshes table + drawer from backend readback.
//   7. Editable sender fields must wait for backend readback before showing success.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { SendersModule } from '@/modules/customers/senders';
import * as toastStore from '@/components/toastStore';
import * as apiMod from '@/lib/api';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.pushState(null, '', '/customers/senders');
});

describe('SendersModule', () => {
  it('renders the Senders page header and capability pill', async () => {
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write'] });
    expect(await screen.findByRole('heading', { name: /Senders/ })).toBeInTheDocument();
    expect(screen.getByText(/Sender access · sender update/)).toBeInTheDocument();
  });

  it('scopes sender related reads to the active tenant lens', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<SendersModule />, {
      identity: {
        capabilities: ['senders.read', 'senders.write'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByRole('heading', { name: /Senders/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'clients',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'sender_summary',
        expect.objectContaining({ filter: { organization_id_resolved: 'org_swift' } }),
      );
    });
    expect(screen.queryByText(/Exampleparcel JED Warehouse/i)).not.toBeInTheDocument();
  });

  it('applies client related-link filters to sender reads', async () => {
    window.history.pushState(null, '', '/customers/senders?client=cl_swift');
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<SendersModule />, {
      identity: {
        capabilities: ['senders.read', 'senders.write'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByRole('heading', { name: /Senders/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'clients',
        expect.objectContaining({ filter: { organization_id: 'org_swift', id: 'cl_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'sender_summary',
        expect.objectContaining({
          filter: { organization_id_resolved: 'org_swift', client_id: 'cl_swift' },
        }),
      );
    });
  });

  it('denies senders.read without issuing protected sender reads', async () => {
    window.history.pushState(null, '', '/customers/senders?focus=snd_examplemarket_jed_warehouse');
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1');

    renderWithProviders(<SendersModule />, { capabilities: ['senders.write', 'clients.read'] });

    expect(await screen.findByText('You do not have permission to view senders.')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        listSpy.mock.calls.filter(
          ([resource]) => resource === 'senders' || resource === 'clients' || resource === 'sender_summary',
        ),
      ).toEqual([]);
      expect(getSpy.mock.calls.filter(([resource]) => resource === 'senders')).toEqual([]);
    });
  });

  it('fails closed when the tenant sender summary projection cannot be read', async () => {
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'sender_summary') throw new Error('sender summary permission denied');
      return realList(resource, opts);
    });

    renderWithProviders(<SendersModule />, {
      identity: {
        capabilities: ['senders.read', 'senders.write'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByText('Sender directory unavailable')).toBeInTheDocument();
    expect(screen.getByText('sender summary permission denied')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here yet/i)).not.toBeInTheDocument();
  });

  it('renders tenant-scoped sender rows from sender_summary when the base table read is empty', async () => {
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (key: string) => {
        if (key === 'senders') return { rows: [], total: 0, page: 0, page_size: 100 };
        if (key === 'clients') {
          return {
            rows: [{ id: 'cl_swift_live', name: 'Swift Live Client', slug: 'swift-live' }],
            total: 1,
            page: 0,
            page_size: 100,
          };
        }
        if (key === 'sender_summary') {
          return {
            rows: [
              {
                sender_id: 'snd_swift_live',
                id: 'snd_swift_live',
                client_id: 'cl_swift_live',
                name: 'Swift Live Sender',
                brand_name: 'Swift Brand',
                auto_provisioned: false,
                auto_recreate: true,
                status: 'active',
                client_label: 'Swift Live Client',
                client_slug: 'swift-live',
                organization_id_resolved: 'org_swift',
                active_shipments: 0,
                total_shipments: 0,
              },
            ],
            total: 1,
            page: 0,
            page_size: 100,
          };
        }
        return { rows: [], total: 0, page: 0, page_size: 100 };
      },
    );

    renderWithProviders(<SendersModule />, {
      identity: {
        capabilities: ['senders.read', 'senders.write'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByText('Swift Live Sender')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Swift Live Client')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Nothing here yet/i)).not.toBeInTheDocument();
  });

  it('surfaces resolved scope ladder rank in seam pill (not hardcoded)', async () => {
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read'] });
    await screen.findByRole('heading', { name: /Senders/ });
    // Rank 3 is sourced from scope_type lookup in lib/seed-raw/lookups.js (line ~164).
    expect(screen.getByText(/status policy.*priority 3/i)).toBeInTheDocument();
  });

  it('opens drawer and surfaces backed columns', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read'] });

    const row = await screen.findByText(/Exampleparcel JED Warehouse/);
    await user.click(row);

    await waitFor(() => {
      expect(screen.getByText('Brand')).toBeInTheDocument();
      expect(screen.getAllByText('Auto-provisioned').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Auto-recreate')).toBeInTheDocument();
      expect(screen.getByText('Sender settings')).toBeInTheDocument();
      expect(screen.queryByText(/\{|\}/)).not.toBeInTheDocument();
      // Operator-facing control summary shows the dynamic sender scope priority.
      expect(screen.getByText(/Sender scope - priority 3/)).toBeInTheDocument();
    });
  });

  it('reads related shipments for the open sender drawer through shipment_directory', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'shipment_directory') {
        return {
          rows: [{
            id: 'shp_sender_related_1',
            tracking_number: 'SHP-SENDER-RELATED-1',
            client_reference_number: 'EXAMPLEPARCEL-RELATED-1',
            status: 'in_transit',
            service_type: 'express',
            recipient_label: 'Layla Al-Saud',
            destination_city: 'Riyadh',
            promised_delivery_date: '2026-04-25T18:00:00Z',
          }],
          total: 1,
          page: 0,
          page_size: 3,
        };
      }
      return realList(resource, opts);
    });
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'shipments.read'] });

    await user.click(await screen.findByText(/Exampleparcel JED Warehouse/));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'shipment_directory',
        expect.objectContaining({
          filter: { sender_id: 'snd_examplemarket_jed_warehouse' },
          page_size: 3,
        }),
      );
      expect(screen.getByText('Related shipments')).toBeInTheDocument();
      expect(screen.getByText('SHP-SENDER-RELATED-1')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Open shipment' }).length).toBeGreaterThan(0);
    });
  });

  it('opens the sender drawer from a row deep-link focus URL', async () => {
    window.history.pushState(null, '', '/customers/senders?focus=snd_examplemarket_jed_warehouse');

    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'clients.read'] });

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(drawer.textContent ?? '').toContain('Exampleparcel JED Warehouse');
    expect(drawer.textContent ?? '').toContain('Sender settings');
    expect(drawer.textContent ?? '').toContain('Shipments from sender');
  });
});

// ---- PHASE C3 mutation wiring (CLAIM-CUSTOMERS-CATALOG-WIRING) ----
// Suspend / Reactivate flow through canonical Phase B6 RPCs:
//   • public.sender_suspend_v1     — supabase/migrations/202604280216_sender_suspend_v1.sql
//   • public.sender_reactivate_v1  — supabase/migrations/202604280217_sender_reactivate_v1.sql
describe('SendersModule · lifecycle wiring (Phase C3)', () => {
  // W56-E — typed spy helper preserves the precise MockInstance shape returned
  // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
  let suspendSpy: TypedSpy<typeof apiMod, 'sender_suspend_v1'>;
  let reactivateSpy: TypedSpy<typeof apiMod, 'sender_reactivate_v1'>;
  beforeEach(() => {
    suspendSpy = typedSpy(apiMod, 'sender_suspend_v1');
    reactivateSpy = typedSpy(apiMod, 'sender_reactivate_v1');
  });
  afterEach(() => {
    suspendSpy.mockRestore();
    reactivateSpy.mockRestore();
  });

  it('Suspend modal fires sender_suspend_v1 with canonical { sender_id, reason } payload', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const suspend = await screen.findByRole('option', { name: /^Suspend/ });
    await user.click(suspend);

    const reasonInput = await screen.findByPlaceholderText(/Webhook compromised/);
    await user.type(reasonInput, 'Credentials rotated');
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await user.click(confirm);

    await waitFor(() => {
      expect(suspendSpy).toHaveBeenCalled();
    });
    const args = suspendSpy.mock.calls[0]?.[0] as { sender_id?: string; reason?: string } | undefined;
    expect(args?.sender_id).toBeTruthy();
    expect(args?.reason).toBe('Credentials rotated');
  });

  it('Reactivate row action fires sender_reactivate_v1 with canonical { sender_id } payload', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_suspended_sender', name: 'Suspended Sender Client', slug: 'suspended-sender-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'senders') {
        return {
          rows: [
            {
              id: 'snd_suspended_for_reactivate',
              client_id: 'cl_suspended_sender',
              name: 'Suspended Sender',
              brand_name: 'Suspended Brand',
              status: 'suspended',
              auto_provisioned: false,
              auto_recreate: true,
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'sender_summary') {
        return {
          rows: [
            {
              sender_id: 'snd_suspended_for_reactivate',
              id: 'snd_suspended_for_reactivate',
              client_id: 'cl_suspended_sender',
              client_label: 'Suspended Sender Client',
              client_slug: 'suspended-sender-client',
              name: 'Suspended Sender',
              brand_name: 'Suspended Brand',
              status: 'suspended',
              auto_provisioned: false,
              auto_recreate: true,
              active_shipments: 0,
              total_shipments: 0,
              has_warehouse: false,
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const reactivate = await screen.findByRole('option', { name: /^Reactivate/ });
    await user.click(reactivate);

    await waitFor(() => {
      expect(reactivateSpy).toHaveBeenCalled();
    });
    const args = reactivateSpy.mock.calls[0]?.[0] as { sender_id?: string } | undefined;
    expect(args?.sender_id).toBe('snd_suspended_for_reactivate');
  });

  it('Suspend action refreshes visible sender status and sender drawer from backend readback without reload', async () => {
    const user = userEvent.setup();
    const senderName = 'Suspend Readback Sender';
    let senderStatus = 'active';
    let suspensionReason: string | null = null;
    const realList = apiMod.ui_list_resource_v1;
    const senderSummaryRow = () => ({
      id: 'snd_suspend_readback',
      sender_id: 'snd_suspend_readback',
      organization_id_resolved: 'org_rashed',
      client_id: 'cl_suspend_readback',
      name: senderName,
      brand_name: 'Suspend Readback Brand',
      status: senderStatus,
      suspension_reason: suspensionReason,
      client_label: 'Suspend Readback Client',
      client_slug: 'suspend-readback-client',
      auto_provisioned: false,
      auto_recreate: true,
      active_shipments: 0,
      total_shipments: 0,
      has_warehouse: false,
    });

    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_suspend_readback', name: 'Suspend Readback Client', slug: 'suspend-readback-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'senders' || resource === 'sender_summary') {
        return { rows: [senderSummaryRow()], total: 1, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });
    suspendSpy.mockImplementation(async (args) => {
      senderStatus = 'suspended';
      suspensionReason = args.reason ?? null;
      return {
        ok: true,
        sender_id: 'snd_suspend_readback',
        idempotent_no_op: false,
        correlation_id: 'sender-suspend-readback',
        settings_resolution_id: 'srlv_sender_suspend_readback',
      };
    });

    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write', 'clients.read'] });

    await waitFor(() => {
      expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /^Suspend/ }));
    await user.type(await screen.findByPlaceholderText(/Webhook compromised/), 'Credentials rotated for sender');
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.getAllByText('Suspended').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('dialog', { name: /Suspend ·/i })).not.toBeInTheDocument();
    await user.click(await screen.findByText(senderName));
    await waitFor(() => {
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toContain('Suspended');
      expect(drawerText).toContain('Credentials rotated for sender');
    });
    expect(window.location.pathname).toBe('/customers/senders');
  });

  it('Reactivate action refreshes visible sender status and sender drawer from backend readback without reload', async () => {
    const user = userEvent.setup();
    const senderName = 'Reactivate Readback Sender';
    let senderStatus = 'suspended';
    let suspensionReason: string | null = 'Webhook compromised';
    const realList = apiMod.ui_list_resource_v1;
    const senderSummaryRow = () => ({
      id: 'snd_reactivate_readback',
      sender_id: 'snd_reactivate_readback',
      organization_id_resolved: 'org_rashed',
      client_id: 'cl_reactivate_readback',
      name: senderName,
      brand_name: 'Reactivate Readback Brand',
      status: senderStatus,
      suspension_reason: suspensionReason,
      client_label: 'Reactivate Readback Client',
      client_slug: 'reactivate-readback-client',
      auto_provisioned: false,
      auto_recreate: true,
      active_shipments: 0,
      total_shipments: 0,
      has_warehouse: false,
    });

    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_reactivate_readback', name: 'Reactivate Readback Client', slug: 'reactivate-readback-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'senders' || resource === 'sender_summary') {
        return { rows: [senderSummaryRow()], total: 1, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });
    reactivateSpy.mockImplementation(async () => {
      senderStatus = 'active';
      suspensionReason = null;
      return {
        ok: true,
        sender_id: 'snd_reactivate_readback',
        idempotent_no_op: false,
        correlation_id: 'sender-reactivate-readback',
        settings_resolution_id: 'srlv_sender_reactivate_readback',
      };
    });

    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write', 'clients.read'] });

    await waitFor(() => {
      expect(screen.getAllByText('Suspended').length).toBeGreaterThan(0);
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /^Reactivate/ }));

    await waitFor(() => {
      expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    });
    await user.click(await screen.findByText(senderName));
    await waitFor(() => {
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toContain('Active');
      expect(drawerText).not.toContain('Webhook compromised');
    });
    expect(window.location.pathname).toBe('/customers/senders');
  });

  it('disables sender lifecycle actions that do not match the sender status', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_active_sender', name: 'Active Sender Client', slug: 'active-sender-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'senders') {
        return {
          rows: [
            {
              id: 'snd_active_for_lifecycle_gate',
              client_id: 'cl_active_sender',
              name: 'Active Sender',
              brand_name: 'Active Brand',
              status: 'active',
              auto_provisioned: false,
              auto_recreate: true,
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'sender_summary') {
        return {
          rows: [
            {
              sender_id: 'snd_active_for_lifecycle_gate',
              id: 'snd_active_for_lifecycle_gate',
              client_id: 'cl_active_sender',
              client_label: 'Active Sender Client',
              client_slug: 'active-sender-client',
              name: 'Active Sender',
              brand_name: 'Active Brand',
              status: 'active',
              auto_provisioned: false,
              auto_recreate: true,
              active_shipments: 0,
              total_shipments: 0,
              has_warehouse: false,
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);

    const reactivate = await screen.findByRole('option', { name: /^Reactivate/ });
    expect(reactivate).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Only suspended senders can be reactivated.')).toBeInTheDocument();

    const suspend = await screen.findByRole('option', { name: /^Suspend/ });
    expect(suspend).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('blocks Suspend submit when reason is empty (no RPC call)', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_active_sender_empty', name: 'Active Sender Empty Client', slug: 'active-sender-empty-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'senders') {
        return {
          rows: [
            {
              id: 'snd_active_for_suspend_empty',
              client_id: 'cl_active_sender_empty',
              name: 'Active Sender Empty',
              brand_name: 'Active Brand',
              status: 'active',
              auto_provisioned: false,
              auto_recreate: true,
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'sender_summary') {
        return {
          rows: [
            {
              sender_id: 'snd_active_for_suspend_empty',
              id: 'snd_active_for_suspend_empty',
              client_id: 'cl_active_sender_empty',
              client_label: 'Active Sender Empty Client',
              client_slug: 'active-sender-empty-client',
              name: 'Active Sender Empty',
              brand_name: 'Active Brand',
              status: 'active',
              auto_provisioned: false,
              auto_recreate: true,
              active_shipments: 0,
              total_shipments: 0,
              has_warehouse: false,
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const suspend = await screen.findByRole('option', { name: /^Suspend/ });
    await user.click(suspend);

    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await user.click(confirm);

    expect(suspendSpy).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Reason is required/i), 'warn');
  });
});

// ---- WAVE 6 mutation wiring (CUSTOMERS Wave 6) ----
// Create / Update flow through canonical Wave 6 RPCs:
//   • public.sender_create_v1 — supabase/migrations/202604301020_sender_create_v1.sql
//   • public.sender_update_v1 — supabase/migrations/202604301030_sender_update_v1.sql
describe('SendersModule · create/update wiring (Wave 6)', () => {
  // Cast to a loose unknown so the spy's mock.calls type widens — the narrow
  // signature emitted by `vi.spyOn` against the typed api facades collides
  // with the loose `MockInstance<(this: unknown, ...args: unknown[]) => unknown>`
  // type. We assert against recorded call args directly below.
  type LooseSpy = ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };
  let createSpy: LooseSpy;
  let updateSpy: LooseSpy;
  beforeEach(() => {
    createSpy = vi.spyOn(apiMod, 'sender_create_v1') as unknown as LooseSpy;
    updateSpy = vi.spyOn(apiMod, 'sender_update_v1') as unknown as LooseSpy;
  });
  afterEach(() => {
    createSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it('New sender modal fires sender_create_v1 with canonical payload', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write'] });

    // Wait for clients-list to populate so the New-sender form has a default
    // client_id selection.
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const newBtn = await screen.findByRole('button', { name: /New sender/ });
    await user.click(newBtn);

    const name = await screen.findByLabelText('Name');
    await user.type(name, 'B6 New Sender');
    const create = await screen.findByRole('button', { name: 'Create' });
    await user.click(create);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    const args = createSpy.mock.calls[0]?.[0] as
      | { client_id?: string; name?: string }
      | undefined;
    expect(args?.client_id).toBeTruthy();
    expect(args?.name).toBe('B6 New Sender');
  });

  it('New sender create shows backend readback in the table without reload', async () => {
    const user = userEvent.setup();
    const newSenderName = 'No Reload Create Sender';
    let senderRows: Array<Record<string, unknown>> = [];
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_no_reload_sender', name: 'No Reload Sender Client', slug: 'no-reload-sender-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'senders') {
        return { rows: senderRows, total: senderRows.length, page: 0, page_size: 100 };
      }
      if (resource === 'sender_summary') {
        return {
          rows: senderRows.map((row) => ({
            ...row,
            sender_id: row.id,
            client_label: 'No Reload Sender Client',
            client_slug: 'no-reload-sender-client',
            organization_id_resolved: 'org_rashed',
            active_shipments: 0,
            total_shipments: 0,
            has_warehouse: false,
          })),
          total: senderRows.length,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    createSpy.mockImplementation(async (args: unknown) => {
      const payload = args as Record<string, unknown>;
      senderRows = [
        {
          id: 'snd_no_reload_create',
          organization_id: 'org_rashed',
          client_id: payload.client_id,
          name: payload.name,
          brand_name: payload.brand_name ?? null,
          status: 'active',
          auto_provisioned: false,
          auto_recreate: true,
        },
      ];
      return senderRows[0] as never;
    });

    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write', 'clients.read'] });

    expect(screen.queryByText(newSenderName)).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /New sender/ }));
    await user.type(await screen.findByLabelText('Name'), newSenderName);
    await user.click(await screen.findByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getAllByText(newSenderName).length).toBeGreaterThan(1);
    });
    expect(screen.queryByRole('dialog', { name: /New sender/i })).not.toBeInTheDocument();
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).toContain(newSenderName);
    expect(drawerText).toContain('Sender settings');
    expect(drawerText).toContain('Quick links');
  });

  it('New sender duplicate name surfaces operator-friendly error copy', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    createSpy.mockRejectedValueOnce(new Error('sender_create_v1 duplicate active sender name'));

    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write', 'clients.read'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    await user.click(await screen.findByRole('button', { name: /New sender/ }));
    await user.type(await screen.findByLabelText('Name'), 'Exampleparcel JED Warehouse');
    await user.click(await screen.findByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        'An active sender with this name already exists for the selected client.',
        'danger',
      );
    });
    const dialog = screen.getByRole('dialog', { name: /New sender/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('An active sender with this name already exists for the selected client.')).toBeInTheDocument();
  });

  it('drawer sender edits refresh the open drawer from backend readback without reload', async () => {
    const user = userEvent.setup();
    let senderName = 'Drawer Readback Sender Original';
    const updatedName = 'Drawer Readback Sender Updated';
    const realList = apiMod.ui_list_resource_v1;
    const senderSummaryRow = () => ({
      id: 'snd_drawer_readback',
      sender_id: 'snd_drawer_readback',
      organization_id_resolved: 'org_rashed',
      client_id: 'cl_drawer_readback',
      name: senderName,
      brand_name: 'Drawer Brand',
      status: 'active',
      client_label: 'Drawer Readback Client',
      client_slug: 'drawer-readback-client',
      auto_provisioned: false,
      auto_recreate: true,
      active_shipments: 0,
      total_shipments: 0,
      has_warehouse: false,
    });

    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_drawer_readback', name: 'Drawer Readback Client', slug: 'drawer-readback-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'senders') {
        return { rows: [senderSummaryRow()], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'sender_summary') {
        return { rows: [senderSummaryRow()], total: 1, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });
    updateSpy.mockImplementation(async (args: unknown) => {
      senderName = String((args as Record<string, unknown>).name ?? senderName);
      return { ok: true, sender_id: 'snd_drawer_readback' } as never;
    });

    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write', 'clients.read'] });

    await user.click(await screen.findByText(senderName));
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain(senderName);
    });

    const nameRow = Array.from(document.querySelectorAll('.drawer .kvgrid__row'))
      .find((el) => el.textContent?.includes('Name')) as HTMLElement | undefined;
    expect(nameRow).toBeTruthy();
    const nameValue = nameRow!.querySelector('.kvgrid__val') as HTMLElement;
    await user.click(nameValue);
    const editInput = nameRow!.querySelector('input.dt-inline-input') as HTMLInputElement;
    await user.clear(editInput);
    await user.type(editInput, `${updatedName}{Enter}`);

    await waitFor(() => {
      expect(screen.getAllByText(updatedName).length).toBeGreaterThan(1);
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(drawer.textContent ?? '').toContain(updatedName);
    expect(drawer.textContent ?? '').not.toContain('Drawer Readback Sender Original');
  });

  it('drawer sender edit rejects stale backend readback instead of showing local-only success', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    const staleName = 'Drawer Stale Sender Original';
    const attemptedName = 'Drawer Stale Sender Updated';
    const realList = apiMod.ui_list_resource_v1;
    const senderSummaryRow = () => ({
      id: 'snd_drawer_stale_readback',
      sender_id: 'snd_drawer_stale_readback',
      organization_id_resolved: 'org_rashed',
      client_id: 'cl_drawer_stale_readback',
      name: staleName,
      brand_name: 'Stale Brand',
      status: 'active',
      client_label: 'Drawer Stale Client',
      client_slug: 'drawer-stale-client',
      auto_provisioned: false,
      auto_recreate: true,
      active_shipments: 0,
      total_shipments: 0,
      has_warehouse: false,
    });

    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_drawer_stale_readback', name: 'Drawer Stale Client', slug: 'drawer-stale-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'senders') {
        return { rows: [senderSummaryRow()], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'sender_summary') {
        return { rows: [senderSummaryRow()], total: 1, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });
    updateSpy.mockResolvedValue({ ok: true, sender_id: 'snd_drawer_stale_readback' } as never);

    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write', 'clients.read'] });

    await user.click(await screen.findByText(staleName));
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain(staleName);
    });

    const nameRow = Array.from(document.querySelectorAll('.drawer .kvgrid__row'))
      .find((el) => el.textContent?.includes('Name')) as HTMLElement | undefined;
    expect(nameRow).toBeTruthy();
    const nameValue = nameRow!.querySelector('.kvgrid__val') as HTMLElement;
    await user.click(nameValue);
    const editInput = nameRow!.querySelector('input.dt-inline-input') as HTMLInputElement;
    await user.clear(editInput);
    await user.type(editInput, `${attemptedName}{Enter}`);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sender_id: 'snd_drawer_stale_readback',
          name: attemptedName,
        }),
      );
      expect(toast).toHaveBeenCalledWith(
        'The updated sender was not available yet.',
        'danger',
      );
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(drawer.textContent ?? '').toContain(staleName);
    expect(drawer.textContent ?? '').not.toContain(attemptedName);
    expect(window.location.pathname).toBe('/customers/senders');
  });

  it('exposes sender_create_v1 + sender_update_v1 facades (canonical RPC names)', () => {
    expect(typeof apiMod.sender_create_v1).toBe('function');
    expect(typeof apiMod.sender_update_v1).toBe('function');
  });

  it('New sender button blocked when capability missing', async () => {
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read'] });
    const newBtn = await screen.findByRole('button', { name: /New sender/ });
    expect(newBtn).toBeDisabled();
  });

  it('New sender button is blocked when no client is visible for the tenant', async () => {
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      if (resource === 'sender_summary') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });

    try {
      renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write'] });
      const newBtn = await screen.findByRole('button', { name: /New sender/ });
      await waitFor(() => {
        expect(newBtn).toBeDisabled();
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('blocks New sender submit when name is empty (no RPC call)', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read', 'senders.write'] });

    // Wait for clients-list to populate so the form has a default client_id
    // (otherwise the form's client_id validation fires first).
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const newBtn = await screen.findByRole('button', { name: /New sender/ });
    await user.click(newBtn);
    const create = await screen.findByRole('button', { name: 'Create' });
    await user.click(create);

    expect(createSpy).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Name is required/i), 'warn');
  });
});

// ---- WAVE 21 paired projection wiring (CUSTOMERS W21) ----
// Drawer surfaces canonical projection-derived chips from
// `public.v_sender_summary` (active_shipments + total_shipments counter,
// sla_tier_inherited from clients join). Read-only; SSOT remains
// `public.senders` via the registry seam. See:
//   • supabase/migrations/202604302010_v_sender_summary.sql
//   • apps/console-v2/src/lib/data-source.ts → _projectSenderSummary
describe('SendersModule · paired projection wiring (W21)', () => {
  it('drawer surfaces shipment counter chip from sender_summary projection', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SendersModule />, { capabilities: ['senders.read'] });

    const row = await screen.findByText(/Exampleparcel JED Warehouse/);
    await user.click(row);

    await waitFor(() => {
      // Canonical shipment counter chip
      expect(screen.getByText(/\d+ active · \d+ total shipments/)).toBeInTheDocument();
    });
  });
});
