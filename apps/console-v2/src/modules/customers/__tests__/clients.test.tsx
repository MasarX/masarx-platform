// clients.test.tsx — Behavior tests for the operator-managed Clients module.
//
// Coverage anchors
//   1. Status writes are constrained to explicit lifecycle actions that capture real audit reason.
//   2. Capability gate uses `clients.write` (no role gets the legacy `customers.write`).
//   3. Drawer surfaces backed columns (account manager, contracts, suspension reason, settings_override).
//   4. New-client form validates required fields against the slug constraint surface.
//   5. Suspend modal fires `client_suspend_v1` with the canonical { client_id, reason } payload (Phase C3).
//   6. Reactivate row action fires `client_reactivate_v1` with the canonical { client_id } payload (Phase C3).
//   7. Editable client fields must wait for backend readback before showing success.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ClientsModule } from '@/modules/customers/clients';

// pushToast is the canonical one-shot user feedback channel; spy on it so we can verify
// validation paths without depending on toast-store render plumbing.
import * as toastStore from '@/components/toastStore';
import * as apiMod from '@/lib/api';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.pushState(null, '', '/customers/clients');
  document.body.removeAttribute('data-scroll-locked');
  document.body.style.pointerEvents = '';
});

describe('ClientsModule', () => {
  it('renders the Clients page header with canonical capability pill', async () => {
    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });
    expect(await screen.findByText(/Clients/)).toBeInTheDocument();
    // Capability chip is row-driven from registry capability strings.
    expect(screen.getByText(/Client access · client update/)).toBeInTheDocument();
  });

  it('scopes client and client summary reads to the active tenant lens', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<ClientsModule />, {
      identity: {
        capabilities: ['clients.read', 'clients.write'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByRole('heading', { name: /Clients/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'clients',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'client_summary',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
    });
    expect(screen.queryByText(/Demo Client/i)).not.toBeInTheDocument();
  });

  it('disables New client when clients.write capability is missing', async () => {
    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read'] });
    const button = await screen.findByRole('button', { name: /New client/ });
    expect(button).toBeDisabled();
  });

  it('denies clients.read without issuing protected client reads', async () => {
    window.history.pushState(null, '', '/customers/clients?focus=cl_exampleparcel_ksa');
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1');

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.write'] });

    expect(await screen.findByText('You do not have permission to view clients.')).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy.mock.calls.filter(([resource]) => resource === 'clients' || resource === 'client_summary')).toEqual([]);
      expect(getSpy.mock.calls.filter(([resource]) => resource === 'clients')).toEqual([]);
    });
  });

  it('fails closed when the tenant client summary projection cannot be read', async () => {
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'client_summary') throw new Error('client summary permission denied');
      return realList(resource, opts);
    });

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    expect(await screen.findByText('Client summary unavailable')).toBeInTheDocument();
    expect(screen.getByText('client summary permission denied')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here yet/i)).not.toBeInTheDocument();
  });

  it('opens a new-client modal and validates required fields', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    const newBtn = await screen.findByRole('button', { name: /New client/ });
    await user.click(newBtn);

    // Click Create with empty fields → toast warns about missing name.
    const createBtn = await screen.findByRole('button', { name: 'Create' });
    await user.click(createBtn);

    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Name is required/i), 'warn');
  });

  it('opens client drawer and surfaces backed columns', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    const row = await screen.findByText(/Exampleparcel KSA/);
    await user.click(row);

    await waitFor(() => {
      // Drawer renders KvGrid labels for backed columns. Use getAllBy where label may collide
      // with the table column header (e.g. 'Contract end' is both a column header and a kv label).
      expect(screen.getByText('Account manager')).toBeInTheDocument();
      expect(screen.getByText('Assigned account manager')).toBeInTheDocument();
      expect(screen.queryByText(/usr_admin_rashed/i)).not.toBeInTheDocument();
      expect(screen.getByText('Contract start')).toBeInTheDocument();
      expect(screen.getAllByText('Contract end').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Suspension reason')).toBeInTheDocument();
      expect(screen.getByText('Client settings')).toBeInTheDocument();
      expect(screen.queryByText('Settings override')).not.toBeInTheDocument();
    });
  });

  it('routes client drawer finance quick links to scoped finance views', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    await user.click(await screen.findByText(/Exampleparcel KSA/));
    const drawer = await waitFor(() => document.querySelector('.drawer') as HTMLElement | null);
    expect(drawer).toBeTruthy();

    await user.click(within(drawer!).getByRole('button', { name: 'Ledger' }));

    expect(window.location.pathname).toBe('/finance/ledger');
    expect(window.location.search).toBe('?client=cl_exampleparcel_ksa');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(document.querySelector('.drawer')).toBeNull();
    });
    document.body.removeAttribute('data-scroll-locked');
    document.body.style.pointerEvents = '';
  });

  it('routes client row actions to scoped disputes and ledger views', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /^View disputes/ }));

    expect(window.location.pathname).toBe('/finance/disputes');
    expect(window.location.search).toBe('?client=cl_exampleparcel_ksa');

    window.history.pushState(null, '', '/customers/clients');
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /^View ledger/ }));

    expect(window.location.pathname).toBe('/finance/ledger');
    expect(window.location.search).toBe('?client=cl_exampleparcel_ksa');
  });

  it('keeps client status read-only in table and drawer so audit reason cannot be bypassed', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const statusHeader = Array.from(document.querySelectorAll('th'))
      .find((el) => el.textContent?.includes('Status')) as HTMLElement | undefined;
    expect(statusHeader).toBeTruthy();
    expect(statusHeader!.getAttribute('title')).toBe('Status');
    expect(statusHeader!.querySelector('.dt-th-mark')).toBeNull();

    await user.click(await screen.findByText(/Exampleparcel KSA/));
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const statusRow = Array.from(document.querySelectorAll('.drawer .kvgrid__row'))
      .find((el) => el.textContent?.includes('Status')) as HTMLElement | undefined;
    expect(statusRow).toBeTruthy();
    expect(statusRow!.querySelector('.kvgrid__val--editable')).toBeNull();
  });

  it('opens the client drawer from a row deep-link focus URL', async () => {
    window.history.pushState(null, '', '/customers/clients?focus=cl_exampleparcel_ksa');

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(within(drawer).getAllByText('Exampleparcel KSA').length).toBeGreaterThan(0);
    expect(within(drawer).getByText('Account manager')).toBeInTheDocument();
    expect(within(drawer).getByText('Assigned account manager')).toBeInTheDocument();
    expect(within(drawer).queryByText(/usr_admin_rashed/i)).not.toBeInTheDocument();
    expect(within(drawer).getByText('Client settings')).toBeInTheDocument();
    expect(within(drawer).queryByText('Settings override')).not.toBeInTheDocument();
  });

  it('opens a tenant-scoped client focus URL when the row is outside the loaded list', async () => {
    window.history.pushState(null, '', '/customers/clients?focus=cl_swift_focus');
    const realList = apiMod.ui_list_resource_v1;
    const realGet = apiMod.ui_get_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });
    vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (resource === 'clients' && id === 'cl_swift_focus') {
        return {
          id: 'cl_swift_focus',
          organization_id: 'org_swift',
          name: 'Swift Focus Client',
          slug: 'swift-focus-client',
          status: 'active',
          sla_tier: 'standard',
        } as never;
      }
      return realGet(resource, id);
    });

    renderWithProviders(<ClientsModule />, {
      identity: {
        capabilities: ['clients.read', 'clients.write'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(within(drawer).getAllByText('Swift Focus Client').length).toBeGreaterThan(0);
  });
});

// ---- PHASE C3 mutation wiring (CLAIM-CUSTOMERS-CATALOG-WIRING) ----
// Suspend / Reactivate flow through canonical Phase B6 RPCs:
//   • public.client_suspend_v1     — supabase/migrations/202604280214_client_suspend_v1.sql
//   • public.client_reactivate_v1  — supabase/migrations/202604280215_client_reactivate_v1.sql
describe('ClientsModule · lifecycle wiring (Phase C3)', () => {
  // W56-E — typed spy helper preserves the precise MockInstance shape returned
  // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
  let suspendSpy: TypedSpy<typeof apiMod, 'client_suspend_v1'>;
  let reactivateSpy: TypedSpy<typeof apiMod, 'client_reactivate_v1'>;
  beforeEach(() => {
    suspendSpy = typedSpy(apiMod, 'client_suspend_v1');
    reactivateSpy = typedSpy(apiMod, 'client_reactivate_v1');
  });
  afterEach(() => {
    suspendSpy.mockRestore();
    reactivateSpy.mockRestore();
  });

  it('Suspend modal fires client_suspend_v1 with canonical { client_id, reason } payload', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    // DataTable surfaces row actions via a kebab "Row actions" button per row.
    // Open the first row (Exampleparcel KSA, sorted by default seed order) and select Suspend.
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const suspend = await screen.findByRole('option', { name: /^Suspend/ });
    await user.click(suspend);

    // Modal opens with reason input.
    const reasonInput = await screen.findByPlaceholderText(/Outstanding balance/);
    await user.type(reasonInput, 'Late payment > 60d');
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await user.click(confirm);

    await waitFor(() => {
      expect(suspendSpy).toHaveBeenCalledTimes(1);
    });
    const args = suspendSpy.mock.calls[0]?.[0] as { client_id?: string; reason?: string } | undefined;
    expect(args?.client_id).toBeTruthy();
    expect(args?.reason).toBe('Late payment > 60d');
  });

  it('Suspend action refreshes visible client status from backend readback without reload', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    let clientStatus = 'active';
    let suspensionReason: string | null = null;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [
            {
              id: 'cl_suspend_readback',
              organization_id: 'org_rashed',
              name: 'Suspend Readback Client',
              slug: 'suspend-readback-client',
              status: clientStatus,
              suspension_reason: suspensionReason,
              sla_tier: 'standard',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'client_summary') {
        return {
          rows: [
            {
              client_id: 'cl_suspend_readback',
              sender_count: 0,
              recipient_count: 0,
              active_shipments: 0,
              total_shipments: 0,
              contract_active: clientStatus === 'active',
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
    suspendSpy.mockImplementation(async (args) => {
      clientStatus = 'suspended';
      suspensionReason = args.reason ?? '';
      return {
        ok: true,
        client_id: 'cl_suspend_readback',
        idempotent_no_op: false,
        correlation_id: 'cor_suspend_readback',
        settings_resolution_id: 'srlv_suspend_readback',
      };
    });

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    const rowCell = await screen.findByText('Suspend Readback Client');
    expect(rowCell.closest('tr')).toHaveTextContent(/active/i);
    expect(window.location.pathname).toBe('/customers/clients');
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /^Suspend/ }));
    await user.type(await screen.findByPlaceholderText(/Outstanding balance/), 'Balance review');
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.getByText('Suspend Readback Client').closest('tr')).toHaveTextContent(/suspended/i);
    });
    expect(window.location.pathname).toBe('/customers/clients');
    expect(screen.queryByRole('dialog', { name: /Suspend/i })).not.toBeInTheDocument();
    await user.click(screen.getByText('Suspend Readback Client'));
    const drawer = await waitFor(() => document.querySelector('.drawer') as HTMLElement | null);
    expect(drawer?.textContent ?? '').toContain('Balance review');
  });

  it('Reactivate row action fires client_reactivate_v1 with canonical { client_id } payload', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [
            {
              id: 'cl_suspended_for_reactivate',
              organization_id: 'org_rashed',
              name: 'Suspended Client',
              slug: 'suspended-client',
              status: 'suspended',
              sla_tier: 'standard',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'client_summary') {
        return {
          rows: [
            {
              client_id: 'cl_suspended_for_reactivate',
              sender_count: 0,
              recipient_count: 0,
              active_shipments: 0,
              total_shipments: 0,
              contract_active: false,
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
    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    // cmdk renders the label inside the visually-hidden inner span and the visible
    // span, so accessible-name matching needs a regex (the textContent reads "ReactivateReactivate").
    const reactivate = await screen.findByRole('option', { name: /^Reactivate/ });
    await user.click(reactivate);

    await waitFor(() => {
      expect(reactivateSpy).toHaveBeenCalled();
    });
    const args = reactivateSpy.mock.calls[0]?.[0] as { client_id?: string } | undefined;
    expect(args?.client_id).toBe('cl_suspended_for_reactivate');
  });

  it('Reactivate action refreshes visible client status from backend readback without reload', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    let clientStatus = 'suspended';
    let suspensionReason: string | null = 'Resolved balance';
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [
            {
              id: 'cl_reactivate_readback',
              organization_id: 'org_rashed',
              name: 'Reactivate Readback Client',
              slug: 'reactivate-readback-client',
              status: clientStatus,
              suspension_reason: suspensionReason,
              sla_tier: 'standard',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'client_summary') {
        return {
          rows: [
            {
              client_id: 'cl_reactivate_readback',
              sender_count: 0,
              recipient_count: 0,
              active_shipments: 0,
              total_shipments: 0,
              contract_active: clientStatus === 'active',
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
    reactivateSpy.mockImplementation(async () => {
      clientStatus = 'active';
      suspensionReason = null;
      return {
        ok: true,
        client_id: 'cl_reactivate_readback',
        idempotent_no_op: false,
        correlation_id: 'cor_reactivate_readback',
        settings_resolution_id: 'srlv_reactivate_readback',
      };
    });

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    const rowCell = await screen.findByText('Reactivate Readback Client');
    expect(rowCell.closest('tr')).toHaveTextContent(/suspended/i);
    expect(window.location.pathname).toBe('/customers/clients');
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /^Reactivate/ }));

    await waitFor(() => {
      expect(screen.getByText('Reactivate Readback Client').closest('tr')).toHaveTextContent(/active/i);
    });
    expect(window.location.pathname).toBe('/customers/clients');
    await user.click(screen.getByText('Reactivate Readback Client'));
    const drawer = await waitFor(() => document.querySelector('.drawer') as HTMLElement | null);
    expect(drawer?.textContent ?? '').not.toContain('Resolved balance');
  });

  it('disables lifecycle actions that do not match the client status', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [
            {
              id: 'cl_active_for_lifecycle_gate',
              organization_id: 'org_rashed',
              name: 'Active Client',
              slug: 'active-client',
              status: 'active',
              sla_tier: 'standard',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'client_summary') {
        return {
          rows: [
            {
              client_id: 'cl_active_for_lifecycle_gate',
              sender_count: 0,
              recipient_count: 0,
              active_shipments: 0,
              total_shipments: 0,
              contract_active: true,
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
    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);

    const reactivate = await screen.findByRole('option', { name: /^Reactivate/ });
    expect(reactivate).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Only suspended clients can be reactivated.')).toBeInTheDocument();

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
          rows: [
            {
              id: 'cl_active_for_suspend_empty',
              organization_id: 'org_rashed',
              name: 'Suspend Empty Client',
              slug: 'suspend-empty-client',
              status: 'active',
              sla_tier: 'standard',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'client_summary') {
        return {
          rows: [
            {
              client_id: 'cl_active_for_suspend_empty',
              sender_count: 0,
              recipient_count: 0,
              active_shipments: 0,
              total_shipments: 0,
              contract_active: true,
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
    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

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
//   • public.client_create_v1 — supabase/migrations/202604301000_client_create_v1.sql
//   • public.client_update_v1 — supabase/migrations/202604301010_client_update_v1.sql
describe('ClientsModule · create/update wiring (Wave 6)', () => {
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
    createSpy = vi.spyOn(apiMod, 'client_create_v1') as unknown as LooseSpy;
    updateSpy = vi.spyOn(apiMod, 'client_update_v1') as unknown as LooseSpy;
  });
  afterEach(() => {
    createSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it('New client modal fires client_create_v1 with canonical payload', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ClientsModule />, {
      identity: {
        capabilities: ['clients.read', 'clients.write'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    const newBtn = await screen.findByRole('button', { name: /New client/ });
    await user.click(newBtn);

    const name = await screen.findByLabelText('Name');
    await user.type(name, 'B6 New Client');
    const slug = await screen.findByLabelText('Slug');
    await user.type(slug, 'b6-new-client');
    const create = await screen.findByRole('button', { name: 'Create' });
    await user.click(create);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    const args = createSpy.mock.calls[0]?.[0] as
      | { name?: string; slug?: string; sla_tier?: string; organization_id?: string }
      | undefined;
    expect(args?.name).toBe('B6 New Client');
    expect(args?.slug).toBe('b6-new-client');
    expect(args?.sla_tier).toBeTruthy();
    expect(args?.organization_id).toBe('org_swift');
  });

  it('New client create shows backend readback in the table without reload', async () => {
    const user = userEvent.setup();
    const newClientName = 'No Reload Create Client';
    let clientRows: Array<Record<string, unknown>> = [];
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: clientRows, total: clientRows.length, page: 0, page_size: 100 };
      }
      if (resource === 'client_summary') {
        return {
          rows: clientRows.map((row) => ({
            client_id: row.id,
            sender_count: 0,
            recipient_count: 0,
            active_shipments: 0,
            total_shipments: 0,
            contract_active: true,
            has_warehouse: false,
          })),
          total: clientRows.length,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    createSpy.mockImplementation(async (args: unknown) => {
      const payload = args as Record<string, unknown>;
      clientRows = [
        {
          id: 'cl_no_reload_create',
          organization_id: 'org_rashed',
          name: payload.name,
          slug: payload.slug,
          status: 'active',
          sla_tier: payload.sla_tier ?? 'standard',
        },
      ];
      return clientRows[0] as never;
    });

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    expect(screen.queryByText(newClientName)).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /New client/ }));
    await user.type(await screen.findByLabelText('Name'), newClientName);
    await user.type(await screen.findByLabelText('Slug'), 'no-reload-create-client');
    await user.click(await screen.findByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getAllByText(newClientName).length).toBeGreaterThan(1);
    });
    expect(screen.queryByRole('dialog', { name: /New client/i })).not.toBeInTheDocument();
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).toContain(newClientName);
    expect(drawerText).toContain('Client settings');
    expect(drawerText).toContain('Quick links');
  });

  it('New client duplicate slug surfaces operator-friendly error copy', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    createSpy.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "clients_organization_id_slug_key"'));

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    await user.click(await screen.findByRole('button', { name: /New client/ }));
    await user.type(await screen.findByLabelText('Name'), 'Duplicate Slug Client');
    await user.type(await screen.findByLabelText('Slug'), 'exampleparcel-ksa');
    await user.click(await screen.findByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        'A client with this slug already exists for the selected tenant.',
        'danger',
      );
    });
    const dialog = screen.getByRole('dialog', { name: /New client/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('A client with this slug already exists for the selected tenant.')).toBeInTheDocument();
  });

  it('drawer client edits fire client_update_v1 and keep slug read-only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const row = await screen.findByText(/Exampleparcel KSA/);
    await user.click(row);

    const nameRow = Array.from(document.querySelectorAll('.kvgrid__row'))
      .find((el) => el.textContent?.includes('Name')) as HTMLElement | undefined;
    expect(nameRow).toBeTruthy();
    const nameValue = nameRow!.querySelector('.kvgrid__val') as HTMLElement;
    await user.click(nameValue);
    const editInput = nameRow!.querySelector('input.dt-inline-input') as HTMLInputElement;
    await user.clear(editInput);
    await user.type(editInput, 'Exampleparcel KSA Updated{Enter}');

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ client_id: expect.any(String), name: 'Exampleparcel KSA Updated' }),
      );
    });

    const slugRow = Array.from(document.querySelectorAll('.kvgrid__row'))
      .find((el) => el.textContent?.includes('Slug')) as HTMLElement | undefined;
    expect(slugRow).toBeTruthy();
    expect(slugRow!.querySelector('.kvgrid__val--editable')).toBeNull();
  });

  it('drawer client edits refresh the open drawer from backend readback without reload', async () => {
    const user = userEvent.setup();
    let clientName = 'Drawer Readback Client Original';
    const updatedName = 'Drawer Readback Client Updated';
    const realList = apiMod.ui_list_resource_v1;
    const clientRow = () => ({
      id: 'cl_drawer_readback',
      organization_id: 'org_rashed',
      name: clientName,
      slug: 'drawer-readback-client',
      status: 'active',
      sla_tier: 'standard',
      settings_override: {},
    });

    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [clientRow()], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'client_summary') {
        return {
          rows: [
            {
              client_id: 'cl_drawer_readback',
              sender_count: 1,
              recipient_count: 1,
              active_shipments: 0,
              total_shipments: 0,
              contract_active: true,
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
    updateSpy.mockImplementation(async (args: unknown) => {
      clientName = String((args as Record<string, unknown>).name ?? clientName);
      return { ok: true, client_id: 'cl_drawer_readback' } as never;
    });

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    await user.click(await screen.findByText(clientName));
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain(clientName);
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
    expect(drawer.textContent ?? '').not.toContain('Drawer Readback Client Original');
  });

  it('table SLA edit rejects stale backend readback instead of showing local-only success', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const clientRow = {
      id: 'cl_inline_sla_stale_readback',
      organization_id: 'org_rashed',
      name: 'Inline SLA Stale Readback Client',
      slug: 'inline-sla-stale-readback-client',
      status: 'active',
      sla_tier: 'standard',
      settings_override: {},
    };

    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return { rows: [clientRow], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'client_summary') {
        return {
          rows: [
            {
              client_id: 'cl_inline_sla_stale_readback',
              sender_count: 0,
              recipient_count: 0,
              active_shipments: 0,
              total_shipments: 0,
              contract_active: true,
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
    updateSpy.mockResolvedValue({
      ok: true,
      client_id: 'cl_inline_sla_stale_readback',
      idempotent_no_op: false,
    });

    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    const row = (await screen.findByText('Inline SLA Stale Readback Client')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent(/standard/i);
    const slaCell = within(row).getByText(/standard/i).closest('td') as HTMLElement;
    await user.dblClick(slaCell);
    await user.click(await screen.findByRole('option', { name: /^Premium/ }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: 'cl_inline_sla_stale_readback',
          sla_tier: 'premium',
        }),
      );
    });
    expect(row).toHaveTextContent(/standard/i);
    expect(row).not.toHaveTextContent(/premium/i);
    expect(window.location.pathname).toBe('/customers/clients');
  });

  it('exposes client_create_v1 + client_update_v1 facades (canonical RPC names)', () => {
    expect(typeof apiMod.client_create_v1).toBe('function');
    expect(typeof apiMod.client_update_v1).toBe('function');
  });

  it('Create button blocked when capability missing', async () => {
    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read'] });
    const newBtn = await screen.findByRole('button', { name: /New client/ });
    expect(newBtn).toBeDisabled();
  });
});

// ---- WAVE 21 paired projection wiring (CUSTOMERS W21) ----
// Drawer surfaces canonical projection-derived counters from
// `public.v_client_summary` (sender_count, recipient_count, active_shipments,
// total_shipments, contract_active, has_warehouse). Read-only; SSOT remains
// `public.clients` via the registry seam. See:
//   • supabase/migrations/202604302000_v_client_summary.sql
//   • apps/console-v2/src/lib/data-source.ts → _projectClientSummary
describe('ClientsModule · paired projection wiring (W21)', () => {
  it('drawer surfaces sender_count + recipient_count from client_summary', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ClientsModule />, { capabilities: ['clients.read', 'clients.write'] });

    const row = await screen.findByText(/Exampleparcel KSA/);
    await user.click(row);

    await waitFor(() => {
      // Counter chips render through the canonical projection seam.
      // Match patterns "<n> senders" + "<n> recipients" rather than exact
      // counts (counts are seed-data-driven and may change).
      expect(screen.getByText(/\d+ senders/)).toBeInTheDocument();
      expect(screen.getByText(/\d+ recipients/)).toBeInTheDocument();
      expect(screen.getByText(/\d+ active · \d+ total shipments/)).toBeInTheDocument();
    });
  });
});
