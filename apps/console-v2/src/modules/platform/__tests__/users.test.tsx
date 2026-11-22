// users.test.tsx — verifies the users admin module mounts under capability
// gates, renders the canonical projection, surfaces the 5-tab drawer
// (Profile / Roles / Capabilities / Devices / Sessions), and routes Grant role
// / Revoke role / Suspend / Reactivate / Force-password-reset / device revoke
// / session revoke through the canonical hook layer.
//
// Capability key SSOT: backend migration
//   supabase/migrations/202601022113_access_control_policy_core.sql:216-217
// Canonical RPC SSOT: backend migration
//   public.ui_execute_user_device_revoke_v1 (device governance command)
//   public.ui_list_user_sessions_v1 (auth session readback)
//   public.user_capability_eval_v1 (access_control_policy_core.sql:764)
//
// Lifecycle actions (grant_role / revoke_role / suspend / reactivate /
// force_password_reset) route through canonical Phase C6 *_v1 RPCs per
// supabase/migrations/202604300300..202604300340 (W37-IDENTITY closure).
// The tests below spy on each canonical RPC facade
// (`api.grant_user_role_v1`, `api.revoke_user_role_v1`,
// `api.suspend_user_v1`, `api.reactivate_user_v1`,
// `api.force_password_reset_v1`) and assert canonical args land at the
// adapter boundary.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  renderWithProviders as baseRenderWithProviders,
  type RenderWithProvidersOptions,
} from '@/test/render';
import { UsersModule } from '@/modules/platform/users';
import * as api from '@/lib/api';
import * as toastStore from '@/components/toastStore';

function renderWithProviders(
  ui: Parameters<typeof baseRenderWithProviders>[0],
  opts: RenderWithProvidersOptions = {},
) {
  if (opts.identity !== undefined || !opts.capabilities) {
    return baseRenderWithProviders(ui, opts);
  }
  return baseRenderWithProviders(ui, {
    ...opts,
    capabilities: undefined,
    identity: {
      capabilities: opts.capabilities,
      user: {
        access_scope_type: 'tenant',
        access_scope_id: null,
        organization_id: 'org_rashed',
      },
      scope: {
        tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
      },
    },
  });
}

describe('UsersModule', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    toastStore.clearToasts();
    window.history.replaceState({}, '', '/');
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // ── 1. mount + capability gating ───────────────────────────────────
  it('renders the page header + KPI strip when granted users.read', async () => {
    renderWithProviders(<UsersModule />, { capabilities: ['users.read'] });
    expect(await screen.findByTestId('users-page')).toBeInTheDocument();
    expect(await screen.findByTestId('users-kpi-strip')).toBeInTheDocument();
  });

  it('shows denied state when users.read is missing (capability gate · negative)', async () => {
    const completeListSpy = vi.spyOn(api, 'ui_list_resource_complete');
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    renderWithProviders(<UsersModule />, { capabilities: [] });
    // The capability-denied StateView surfaces the canonical hint.
    expect(
      await screen.findByText(/User management requires user access permission/i),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        completeListSpy.mock.calls.filter(([resource]) =>
          ['users', 'user_directory'].includes(String(resource)),
        ),
      ).toEqual([]);
      expect(
        listSpy.mock.calls.filter(([resource]) => String(resource) === 'lookup_values'),
      ).toEqual([]);
    });
  });

  it('shows status filter chips and the DataTable when granted users.read (capability gate · positive)', async () => {
    renderWithProviders(<UsersModule />, { capabilities: ['users.read'] });
    expect(await screen.findByTestId('users-status-all')).toBeInTheDocument();
    expect(screen.getByTestId('users-status-active')).toBeInTheDocument();
    expect(screen.getByTestId('users-status-invited')).toBeInTheDocument();
    expect(screen.getByTestId('users-status-suspended')).toBeInTheDocument();
  });

  it('scopes user and directory reads to the active tenant lens', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');
    renderWithProviders(<UsersModule />, {
      identity: {
        capabilities: ['users.read', 'users.manage'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });
    expect(await screen.findByTestId('users-page')).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'user_directory',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
    });
    expect(screen.queryByText(/Layla Bin Saeed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Rashed Al-Otaibi/i)).not.toBeInTheDocument();
  });

  // ── 2. drawer mount ────────────────────────────────────────────────
  it('opens a focused user drawer from the approved tenant access handoff URL', async () => {
    window.history.replaceState({}, '', '/platform/users?organization_id=org_rashed&focus=usr_ops_admin_layla');
    renderWithProviders(<UsersModule />, {
      identity: {
        capabilities: ['users.read', 'users.manage', 'access_policy.read'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_platform',
        },
        scope: { tenant: { id: 'org_platform', label: 'MasarX Platform', rank: 2 } },
      },
    });

    const drawer = await screen.findByTestId('users-drawer');
    expect(drawer).toHaveTextContent(/Layla Bin Saeed/i);
    expect(drawer).toHaveTextContent(/layla\.ops@rashed-logistics\.example/i);
    expect(screen.getByTestId('users-page')).toHaveTextContent(/Tenant handoff active/i);
  });

  it('fails closed when the canonical users read rejects', async () => {
    const realList = api.ui_list_resource_complete;
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'users') throw new Error('api.users unavailable');
      return realList(resource, opts);
    });

    try {
      renderWithProviders(<UsersModule />, { capabilities: ['users.read'] });
      expect(await screen.findByText(/Users read failed/i)).toBeInTheDocument();
      expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
      expect(screen.queryByText(/api.users unavailable/i)).toBeNull();
      expect(screen.queryByTestId('users-status-all')).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('Row click opens the 5-tab drawer (Profile / Roles / Capabilities / Devices / Sessions)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage', 'access_policy.read'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    expect(drawer).toBeInTheDocument();
    // All 5 tabs are present.
    expect(within(drawer).getByTestId('users-drawer-tab-profile')).toBeInTheDocument();
    expect(within(drawer).getByTestId('users-drawer-tab-roles')).toBeInTheDocument();
    expect(within(drawer).getByTestId('users-drawer-tab-capabilities')).toBeInTheDocument();
    expect(within(drawer).getByTestId('users-drawer-tab-devices')).toBeInTheDocument();
    expect(within(drawer).getByTestId('users-drawer-tab-sessions')).toBeInTheDocument();
    // Profile tab is the default.
    expect(within(drawer).getByTestId('users-drawer-profile')).toBeInTheDocument();
  });

  // ── 3. Grant role ──────────────────────────────────────────────────
  // W37 — re-targeted to canonical `grant_user_role_v1` RPC per
  // supabase/migrations/202604300300_grant_user_role_v1.sql (was previously
  // routed through `runCommand('users.grant_role', ...)` substrate). Closes
  // REAUDIT4 IDENTITY P1.
  it('Grant role invokes canonical grant_user_role_v1 RPC with target_user_id + role_key', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'grant_user_role_v1').mockResolvedValue({
      ok: true,
      target_user_id: 'usr_ops_admin_layla',
      role_key: 'finance',
      user_role_assignment_id: 'ura_test',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    const { queryClient } = renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-roles'));
    const financeRow = await screen.findByTestId('users-role-row-finance');
    const grantBtn = within(financeRow).getByRole('button', { name: /Grant role finance/i });
    await user.click(grantBtn);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const args = spy.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      target_user_id: 'usr_ops_admin_layla',
      role_key: 'finance',
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['list', 'users'] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['list', 'user_directory'] }),
      );
    });
  });

  // ── 4. Revoke role ─────────────────────────────────────────────────
  it('Revoke role invokes canonical revoke_user_role_v1 RPC for the active role', async () => {
    const user = userEvent.setup();
    const realList = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource !== 'user_directory') return result;
      return {
        ...result,
        rows: result.rows.map((row) => {
          if (String(row.id) !== 'usr_ops_admin_layla') return row;
          return {
            ...row,
            active_role_count: 1,
            active_role_keys: ['ops_admin'],
          };
        }),
      };
    });
    const spy = vi.spyOn(api, 'revoke_user_role_v1').mockResolvedValue({
      ok: true,
      target_user_id: 'usr_ops_admin_layla',
      role_key: 'ops_admin',
    });
    const { queryClient } = renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-roles'));
    const opsRow = await screen.findByTestId('users-role-row-ops_admin');
    const revokeBtn = within(opsRow).getByRole('button', { name: /Revoke role ops_admin/i });
    await user.click(revokeBtn);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const args = spy.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      target_user_id: 'usr_ops_admin_layla',
      role_key: 'ops_admin',
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['list', 'users'] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['list', 'user_directory'] }),
      );
    });
  });

  // ── 5. Suspend ────────────────────────────────────────────────────
  it('Roles tab does not treat immutable user_type as an active RBAC assignment', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-roles'));
    expect(within(drawer).getByTestId('users-active-role-rollup')).toHaveTextContent(
      /No active RBAC roles/i,
    );
    expect(
      within(await screen.findByTestId('users-role-row-ops_admin')).getByRole('button', {
        name: /Grant role ops_admin/i,
      }),
    ).toBeEnabled();
  });

  it('Suspend invokes canonical suspend_user_v1 RPC and keeps drawer context open', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'suspend_user_v1').mockResolvedValue({
      ok: true,
      target_user_id: 'usr_ops_admin_layla',
      status: 'suspended',
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    const actions = within(drawer).getByTestId('users-drawer-actions');
    const suspendBtn = within(actions).getByRole('button', { name: /Suspend/i });
    await user.click(suspendBtn);
    const confirm = await screen.findByTestId('users-suspend-confirm');
    await user.type(within(confirm).getByLabelText(/^Reason$/i), 'Security review');
    await user.click(within(confirm).getByRole('button', { name: /Confirm suspend/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const args = spy.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      target_user_id: 'usr_ops_admin_layla',
      reason: 'Security review',
    });
    expect(await screen.findByTestId('users-drawer')).toBeInTheDocument();
  });

  it('Suspend shows backend status readback in the users table and drawer without reload', async () => {
    const user = userEvent.setup();
    let suspended = false;
    const realComplete = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (!suspended || (resource !== 'users' && resource !== 'user_directory')) return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).id) === 'usr_ops_admin_layla'
            ? { ...row, status: 'suspended' }
            : row,
        ),
      };
    });
    const spy = vi.spyOn(api, 'suspend_user_v1').mockImplementation(async () => {
      suspended = true;
      return {
        ok: true,
        target_user_id: 'usr_ops_admin_layla',
        status: 'suspended',
      };
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByRole('button', { name: /Suspend/i }));
    const confirm = await screen.findByTestId('users-suspend-confirm');
    await user.type(within(confirm).getByLabelText(/^Reason$/i), 'Backend readback proof');
    await user.click(within(confirm).getByRole('button', { name: /Confirm suspend/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(async () => {
      const updatedDrawer = await screen.findByTestId('users-drawer');
      expect(within(updatedDrawer).getByRole('button', { name: /Reactivate/i })).toBeInTheDocument();
      expect(await screen.findByTestId('users-drawer-lifecycle-readback')).toHaveTextContent(
        /Saved data confirms .* is suspended/i,
      );
    });
    await user.click(screen.getByLabelText(/Close/i));
    await waitFor(() => {
      const updatedRow = screen.getByText(/Layla Bin Saeed/i).closest('tr')!;
      expect(updatedRow).toHaveTextContent(/suspended/i);
    });
  });

  // ── 6. Reactivate ─────────────────────────────────────────────────
  it('Reactivate invokes canonical reactivate_user_v1 RPC when target is suspended', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'reactivate_user_v1').mockResolvedValue({
      ok: true,
      target_user_id: 'usr_client_admin_examplemart',
      status: 'active',
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const suspendedTab = await screen.findByTestId('users-status-suspended');
    await user.click(suspendedTab);
    const row = (await screen.findByText(/Khalid Al-Mutairi/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    const actions = within(drawer).getByTestId('users-drawer-actions');
    const reactivateBtn = within(actions).getByRole('button', { name: /Reactivate/i });
    await user.click(reactivateBtn);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const args = spy.mock.calls[0]?.[0];
    expect(args).toMatchObject({ target_user_id: 'usr_client_admin_examplemart' });
  });

  it('Reactivate shows backend status readback in the users table and drawer without reload', async () => {
    const user = userEvent.setup();
    let reactivated = false;
    const realComplete = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (!reactivated || (resource !== 'users' && resource !== 'user_directory')) return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).id) === 'usr_client_admin_examplemart'
            ? { ...row, status: 'active' }
            : row,
        ),
      };
    });
    const spy = vi.spyOn(api, 'reactivate_user_v1').mockImplementation(async () => {
      reactivated = true;
      return {
        ok: true,
        target_user_id: 'usr_client_admin_examplemart',
        status: 'active',
      };
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    await user.click(await screen.findByTestId('users-status-suspended'));
    const row = (await screen.findByText(/Khalid Al-Mutairi/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByRole('button', { name: /Reactivate/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(async () => {
      const updatedDrawer = await screen.findByTestId('users-drawer');
      expect(within(updatedDrawer).getByRole('button', { name: /Suspend/i })).toBeInTheDocument();
      expect(await screen.findByTestId('users-drawer-lifecycle-readback')).toHaveTextContent(
        /Saved data confirms .* is active/i,
      );
    });
    await user.click(screen.getByLabelText(/Close/i));
    await user.click(await screen.findByTestId('users-status-all'));
    await waitFor(() => {
      const updatedRow = screen.getByText(/Khalid Al-Mutairi/i).closest('tr')!;
      expect(updatedRow).toHaveTextContent(/active/i);
    });
  });

  // ── 7. Force password reset ────────────────────────────────────────
  it('Bulk suspend reports partial backend failures without claiming full success', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const spy = vi.spyOn(api, 'suspend_user_v1').mockImplementation(async (args) => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, target_user_id: args.target_user_id, status: 'suspended' };
      }
      throw new Error('policy denied');
    });

    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    expect(await screen.findByTestId('users-page')).toBeInTheDocument();
    await screen.findByTestId('users-status-all');
    const checkboxes = screen.getAllByLabelText('Select row');
    await user.click(checkboxes[0]!);
    await user.click(checkboxes[1]!);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Suspend$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const messages = toastStore.getToasts().map((toast) => toast.message).join('\n');
      expect(messages).toMatch(/1\/2 user\(s\) suspended/i);
      expect(messages).toMatch(/1\/2 user\(s\) were not suspended/i);
      expect(messages).toMatch(/Suspend failed/i);
      expect(messages).not.toMatch(/^2 user\(s\) suspended$/im);
    });
  });

  it('Bulk reactivate reports partial backend failures without claiming full success', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const spy = vi.spyOn(api, 'reactivate_user_v1').mockImplementation(async (args) => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, target_user_id: args.target_user_id, status: 'active' };
      }
      throw new Error('user locked');
    });

    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    expect(await screen.findByTestId('users-page')).toBeInTheDocument();
    await screen.findByTestId('users-status-all');
    const checkboxes = screen.getAllByLabelText('Select row');
    await user.click(checkboxes[0]!);
    await user.click(checkboxes[1]!);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Reactivate$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const messages = toastStore.getToasts().map((toast) => toast.message).join('\n');
      expect(messages).toMatch(/1\/2 user\(s\) reactivated/i);
      expect(messages).toMatch(/1\/2 user\(s\) were not reactivated/i);
      expect(messages).toMatch(/Reactivate failed/i);
      expect(messages).not.toMatch(/^2 user\(s\) reactivated$/im);
    });
  });

  it('Force password reset shows backend readback evidence in the same drawer without reload', async () => {
    const user = userEvent.setup();
    let resetVisible = false;
    const actionsSpy = vi.spyOn(api, 'ui_list_user_security_actions_v1').mockImplementation(
      async (targetUserId, limit) => ({
        rows: resetVisible
          ? [
              {
                id: 'dlog_reset_layla',
                organization_id: 'org_rashed',
                timestamp: '2026-05-11T09:15:00.000Z',
                decision_category: 'users.force_password_reset',
                decision_point: 'force_password_reset_v1',
                decision_outcome: 'pending',
                resource_type: 'user',
                resource_id: targetUserId,
                correlation_id: '00000000-0000-0000-0000-00000000fpr1',
                password_reset_intent_id: 'pri_layla_reset',
                decision_inputs: {
                  password_reset_intent_id: 'pri_layla_reset',
                  reason: 'Operator requested reset',
                },
              },
            ]
          : [],
        total: resetVisible ? 1 : 0,
        page: 0,
        page_size: limit ?? 5,
      }),
    );
    const spy = vi.spyOn(api, 'force_password_reset_v1').mockImplementation(async () => {
      resetVisible = true;
      return {
        ok: true,
        target_user_id: 'usr_ops_admin_layla',
        password_reset_intent_id: 'pri_layla_reset',
        status: 'pending',
      };
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    const actions = within(drawer).getByTestId('users-drawer-actions');
    const profileTab = within(drawer).getByTestId('users-drawer-tab-profile');
    expect(await within(drawer).findByText(/No security actions yet/i)).toBeInTheDocument();
    const resetBtn = within(actions).getByRole('button', { name: /Force password reset/i });
    await user.click(resetBtn);
    const confirm = await screen.findByTestId('users-force-password-reset-confirm');
    await user.type(within(confirm).getByLabelText(/Reason/i), 'Security review');
    await user.click(within(confirm).getByRole('button', { name: /Confirm reset/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const args = spy.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      target_user_id: 'usr_ops_admin_layla',
      email: 'layla.ops@rashed-logistics.example',
      reason: 'Security review',
    });
    await waitFor(() => {
      expect(actionsSpy).toHaveBeenCalledWith('usr_ops_admin_layla', 5);
    });
    const securityAction = await within(drawer).findByTestId('users-security-action-dlog_reset_layla');
    expect(within(securityAction).getByText(/Password reset requested/i)).toBeInTheDocument();
    expect(within(securityAction).getByText(/pri_layla_reset/i)).toBeInTheDocument();
    expect(within(securityAction).getByText(/pending/i)).toBeInTheDocument();
    expect(profileTab).toHaveAttribute('aria-selected', 'true');
  });

  // -- 8. Devices tab uses user_device_summary -----------------------
  it('Devices tab uses the backend-backed user_device_summary list with empty-state coverage', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage', 'user_devices.read', 'user_devices.write'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-devices'));
    const devicesContainer = await screen.findByTestId('users-drawer-devices');
    expect(await within(devicesContainer).findByTestId('user-devices-list')).toBeInTheDocument();
    expect(await within(devicesContainer).findByText(/No registered devices/i)).toBeInTheDocument();
  });

  it('Devices tab shows revoked backend readback without reloading the drawer', async () => {
    const user = userEvent.setup();
    let revoked = false;
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource !== 'user_device_summary') return realList(resource, opts);
      return {
        rows: [
          {
            id: 'dev_layla_ops',
            organization_id: 'org_rashed',
            user_id: 'usr_ops_admin_layla',
            device_platform: 'ios',
            platform: 'ios',
            device_identifier_sha256: 'IOS-LAYLA-OPS-01',
            device_id: 'IOS-LAYLA-OPS-01',
            device_label: 'Layla ops iPhone',
            app_version: '1.42.0',
            os_version: '17.5',
            last_seen_at: '2026-05-11T08:00:00.000Z',
            model: 'iPhone 15',
            attestation_status: 'trusted',
            revoked_at: revoked ? '2026-05-11T08:15:00.000Z' : null,
            revoked_reason: revoked ? 'Security rotation' : null,
            is_revoked: revoked,
            push_token_cleared: revoked,
            metadata: { model: 'iPhone 15', attestation: { status: 'trusted' } },
          },
        ],
        total: 1,
        source: 'test',
      };
    });
    const revokeSpy = vi.spyOn(api, 'ui_execute_user_device_revoke_v1').mockImplementation(async () => {
      revoked = true;
      return {
        ok: true,
        action_key: 'user_devices.revoke',
        resource_key: 'user_devices',
        status: 'revoked',
        device_id: 'IOS-LAYLA-OPS-01',
        revoked_at: '2026-05-11T08:15:00.000Z',
        count: 1,
      };
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage', 'user_devices.read', 'user_devices.write'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-devices'));
    const devicesContainer = await screen.findByTestId('users-drawer-devices');
    const deviceRow = await within(devicesContainer).findByTestId('user-devices-list-item-dev_layla_ops');
    await user.click(within(deviceRow).getByRole('button', { name: /Revoke device IOS-LAYLA-OPS-01/i }));
    const form = await within(deviceRow).findByTestId('user-devices-revoke-form-dev_layla_ops');
    await user.type(within(form).getByLabelText(/Revocation reason/i), 'Security rotation');
    await user.click(within(form).getByRole('button', { name: /Confirm revoke/i }));

    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith('dev_layla_ops', 'Security rotation'));
    const updatedRow = await within(devicesContainer).findByTestId('user-devices-list-item-dev_layla_ops');
    expect(
      await within(updatedRow).findByTestId('user-devices-revoked-state-dev_layla_ops'),
    ).toHaveTextContent(/Reason: Security rotation/i);
    expect(within(updatedRow).getByRole('button', { name: /Revoked/i })).toBeDisabled();
    expect(within(drawer).getByTestId('users-drawer-tab-devices')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  // ── 9. Capabilities tab mounts (drilldown via canonical evaluator) ──
  it('Sessions tab shows pending revoke backend readback without reloading the drawer', async () => {
    const user = userEvent.setup();
    const sessionId = 'ssn_layla_ops_console';
    let revoked = false;
    const actionsSpy = vi.spyOn(api, 'ui_list_user_security_actions_v1').mockImplementation(
      async (targetUserId, limit) => ({
        rows:
          revoked && targetUserId === 'usr_ops_admin_layla'
            ? [
                {
                  id: 'dlog_layla_session_revoke',
                  organization_id: 'org_rashed',
                  timestamp: '2026-05-11T08:25:00.000Z',
                  decision_category: 'sessions.revoke',
                  decision_point: 'revoke_session_v1',
                  decision_outcome: 'pending',
                  resource_type: 'user',
                  resource_id: targetUserId,
                  correlation_id: 'corr_layla_session',
                  decision_inputs: {
                    session_id: sessionId,
                    reason: 'Operator security rotation',
                  },
                  action_reason: 'Operator security rotation',
                },
              ]
            : [],
        total: revoked && targetUserId === 'usr_ops_admin_layla' ? 1 : 0,
        page: 0,
        page_size: limit ?? 5,
      }),
    );
    const listSpy = vi.spyOn(api, 'ui_list_user_sessions_v1').mockImplementation(
      async (targetUserId, limit) => ({
        rows:
          targetUserId === 'usr_ops_admin_layla'
            ? [
                {
                  id: sessionId,
                  user_id: 'usr_ops_admin_layla',
                  organization_id: 'org_rashed',
                  user_email: 'layla.ops@rashed-logistics.example',
                  user_agent: 'Chrome Drawer Proof',
                  ip: '127.0.0.1',
                  aal: 'aal2',
                  created_at: '2026-05-11T08:00:00.000Z',
                  updated_at: '2026-05-11T08:20:00.000Z',
                  last_seen_at: '2026-05-11T08:20:00.000Z',
                  is_current: false,
                  revocation_audit_id: revoked ? 'rva_layla_session' : null,
                  revocation_status: revoked ? 'pending' : null,
                  revocation_reason: revoked ? 'Operator security rotation' : null,
                  revocation_requested_at: revoked ? '2026-05-11T08:25:00.000Z' : null,
                  revocation_correlation_id: revoked ? 'corr_layla_session' : null,
                },
              ]
            : [],
        total: targetUserId === 'usr_ops_admin_layla' ? 1 : 0,
        page: 0,
        page_size: limit ?? 50,
      }),
    );
    const revokeSpy = vi.spyOn(api, 'revoke_session_v1').mockImplementation(async (args) => {
      revoked = true;
      return {
        ok: true,
        revocation_audit_id: 'rva_layla_session',
        target_user_id: args.target_user_id,
        status: 'pending',
        correlation_id: 'corr_layla_session',
      };
    });
    const { queryClient } = renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-sessions'));
    const sessionsContainer = await screen.findByTestId('users-drawer-sessions');
    const sessionRow = await within(sessionsContainer).findByTestId(`sessions-list-item-${sessionId}`);
    await user.click(within(sessionRow).getByLabelText(`Revoke session ${sessionId}`));
    const sessionRevokeForm = await within(sessionRow).findByTestId(`sessions-list-revoke-form-${sessionId}`);
    await user.type(within(sessionRevokeForm).getByLabelText(/Revocation reason/i), 'Operator security rotation');
    await user.click(within(sessionRevokeForm).getByRole('button', { name: /Confirm revoke/i }));

    await waitFor(() =>
      expect(revokeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          target_user_id: 'usr_ops_admin_layla',
          session_id: sessionId,
          reason: 'Operator security rotation',
        }),
      ),
    );
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith('usr_ops_admin_layla', 50);
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'users'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'user_directory'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'users', 'complete'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'user_directory', 'complete'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['user_sessions'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['user_security_actions'],
        refetchType: 'active',
      }));
    });
    const updatedRow = await within(sessionsContainer).findByTestId(`sessions-list-item-${sessionId}`);
    expect(
      await within(updatedRow).findByTestId(`sessions-list-revocation-${sessionId}`),
    ).toHaveTextContent(/Revoke pending/i);
    expect(
      within(updatedRow).getByTestId(`sessions-list-revocation-${sessionId}`),
    ).toHaveTextContent(/Operator security rotation/i);
    expect(within(updatedRow).getByRole('button', { name: /Revoke pending/i })).toBeDisabled();
    expect(within(drawer).getByTestId('users-drawer-tab-sessions')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(within(drawer).getByTestId('users-drawer-tab-profile'));
    await waitFor(() => expect(actionsSpy).toHaveBeenCalledWith('usr_ops_admin_layla', 5));
    const securityAction = await within(drawer).findByTestId('users-security-action-dlog_layla_session_revoke');
    expect(within(securityAction).getByText(/Session revoke requested/i)).toBeInTheDocument();
    expect(within(securityAction).getByText(/Operator security rotation/i)).toBeInTheDocument();
    expect(within(securityAction).getByText(sessionId)).toBeInTheDocument();
  });

  it('Sessions tab requires a visible revocation reason before enabling revoke confirmation', async () => {
    const user = userEvent.setup();
    const sessionId = 'ssn_layla_ops_reason_required';
    vi.spyOn(api, 'ui_list_user_sessions_v1').mockResolvedValue({
      rows: [
        {
          id: sessionId,
          user_id: 'usr_ops_admin_layla',
          organization_id: 'org_rashed',
          user_email: 'layla.ops@rashed-logistics.example',
          user_agent: 'Chrome Reason Proof',
          ip: '127.0.0.1',
          aal: 'aal2',
          created_at: '2026-05-11T08:00:00.000Z',
          updated_at: '2026-05-11T08:20:00.000Z',
          last_seen_at: '2026-05-11T08:20:00.000Z',
          is_current: false,
        },
      ],
      total: 1,
    });
    const revokeSpy = vi.spyOn(api, 'revoke_session_v1');
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-sessions'));
    const sessionsContainer = await screen.findByTestId('users-drawer-sessions');
    const sessionRow = await within(sessionsContainer).findByTestId(`sessions-list-item-${sessionId}`);
    await user.click(within(sessionRow).getByLabelText(`Revoke session ${sessionId}`));
    const sessionRevokeForm = await within(sessionRow).findByTestId(`sessions-list-revoke-form-${sessionId}`);
    const confirm = within(sessionRevokeForm).getByRole('button', { name: /Confirm revoke/i });

    expect(await within(sessionRevokeForm).findByTestId(`sessions-list-revoke-reason-required-${sessionId}`))
      .toHaveTextContent(/Revocation reason is required/i);
    expect(confirm).toBeDisabled();
    await user.type(within(sessionRevokeForm).getByLabelText(/Revocation reason/i), '   ');
    expect(confirm).toBeDisabled();
    expect(revokeSpy).not.toHaveBeenCalled();

    await user.type(within(sessionRevokeForm).getByLabelText(/Revocation reason/i), 'Security review');
    expect(confirm).toBeEnabled();
  });

  it('Capabilities tab mounts the eval drilldown (uses user_capability_eval_v1 wiring)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage', 'access_policy.read'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-capabilities'));
    const capList = await screen.findByTestId('users-capabilities-list');
    expect(capList).toBeInTheDocument();
    // Filter narrows the row count.
    const filter = screen.getByTestId('users-capabilities-filter');
    fireEvent.change(filter, { target: { value: 'users.' } });
    // After filtering by `users.`, the row for users.manage / users.read
    // should be present (canonical resolved policy includes them per
    // access_control_policy_core.sql:216-217).
    const usersReadRow = await screen.findByTestId('users-capability-row-users.read');
    expect(usersReadRow).toBeInTheDocument();
  });

  it('Capabilities tab renders selected-user grants instead of current-operator grants', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'resolve_access_control_policy_v1').mockResolvedValue({
      policy: {
        capabilities: [
          { key: 'users.read', label: 'Users Read' },
          { key: 'users.manage', label: 'Users Manage' },
        ],
        roles: [
          {
            key: 'ops_admin',
            capability_keys: ['users.read'],
          },
        ],
      },
      settings_id: 'set_users_target_caps',
      settings_version_id: 'sv_users_target_caps',
      scope_type: 'tenant',
      scope_id: 'org_rashed',
      scope_path: [{ scope_type: 'tenant', scope_id: 'org_rashed' }],
      settings_resolution_id: 'sr_users_target_caps',
    });

    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage', 'access_policy.read'],
    });

    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-capabilities'));

    const manageRow = await screen.findByTestId('users-capability-row-users.manage');
    expect(manageRow).toHaveTextContent(/denied/i);
    expect(manageRow).not.toHaveTextContent(/granted/i);
  });

  // ── 10. Suspend disabled when users.manage is missing (negative) ────
  it('Capabilities tab is denied without resolving the access policy catalog when access_policy.read is missing', async () => {
    const user = userEvent.setup();
    const resolverSpy = vi.spyOn(api, 'resolve_access_control_policy_v1');
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByTestId('users-drawer-tab-capabilities'));
    expect(
      await screen.findByText(/Capability catalog inspection requires access policy permission/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('users-capabilities-list')).toBeNull();
    await waitFor(() => {
      expect(resolverSpy).not.toHaveBeenCalled();
    });
  });

  it('Suspend button is disabled when the operator lacks users.manage (capability gating)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersModule />, { capabilities: ['users.read'] });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    const actions = within(drawer).getByTestId('users-drawer-actions');
    // The CapabilityLock chip appends a `Requires users.manage` token to
    // the accessible name when the cap is missing.
    const suspendBtn = within(actions).getByRole('button', { name: /Suspend/i });
    expect(suspendBtn).toBeDisabled();
    expect(within(suspendBtn).getByText(/User management permission required/i)).toBeInTheDocument();
  });

  it('Invite user is disabled when the operator can read users but lacks users.manage', async () => {
    const user = userEvent.setup();
    const inviteSpy = vi.spyOn(api, 'tenant_user_invite_v1').mockResolvedValue({
      ok: true,
      user_id: 'usr_invite_denied_gap',
      email: 'invite.denied@example.com',
      role_key: 'ops_admin',
      status: 'invited',
    });
    renderWithProviders(<UsersModule />, { capabilities: ['users.read'] });

    const inviteButton = await screen.findByRole('button', { name: /Invite user/i });
    expect(inviteButton).toBeDisabled();
    expect(within(inviteButton).getByText(/User management permission required/i)).toBeInTheDocument();

    await user.click(inviteButton);
    expect(screen.queryByTestId('tenant-user-invite-form')).toBeNull();
    expect(inviteSpy).not.toHaveBeenCalled();
  });

  it('Lower-permission user reader keeps sensitive drawer actions disabled while read tabs stay visible', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'access_policy.read', 'user_devices.read'],
    });

    const inviteButton = await screen.findByRole('button', { name: /Invite user/i });
    expect(inviteButton).toBeDisabled();
    expect(within(inviteButton).getByText(/User management permission required/i)).toBeInTheDocument();

    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    const actions = within(drawer).getByTestId('users-drawer-actions');
    expect(within(actions).getByRole('button', { name: /Suspend/i })).toBeDisabled();
    expect(within(actions).getByRole('button', { name: /Force password reset/i })).toBeDisabled();
    expect(within(actions).getAllByText(/User management permission required/i).length).toBeGreaterThan(0);

    await user.click(within(drawer).getByTestId('users-drawer-tab-capabilities'));
    const filter = await screen.findByTestId('users-capabilities-filter');
    fireEvent.change(filter, { target: { value: 'users.manage' } });
    expect(await screen.findByTestId('users-capability-row-users.manage')).toHaveTextContent(/granted/i);
    fireEvent.change(filter, { target: { value: 'user_devices.write' } });
    expect(await screen.findByTestId('users-capability-row-user_devices.write')).toHaveTextContent(/granted/i);

    await user.click(within(drawer).getByTestId('users-drawer-tab-devices'));
    expect(await screen.findByTestId('users-drawer-devices')).toBeInTheDocument();
    expect(await screen.findByTestId('user-devices-list')).toBeInTheDocument();

    await user.click(within(drawer).getByTestId('users-drawer-tab-sessions'));
    expect(await screen.findByTestId('users-drawer-sessions')).toBeInTheDocument();
    expect(await screen.findByTestId('sessions-list')).toBeInTheDocument();
  });

  it('Invite user modal invokes tenant_user_invite_v1 with tenant RBAC role and scope', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'tenant_user_invite_v1').mockResolvedValue({
      ok: true,
      user_id: 'usr_invited_test',
      email: 'new.ops@example.com',
      role_key: 'ops_admin',
      status: 'invited',
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    await user.click(await screen.findByRole('button', { name: /Invite user/i }));
    const form = await screen.findByTestId('tenant-user-invite-form');
    const scopeSelect = within(form).getByLabelText(/^Access scope$/i) as HTMLSelectElement;
    await waitFor(() => expect(scopeSelect.value).toBe('tenant'));
    expect(Array.from(scopeSelect.options).map((option) => option.value)).toEqual(
      expect.arrayContaining(['platform', 'tenant', 'client', 'sender']),
    );
    await user.type(within(form).getByLabelText(/^Email$/i), 'new.ops@example.com');
    await user.type(within(form).getByLabelText(/^Name$/i), 'New Ops User');
    await user.click(within(form).getByRole('button', { name: /Send invite/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new.ops@example.com',
        full_name: 'New Ops User',
        role_key: 'ops_admin',
        organization_id: 'org_rashed',
        access_scope_type: 'tenant',
        access_scope_id: null,
        send_invite_email: true,
        invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
      }),
    );
  });

  it('Invite user selects a backend client reference and submits its id as access_scope_id', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'tenant_user_invite_v1').mockResolvedValue({
      ok: true,
      user_id: 'usr_invited_client_scope',
      email: 'client.scope@example.com',
      role_key: 'ops_admin',
      status: 'invited',
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    await user.click(await screen.findByRole('button', { name: /Invite user/i }));
    const form = await screen.findByTestId('tenant-user-invite-form');
    const scopeSelect = within(form).getByLabelText(/^Access scope$/i) as HTMLSelectElement;
    await waitFor(() => expect(scopeSelect).toBeEnabled());
    await user.selectOptions(scopeSelect, 'client');
    await waitFor(() => expect(scopeSelect).toHaveValue('client'));
    const search = within(form).getByLabelText(/^Client search$/i);
    await waitFor(() => expect(search).toBeEnabled());
    expect(within(form).queryByLabelText(/^Scope ID$/i)).not.toBeInTheDocument();
    await user.type(search, 'Exampleparcel');
    const clientSelect = within(form).getByLabelText(/^Client$/i) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(clientSelect.options).map((option) => option.value)).toContain('cl_exampleparcel_ksa'),
    );
    await user.selectOptions(clientSelect, 'cl_exampleparcel_ksa');
    await user.type(within(form).getByLabelText(/^Email$/i), 'client.scope@example.com');
    await user.type(within(form).getByLabelText(/^Name$/i), 'Client Scope User');
    await user.click(within(form).getByRole('button', { name: /Send invite/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'client.scope@example.com',
        full_name: 'Client Scope User',
        organization_id: 'org_rashed',
        access_scope_type: 'client',
        access_scope_id: 'cl_exampleparcel_ksa',
      }),
    );
  });

  it('Invite user selects a backend sender reference and submits its id as access_scope_id', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'tenant_user_invite_v1').mockResolvedValue({
      ok: true,
      user_id: 'usr_invited_sender_scope',
      email: 'sender.scope@example.com',
      role_key: 'ops_admin',
      status: 'invited',
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    await user.click(await screen.findByRole('button', { name: /Invite user/i }));
    const form = await screen.findByTestId('tenant-user-invite-form');
    const scopeSelect = within(form).getByLabelText(/^Access scope$/i);
    await waitFor(() => expect(scopeSelect).toBeEnabled());
    await user.selectOptions(scopeSelect, 'sender');
    const search = await within(form).findByLabelText(/^Sender search$/i);
    await waitFor(() => expect(search).toBeEnabled());
    expect(within(form).queryByLabelText(/^Scope ID$/i)).not.toBeInTheDocument();
    await user.type(search, 'JED');
    const senderSelect = within(form).getByLabelText(/^Sender$/i) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(senderSelect.options).map((option) => option.value)).toContain('snd_examplemarket_jed_warehouse'),
    );
    await user.selectOptions(senderSelect, 'snd_examplemarket_jed_warehouse');
    await user.type(within(form).getByLabelText(/^Email$/i), 'sender.scope@example.com');
    await user.type(within(form).getByLabelText(/^Name$/i), 'Sender Scope User');
    await user.click(within(form).getByRole('button', { name: /Send invite/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'sender.scope@example.com',
        full_name: 'Sender Scope User',
        organization_id: 'org_rashed',
        access_scope_type: 'sender',
        access_scope_id: 'snd_examplemarket_jed_warehouse',
      }),
    );
  });

  it('Invite user keeps submit disabled until the email has an address shape', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'tenant_user_invite_v1').mockResolvedValue({
      ok: true,
      user_id: 'usr_invited_invalid_email',
      email: 'invalid.ops@example.com',
      role_key: 'ops_admin',
      status: 'invited',
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    await user.click(await screen.findByRole('button', { name: /Invite user/i }));
    const form = await screen.findByTestId('tenant-user-invite-form');
    const email = within(form).getByLabelText(/^Email$/i);
    expect(email).toHaveAttribute('inputmode', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    await user.type(email, 'not-an-email');
    await user.type(within(form).getByLabelText(/^Name$/i), 'Invalid Email User');
    expect(within(form).getByRole('button', { name: /Send invite/i })).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Invite user opens the backend-created user drawer with invite security evidence without reload', async () => {
    const user = userEvent.setup();
    let invited = false;
    const realComplete = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (!invited || (resource !== 'users' && resource !== 'user_directory')) return result;
      const invitedRow = {
        id: 'usr_invited_visible',
        organization_id: 'org_rashed',
        email: 'visible.ops@example.com',
        full_name: 'Visible Ops User',
        user_type: 'ops_admin',
        access_scope_type: 'tenant',
        access_scope_id: null,
        status: 'invited',
        last_login_at: null,
        created_at: '2026-05-12T01:45:00.000Z',
        organization_label: 'Rashed Logistics',
        active_role_count: 1,
        active_role_keys: ['ops_admin'],
      };
      return {
        ...result,
        rows: [
          ...result.rows.filter((row) => String((row as Record<string, unknown>).id) !== invitedRow.id),
          invitedRow,
        ],
        total: (result.total ?? result.rows.length) + 1,
      };
    });
    const spy = vi.spyOn(api, 'tenant_user_invite_v1').mockImplementation(async (args) => {
      invited = true;
      return {
        ok: true,
        user_id: 'usr_invited_visible',
        email: args.email,
        role_key: args.role_key,
        status: 'invited',
        invite_email_sent: true,
      };
    });
    vi.spyOn(api, 'ui_list_user_security_actions_v1').mockImplementation(async (targetUserId, limit = 5) => ({
      rows: invited && targetUserId === 'usr_invited_visible'
        ? [
            {
              id: 'decision_invite_visible',
              organization_id: 'org_rashed',
              timestamp: '2026-05-20T17:15:00.000Z',
              decision_category: 'users.invite',
              decision_point: 'tenant_user_invite_apply_v1',
              decision_outcome: 'created',
              decision_inputs: {
                email: 'visible.ops@example.com',
                role_key: 'ops_admin',
                invite_email_sent: true,
                send_invite_email_requested: true,
                invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
              },
              resource_type: 'user',
              resource_id: String(targetUserId),
              correlation_id: '0f840000-0000-4000-8000-000000000992',
              role_key: 'ops_admin',
              invite_email: 'visible.ops@example.com',
              invite_email_sent: 'true',
              send_invite_email_requested: 'true',
              invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
            },
          ]
        : [],
      total: invited ? 1 : 0,
      page: 0,
      page_size: limit,
    }));
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    await user.click(await screen.findByRole('button', { name: /Invite user/i }));
    const form = await screen.findByTestId('tenant-user-invite-form');
    await user.type(within(form).getByLabelText(/^Email$/i), 'visible.ops@example.com');
    await user.type(within(form).getByLabelText(/^Name$/i), 'Visible Ops User');
    await user.click(within(form).getByRole('button', { name: /Send invite/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const invitedRow = await screen.findByText(/visible\.ops@example\.com/i, { selector: 'td' });
    expect(invitedRow.closest('tr')).toHaveTextContent(/invited/i);
    await waitFor(() => {
      expect(screen.queryByTestId('tenant-user-invite-form')).toBeNull();
    });
    const drawer = await screen.findByTestId('users-drawer');
    expect(await within(drawer).findByTestId('users-drawer-lifecycle-readback')).toHaveTextContent(
      /Invite decision was saved/i,
    );
    const evidence = await within(drawer).findByTestId('users-security-action-decision_invite_visible');
    expect(within(evidence).getByText(/Invite decision recorded/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/visible\.ops@example\.com/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/Email requested: true/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/Sent: true/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/^\- Redirect: https:\/\/unjijvxjrwurjgsnokovrvom\.example\.invalid\/auth\/callback$/)).toBeInTheDocument();
  });

  it('Resend invite stays in the drawer and surfaces backend evidence without reload', async () => {
    const user = userEvent.setup();
    let resent = false;
    const realComplete = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (resource !== 'user_directory') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).id) === 'usr_acct_mgr_huda'
            ? {
                ...row,
                active_role_count: 1,
                active_role_keys: ['ops_admin'],
              }
            : row,
        ),
      };
    });
    const inviteSpy = vi.spyOn(api, 'tenant_user_invite_v1').mockImplementation(async (args) => {
      resent = true;
      return {
        ok: true,
        user_id: 'usr_acct_mgr_huda',
        email: args.email,
        role_key: args.role_key,
        status: 'invited',
        invite_email_sent: true,
      };
    });
    vi.spyOn(api, 'ui_list_user_security_actions_v1').mockImplementation(async (targetUserId, limit = 5) => ({
      rows: resent
        ? [
            {
              id: 'decision_invite_resend_huda',
              organization_id: 'org_rashed',
              timestamp: '2026-05-20T16:15:00.000Z',
              decision_category: 'users.invite',
              decision_point: 'tenant_user_invite_apply_v1',
              decision_outcome: 'idempotent_existing_assignment',
              decision_inputs: {
                email: 'huda.am@rashed-logistics.example',
                role_key: 'ops_admin',
                invite_email_sent: true,
                send_invite_email_requested: true,
                invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
              },
              resource_type: 'user',
              resource_id: String(targetUserId),
              correlation_id: '0f840000-0000-4000-8000-000000000991',
              role_key: 'ops_admin',
              invite_email: 'huda.am@rashed-logistics.example',
              invite_email_sent: 'true',
              send_invite_email_requested: 'true',
              invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
            },
          ]
        : [],
      total: resent ? 1 : 0,
      page: 0,
      page_size: limit,
    }));

    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });

    const row = (await screen.findByText(/Huda Al-Subaie/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    const resend = within(drawer).getByRole('button', { name: /Resend invite/i });
    await user.click(resend);

    await waitFor(() => expect(inviteSpy).toHaveBeenCalled());
    expect(inviteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'huda.am@rashed-logistics.example',
        full_name: 'Huda Al-Subaie',
        role_key: 'ops_admin',
        organization_id: 'org_rashed',
        access_scope_type: 'tenant',
        access_scope_id: null,
        send_invite_email: true,
        invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
        resend_existing_invite: true,
      }),
    );
    expect(await within(drawer).findByTestId('users-drawer-lifecycle-readback')).toHaveTextContent(
      /Invite resend was saved/i,
    );
    const evidence = await within(drawer).findByTestId('users-security-action-decision_invite_resend_huda');
    expect(within(evidence).getByText(/Invite email resent/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/huda\.am@rashed-logistics\.example/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/Email requested: true/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/Sent: true/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/^\- Redirect: https:\/\/unjijvxjrwurjgsnokovrvom\.example\.invalid\/auth\/callback$/)).toBeInTheDocument();
    expect(within(drawer).getByTestId('users-security-actions')).toBeInTheDocument();
  });

  it('Resend invite fails closed when the drawer lacks active role readback', async () => {
    const user = userEvent.setup();
    const realComplete = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (resource !== 'user_directory') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).id) === 'usr_acct_mgr_huda'
            ? {
                ...row,
                active_role_count: 0,
                active_role_keys: [],
              }
            : row,
        ),
      };
    });
    const inviteSpy = vi.spyOn(api, 'tenant_user_invite_v1').mockResolvedValue({
      ok: true,
      user_id: 'usr_acct_mgr_huda',
      email: 'huda.am@rashed-logistics.example',
      role_key: 'ops_admin',
    });

    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });

    const row = (await screen.findByText(/Huda Al-Subaie/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByRole('button', { name: /Resend invite/i }));

    await waitFor(() => {
      expect(inviteSpy).not.toHaveBeenCalled();
      expect(toastStore.getToasts().some((toast) => /no active role is visible/i.test(toast.message))).toBe(true);
    });
  });

  it('labels historical invite rows without redirect evidence as not recorded', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'ui_list_user_security_actions_v1').mockImplementation(async (targetUserId, limit = 5) => ({
      rows: targetUserId === 'usr_acct_mgr_huda'
        ? [
            {
              id: 'decision_invite_historical_missing_redirect',
              organization_id: 'org_rashed',
              timestamp: '2026-05-20T15:45:00.000Z',
              decision_category: 'users.invite',
              decision_point: 'tenant_user_invite_apply_v1',
              decision_outcome: 'invited',
              decision_inputs: {
                email: 'huda.am@rashed-logistics.example',
                role_key: 'ops_admin',
                invite_email_sent: true,
                send_invite_email_requested: true,
              },
              resource_type: 'user',
              resource_id: String(targetUserId),
              correlation_id: '0f840000-0000-4000-8000-000000000994',
              role_key: 'ops_admin',
              invite_email: 'huda.am@rashed-logistics.example',
              invite_email_sent: 'true',
              send_invite_email_requested: 'true',
              invite_redirect_to: null,
            },
          ]
        : [],
      total: targetUserId === 'usr_acct_mgr_huda' ? 1 : 0,
      page: 0,
      page_size: limit,
    }));

    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });

    const row = (await screen.findByText(/Huda Al-Subaie/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    const evidence = await within(drawer).findByTestId('users-security-action-decision_invite_historical_missing_redirect');
    expect(within(evidence).getByText(/Redirect: not recorded/i)).toBeInTheDocument();
  });

  it('surfaces invite acceptance access evidence in the drawer', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'ui_list_user_security_actions_v1').mockImplementation(async (targetUserId, limit = 5) => ({
      rows: targetUserId === 'usr_acct_mgr_huda'
        ? [
            {
              id: 'decision_invite_accept_huda',
              organization_id: 'org_rashed',
              timestamp: '2026-05-20T18:05:00.000Z',
              decision_category: 'users.invite_accept',
              decision_point: 'tenant_user_invite_accept_v1',
              decision_outcome: 'accepted',
              decision_inputs: {
                email: 'huda.am@rashed-logistics.example',
                accepted_from_status: 'invited',
                accepted_to_status: 'active',
                access_scope_type: 'tenant',
                access_scope_id: null,
              },
              resource_type: 'user',
              resource_id: String(targetUserId),
              correlation_id: '0f840000-0000-4000-8000-000000000995',
              invite_email: 'huda.am@rashed-logistics.example',
              accepted_from_status: 'invited',
              accepted_to_status: 'active',
            },
          ]
        : [],
      total: targetUserId === 'usr_acct_mgr_huda' ? 1 : 0,
      page: 0,
      page_size: limit,
    }));

    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });

    const row = (await screen.findByText(/Huda Al-Subaie/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    const evidence = await within(drawer).findByTestId('users-security-action-decision_invite_accept_huda');
    expect(within(evidence).getByText(/Invite accepted/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/huda\.am@rashed-logistics\.example/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/Access: invited to active/i)).toBeInTheDocument();
  });

  it('refreshes drawer profile readback when an invited user was accepted outside the open table context', async () => {
    const user = userEvent.setup();
    const realComplete = api.ui_list_resource_complete;
    let userReads = 0;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (resource !== 'users' && resource !== 'user_directory') return result;
      if (resource === 'users') userReads += 1;
      const accepted = userReads > 1;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).id) === 'usr_acct_mgr_huda'
            ? {
                ...row,
                status: accepted ? 'active' : 'invited',
                last_login_at: accepted ? '2026-05-20T18:05:00.000Z' : null,
              }
            : row,
        ),
      };
    });
    vi.spyOn(api, 'ui_list_user_security_actions_v1').mockImplementation(async (targetUserId, limit = 5) => ({
      rows: targetUserId === 'usr_acct_mgr_huda'
        ? [
            {
              id: 'decision_invite_accept_huda_refresh',
              organization_id: 'org_rashed',
              timestamp: '2026-05-20T18:05:00.000Z',
              decision_category: 'users.invite',
              decision_point: 'tenant_user_invite_accept_v1',
              decision_outcome: 'accepted',
              decision_inputs: {
                email: 'huda.am@rashed-logistics.example',
                accepted_from_status: 'invited',
                accepted_to_status: 'active',
              },
              resource_type: 'user',
              resource_id: String(targetUserId),
              correlation_id: '0f840000-0000-4000-8000-000000000996',
              invite_email: 'huda.am@rashed-logistics.example',
              accepted_from_status: 'invited',
              accepted_to_status: 'active',
            },
          ]
        : [],
      total: targetUserId === 'usr_acct_mgr_huda' ? 1 : 0,
      page: 0,
      page_size: limit,
    }));

    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });

    const row = (await screen.findByText(/Huda Al-Subaie/i)).closest('tr')!;
    expect(row).toHaveTextContent(/Invited/i);
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    await waitFor(() => {
      expect(within(drawer).getByTestId('users-drawer-profile')).toHaveTextContent(/Status\s*Active/i);
    });
    const evidence = await within(drawer).findByTestId('users-security-action-decision_invite_accept_huda_refresh');
    expect(within(evidence).getByText(/Access: invited to active/i)).toBeInTheDocument();
  });

  it('disables invite email and submits without redirect when no hosted auth redirect is configured', async () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', '');
    vi.stubEnv('VITE_CONSOLE_AUTH_REDIRECT_URL', '');
    vi.stubEnv('VITE_APP_HOST', '');
    const user = userEvent.setup();
    let invited = false;
    let failedPostReadbackRefresh = false;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const realComplete = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (!invited || (resource !== 'users' && resource !== 'user_directory')) return result;
      const invitedRow = {
        id: 'usr_invited_local',
        organization_id: 'org_rashed',
        email: 'local.ops@example.com',
        full_name: 'Local Ops User',
        user_type: 'ops_admin',
        access_scope_type: 'tenant',
        access_scope_id: null,
        status: 'active',
        last_login_at: null,
        created_at: '2026-05-20T17:25:00.000Z',
        organization_label: 'Rashed Logistics',
        active_role_count: 1,
        active_role_keys: ['ops_admin'],
      };
      return {
        ...result,
        rows: [
          ...result.rows.filter((row) => String((row as Record<string, unknown>).id) !== invitedRow.id),
          invitedRow,
        ],
        total: (result.total ?? result.rows.length) + 1,
      };
    });
    const spy = vi.spyOn(api, 'tenant_user_invite_v1').mockResolvedValue({
      ok: true,
      email: 'local.ops@example.com',
      role_key: 'ops_admin',
      status: 'active',
      invite_email_sent: false,
    });
    spy.mockImplementation(async (args) => {
      invited = true;
      return {
        ok: true,
        email: args.email,
        role_key: args.role_key,
        status: 'active',
        invite_email_sent: false,
      };
    });
    vi.spyOn(api, 'ui_list_user_security_actions_v1').mockImplementation(async (targetUserId, limit = 5) => ({
      rows: invited && targetUserId === 'usr_invited_local'
        ? [
            {
              id: 'decision_invite_local',
              organization_id: 'org_rashed',
              timestamp: '2026-05-20T17:25:00.000Z',
              decision_category: 'users.invite',
              decision_point: 'tenant_user_invite_apply_v1',
              decision_outcome: 'created',
              decision_inputs: {
                email: 'local.ops@example.com',
                role_key: 'ops_admin',
                invite_email_sent: false,
                send_invite_email_requested: false,
                invite_redirect_to: null,
              },
              resource_type: 'user',
              resource_id: String(targetUserId),
              correlation_id: '0f840000-0000-4000-8000-000000000993',
              role_key: 'ops_admin',
              invite_email: 'local.ops@example.com',
              invite_email_sent: 'false',
              send_invite_email_requested: 'false',
              invite_redirect_to: null,
            },
          ]
        : [],
      total: invited ? 1 : 0,
      page: 0,
      page_size: limit,
    }));
    const { queryClient } = renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const realRefetchQueries = queryClient.refetchQueries.bind(queryClient);
    vi.spyOn(queryClient, 'refetchQueries').mockImplementation((async (filters, options) => {
      const key = Array.isArray(filters?.queryKey) ? filters.queryKey : [];
      if (invited && key[0] === 'list' && key[1] === 'users' && !failedPostReadbackRefresh) {
        failedPostReadbackRefresh = true;
        throw new Error('users list refresh hiccup after invite readback');
      }
      return realRefetchQueries(filters, options);
    }) as typeof queryClient.refetchQueries);
    await user.click(await screen.findByRole('button', { name: /Invite user/i }));
    const form = await screen.findByTestId('tenant-user-invite-form');
    expect(within(form).getByText(/Hosted invite email is disabled/i)).toBeInTheDocument();
    const inviteEmail = within(form).getByLabelText(/^Invite email/i);
    expect(inviteEmail).toBeDisabled();
    expect(inviteEmail).not.toBeChecked();
    await user.type(within(form).getByLabelText(/^Email$/i), 'local.ops@example.com');
    await user.type(within(form).getByLabelText(/^Name$/i), 'Local Ops User');
    const submit = within(form).getByRole('button', { name: /Send invite/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'local.ops@example.com',
        full_name: 'Local Ops User',
        role_key: 'ops_admin',
        organization_id: 'org_rashed',
        access_scope_type: 'tenant',
        access_scope_id: null,
        send_invite_email: false,
        invite_redirect_to: null,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId('tenant-user-invite-form')).toBeNull();
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'tenant user invite read-model refresh failed',
      expect.objectContaining({ message: 'users list refresh hiccup after invite readback' }),
    );
    const drawer = await screen.findByTestId('users-drawer');
    expect(drawer).toHaveTextContent(/local\.ops@example\.com/i);
    expect(await within(drawer).findByTestId('users-drawer-lifecycle-readback')).toHaveTextContent(
      /Invite decision was saved/i,
    );
    const evidence = await within(drawer).findByTestId('users-security-action-decision_invite_local');
    expect(within(evidence).getByText(/Invite decision recorded/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/local\.ops@example\.com/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/Email requested: false/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/Sent: false/i)).toBeInTheDocument();
    expect(within(evidence).getByText(/Redirect: not requested/i)).toBeInTheDocument();
  });

  it('fails closed when the tenant RBAC role catalog is empty', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'ui_list_tenant_invitable_roles_v1').mockResolvedValue({
      rows: [],
      total: 0,
    });
    const inviteSpy = vi.spyOn(api, 'tenant_user_invite_v1').mockResolvedValue({
      ok: true,
      user_id: 'usr_invited_role_gap',
      email: 'role.gap@example.com',
      role_key: 'ops_admin',
      status: 'invited',
    });
    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    await user.click(await screen.findByRole('button', { name: /Invite user/i }));
    const form = await screen.findByTestId('tenant-user-invite-form');
    expect(await within(form).findByText(/Tenant role catalog missing/i)).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Email$/i), 'role.gap@example.com');
    await user.type(within(form).getByLabelText(/^Name$/i), 'Role Gap User');
    expect(within(form).getByRole('button', { name: /Send invite/i })).toBeDisabled();
    expect(inviteSpy).not.toHaveBeenCalled();
  });

  it('blocks tenant user invites until a tenant is selected', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'tenant_user_invite_v1').mockResolvedValue({
      ok: true,
      user_id: 'usr_invited_test',
      email: 'no.tenant@example.com',
      role_key: 'ops_admin',
      status: 'invited',
    });

    renderWithProviders(<UsersModule />, {
      identity: {
        capabilities: ['users.read', 'users.manage'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_platform',
        },
        scope: {
          global: { id: 'platform', label: 'Platform', rank: 1 },
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: /Invite user/i }));
    const form = await screen.findByTestId('tenant-user-invite-form');
    expect(within(form).getByText(/Select a tenant first/i)).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Email$/i), 'no.tenant@example.com');
    await user.type(within(form).getByLabelText(/^Name$/i), 'No Tenant User');
    expect(within(form).getByRole('button', { name: /Send invite/i })).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
  });

  // ── 11. W23 paired projection (v_user_directory) ──────────────────
  // The Profile tab additively consumes `v_user_directory` rollups so the
  // drawer renders the active-role count + active-role keys + canonical
  // organization label sourced from the canonical projection seam (no
  // FE-side count math). SSOT:
  //   • supabase/migrations/202604302200_v_user_directory.sql
  //   • apps/console-v2/src/lib/data-source.ts → _projectUserDirectory
  describe('UsersModule · paired projection wiring (W23)', () => {
    it('drawer Profile tab surfaces directory active-role rollups and organization label', async () => {
      const user = userEvent.setup();
      renderWithProviders(<UsersModule />, { capabilities: ['users.read'] });
      // Open drawer for Rashed Al-Otaibi (usr_admin_rashed) — he has 1
      // active rbac assignment (ura_0001 → ops_admin) per the seed
      // (lib/seed-raw/rbac.js:191), so the count chip should render
      // exactly "1 active role" and the role-keys mono span should
      // contain `ops_admin`.
      const row = (await screen.findByText(/Rashed Al-Otaibi/i)).closest('tr')!;
      await user.click(row);
      const drawer = await screen.findByTestId('users-drawer');
      // The W23 hint span renders operator language plus the
      // canonical active_role_count derived from v_user_directory.
      const hint = await within(drawer).findByTestId('users-drawer-active-roles');
      expect(hint.textContent).toMatch(/Directory profile/);
      expect(within(hint).getByTestId('users-drawer-active-role-count').textContent).toMatch(
        /1 active role$/,
      );
      expect(within(hint).getByTestId('users-drawer-active-role-keys').textContent).toMatch(
        /ops_admin/,
      );
    });
  });

  it('Roles tab stays open and reflects grant/revoke state after backend refresh', async () => {
    const user = userEvent.setup();
    let financeGranted = false;
    let securityActionMode: 'none' | 'granted' | 'revoked' = 'none';
    const realList = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource !== 'user_directory') return result;
      return {
        ...result,
        rows: result.rows.map((row) => {
          if (String(row.id) !== 'usr_ops_admin_layla') return row;
          const activeRoleKeys = financeGranted ? ['ops_admin', 'finance'] : ['ops_admin'];
          return {
            ...row,
            active_role_count: activeRoleKeys.length,
            active_role_keys: activeRoleKeys,
          };
        }),
      };
    });
    vi.spyOn(api, 'ui_list_user_security_actions_v1').mockImplementation(async (targetUserId, limit) => ({
      rows:
        targetUserId === 'usr_ops_admin_layla' && securityActionMode !== 'none'
          ? [
              {
                id: `dlog_finance_${securityActionMode}`,
                resource_type: 'rbac_user_role_assignment',
                resource_id: 'ura_finance_refresh',
                decision_point:
                  securityActionMode === 'granted'
                    ? 'grant_user_role_v1'
                    : 'revoke_user_role_v1',
                decision_outcome: securityActionMode,
                decision_inputs: {
                  target_user_id: 'usr_ops_admin_layla',
                  role_key: 'finance',
                  reason:
                    securityActionMode === 'granted'
                      ? 'Temporary finance support'
                      : 'Finance support ended',
                },
                role_key: 'finance',
                action_reason:
                  securityActionMode === 'granted'
                    ? 'Temporary finance support'
                    : 'Finance support ended',
              },
            ]
          : [],
      total: securityActionMode === 'none' ? 0 : 1,
      page: 0,
      page_size: limit ?? 5,
    }));
    const grantSpy = vi.spyOn(api, 'grant_user_role_v1').mockImplementation(async (args) => {
      financeGranted = true;
      securityActionMode = 'granted';
      return {
        ok: true,
        target_user_id: args.target_user_id,
        role_key: args.role_key,
        user_role_assignment_id: 'ura_finance_refresh',
      };
    });
    const revokeSpy = vi.spyOn(api, 'revoke_user_role_v1').mockImplementation(async (args) => {
      financeGranted = false;
      securityActionMode = 'revoked';
      return {
        ok: true,
        target_user_id: args.target_user_id,
        role_key: args.role_key,
      };
    });

    renderWithProviders(<UsersModule />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const row = (await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('users-drawer');
    const rolesTab = within(drawer).getByTestId('users-drawer-tab-roles');
    await user.click(rolesTab);
    expect(rolesTab).toHaveAttribute('aria-selected', 'true');

    await user.click(
      within(await screen.findByTestId('users-role-row-finance')).getByRole('button', {
        name: /Grant role finance/i,
      }),
    );
    await waitFor(() =>
      expect(grantSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          target_user_id: 'usr_ops_admin_layla',
          role_key: 'finance',
        }),
      ),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId('users-role-row-finance')).getByRole('button', {
          name: /Revoke role finance/i,
        }),
      ).toBeEnabled(),
    );
    expect(within(drawer).getByTestId('users-drawer-roles')).toBeInTheDocument();
    expect(within(drawer).getByTestId('users-drawer-tab-roles')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(within(drawer).getByTestId('users-drawer-tab-profile'));
    const grantEvidence = await within(drawer).findByTestId('users-security-action-dlog_finance_granted');
    expect(within(grantEvidence).getByText(/Role granted/i)).toBeInTheDocument();
    expect(within(grantEvidence).getAllByText(/finance/i).length).toBeGreaterThan(0);
    expect(within(grantEvidence).getByText(/Temporary finance support/i)).toBeInTheDocument();
    await user.click(within(drawer).getByTestId('users-drawer-tab-roles'));

    await user.click(
      within(screen.getByTestId('users-role-row-finance')).getByRole('button', {
        name: /Revoke role finance/i,
      }),
    );
    await waitFor(() =>
      expect(revokeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          target_user_id: 'usr_ops_admin_layla',
          role_key: 'finance',
        }),
      ),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId('users-role-row-finance')).getByRole('button', {
          name: /Grant role finance/i,
        }),
      ).toBeEnabled(),
    );
    await user.click(within(drawer).getByTestId('users-drawer-tab-profile'));
    const revokeEvidence = await within(drawer).findByTestId('users-security-action-dlog_finance_revoked');
    expect(within(revokeEvidence).getByText(/Role revoked/i)).toBeInTheDocument();
    expect(within(revokeEvidence).getAllByText(/finance/i).length).toBeGreaterThan(0);
    expect(within(revokeEvidence).getByText(/Finance support ended/i)).toBeInTheDocument();
  });

  it('scopes user and directory reads to the tenant handoff organization query', async () => {
    window.history.replaceState({}, '', '/platform/users?organization_id=org_handoff');
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');
    renderWithProviders(<UsersModule />, {
      identity: {
        capabilities: ['users.read', 'users.manage'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_platform',
        },
        scope: {},
      },
    });

    expect(await screen.findByTestId('users-page')).toBeInTheDocument();
    expect(screen.getByText(/Tenant handoff active/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ filter: { organization_id: 'org_handoff' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'user_directory',
        expect.objectContaining({ filter: { organization_id: 'org_handoff' } }),
      );
    });
  });

  it('ignores tenant handoff organization query for tenant-scoped operators', async () => {
    window.history.replaceState({}, '', '/platform/users?organization_id=org_external_spoof');
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');
    renderWithProviders(<UsersModule />, {
      identity: {
        capabilities: ['users.read', 'users.manage'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    expect(await screen.findByTestId('users-page')).toBeInTheDocument();
    expect(screen.getByText(/Tenant scope active/i)).toBeInTheDocument();
    expect(screen.queryByText(/Tenant handoff active/i)).toBeNull();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ filter: { organization_id: 'org_rashed' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'user_directory',
        expect.objectContaining({ filter: { organization_id: 'org_rashed' } }),
      );
    });
    expect(listSpy).not.toHaveBeenCalledWith(
      'users',
      expect.objectContaining({ filter: { organization_id: 'org_external_spoof' } }),
    );
    expect(listSpy).not.toHaveBeenCalledWith(
      'user_directory',
      expect.objectContaining({ filter: { organization_id: 'org_external_spoof' } }),
    );
  });
});
