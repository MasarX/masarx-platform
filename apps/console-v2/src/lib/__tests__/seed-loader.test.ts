// seed-loader.test.ts — coverage for the bundle-aware seed seam.
//
// Tests the contract that data-source.ts relies on:
//   • Seed mode (default): the seed namespace exposes the catalog (e.g.
//     navigation, current_user, current_capabilities). The in-memory adapter
//     boots without crashing.
//   • Live mode (`VITE_USE_SEED=false`): seed namespace stays empty and
//     backend-backed adapters fail closed when getSupabaseClient() returns
//     null. The build-time tree-shake contract is covered by
//     check-bundle-size.mjs.
//
// Vitest does not honor Vite's build-time `define`, so `__SEED_ENABLED__` is
// undefined here and the loader falls through to `import.meta.env.VITE_USE_SEED`.
// Tests run in seed mode by default; we use `vi.stubEnv` to flip into live mode.

import { afterEach, describe, expect, it, vi } from 'vitest';

function apiReadbackRpcMock(
  resources: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>,
) {
  const rowsFor = (resource: string): Array<Record<string, unknown>> => {
    const value = resources[resource];
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
  };

  return vi.fn(async (rpcName: string, args?: Record<string, unknown>) => {
    if (rpcName === 'ui_get_resource_v1') {
      const resource = String(args?.p_resource ?? '');
      const id = String(args?.p_id ?? '');
      const row = rowsFor(resource).find((candidate) => candidate.id === id) ?? rowsFor(resource)[0] ?? null;
      return { data: row, error: null };
    }
    if (rpcName === 'ui_list_resource_v1') {
      const resource = String(args?.p_resource ?? '');
      const filters = (args?.p_filters ?? {}) as Record<string, unknown>;
      const rows = rowsFor(resource).filter((row) =>
        Object.entries(filters).every(([key, value]) => row[key] === value),
      );
      return { data: { items: rows, total: rows.length }, error: null };
    }
    if (rpcName === 'ui_list_user_security_actions_v1') {
      const targetUserId = String(args?.p_target_user_id ?? '');
      const rows = rowsFor('user_security_actions').filter((row) => row.resource_id === targetUserId);
      return { data: { items: rows, total: rows.length }, error: null };
    }
    return { data: {}, error: null };
  });
}

describe('lib/seed-loader — bundle-aware seed seam', () => {
  afterEach(() => {
    vi.doUnmock('../supabase');
    vi.doUnmock('../seed-loader');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exports a seed namespace populated with the in-memory catalog (seed mode)', async () => {
    // No env override: VITE_USE_SEED defaults to "true" (or unset, treated as
    // truthy). The loader resolves the seed-raw catalog via dynamic import.
    const mod = await import('../seed-loader');
    expect(mod.SEED_MODE_ENABLED).toBe(true);
    // The seed namespace must expose the canonical bootstrap fields used by
    // data-source.ts module-init (current_user, current_capabilities,
    // current_scope, navigation, ui_read_registry, ui_command_registry).
    expect(mod.seed).toBeDefined();
    expect(mod.seed.current_user).toBeDefined();
    expect(mod.seed.current_capabilities).toBeDefined();
    expect(mod.seed.navigation).toBeDefined();
    expect(mod.seed.ui_read_registry).toBeDefined();
  });

  it('data-source bootstraps without throwing in seed mode', async () => {
    // Importing data-source.ts triggers the module-init seed read (state.user,
    // state.capabilities, state.scope). This must succeed in seed mode.
    const ds = await import('../data-source');
    const user = ds.getCurrentUser() as Record<string, unknown>;
    expect(user).toBeDefined();
    expect(user.role).toBe('super_admin');
    const caps = ds.getCapabilities();
    expect(Array.isArray(caps)).toBe(true);
    // Seed mode must populate the capability set from the dev_roles default.
    expect(caps.length).toBeGreaterThan(0);
  });

  it('seed manual shipment intake materializes the focused shipment, recipient, address, and label projections', async () => {
    vi.resetModules();
    const ds = await import('../data-source');
    const ref = `INLINE-SEED-${Date.now()}`;

    const result = await ds.ui_create_shipment_v1({
      organization_id: 'org_rashed',
      client_id: 'cl_exampleparcel_ksa',
      sender_id: 'snd_examplemarket_jed_warehouse',
      new_recipient: {
        name: 'Inline Seed Recipient',
        phone_number: '+966500008888',
        external_id: `EXT-${ref}`,
      },
      destination_address: {
        line1: 'Inline seed villa 8',
        district: 'Al Olaya',
        city: 'Riyadh',
      },
      service_type: 'delivery',
      service_offering_id: 'sof_seed_inline',
      client_reference_number: ref,
      cod_amount: 42,
      cod_currency: 'SAR',
      promised_delivery_date: '2026-05-07',
      dry_run: false,
    });

    expect(result).toMatchObject({
      status: 'shipment_created',
      operation: 'inserted',
      dry_run: false,
    });
    expect(result.shipment_id).toBeTruthy();
    expect(result.recipient_id).toBeTruthy();
    expect(result.label_job_id).toBeTruthy();

    const shipmentId = result.shipment_id as string;
    const recipientId = result.recipient_id as string;
    const shipmentLookup = await ds.ui_list_resource_v1('shipments', {
      filter: { identifier: shipmentId },
      page_size: 1,
    });
    expect(shipmentLookup.rows).toHaveLength(1);
    expect(shipmentLookup.rows[0]).toMatchObject({
      id: shipmentId,
      client_reference_number: ref,
      recipient_id: recipientId,
      destination_city: 'Riyadh',
    });
    expect(['standard', 'express', 'same_day', 'pickup', 'swap', 'rto']).toContain(
      (shipmentLookup.rows[0] as Record<string, unknown>).service_type,
    );

    const directoryLookup = await ds.ui_list_resource_v1('shipment_directory', {
      filter: { identifier: result.tracking_number },
      page_size: 1,
    });
    expect(directoryLookup.rows).toHaveLength(1);
    expect(directoryLookup.rows[0]).toMatchObject({
      id: shipmentId,
      recipient_label: 'Inline Seed Recipient',
      destination_city: 'Riyadh',
      box_actual_count: 1,
      label_count: 1,
    });

    const recipientLookup = await ds.ui_list_resource_v1('recipients', {
      filter: { id: recipientId },
      page_size: 1,
    });
    expect(recipientLookup.rows).toHaveLength(1);
    expect(recipientLookup.rows[0]).toMatchObject({
      id: recipientId,
      client_id: 'cl_exampleparcel_ksa',
      name: 'Inline Seed Recipient',
      phone_number: '+966500008888',
    });
  });
});

describe('lib/seed-loader — live-mode adapter behavior', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('data-source adapters route to RPC when getSupabaseClient() returns a client', async () => {
    // This validates the swap-seam contract: when a Supabase client is
    // present, every adapter takes the `client.rpc(...)` branch instead of
    // reading from the seed catalog. We use `resolve_access_control_policy_v1`
    // because it has an explicit `getSupabaseClient()` check at the top of
    // its body and returns a single row from the canonical resolver RPC.
    //
    // W44 cutover: the adapter now routes to `resolve_access_control_policy_v2`
    // (canonical (p_args jsonb) RETURNS jsonb envelope sibling per migration
    // 202605020200_w44_rpc_v2_normalizations.sql). Envelope shape:
    // { ok, policy, settings_id, settings_version_id, scope_type, scope_id,
    //   scope_path, settings_resolution_id }.
    vi.resetModules();
    const rpcMock = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        policy: {},
        settings_id: 'set_x',
        settings_version_id: 'sv_x',
        scope_type: 'global',
        scope_id: null,
        scope_path: [{ scope_type: 'global', scope_id: null }],
        settings_resolution_id: 'srlv_test_001',
      },
      error: null,
    });
    vi.doMock('../supabase', () => ({
      getSupabaseClient: () => ({ rpc: rpcMock }),
      __resetSupabaseClientForTests: vi.fn(),
      rpc: vi.fn(),
    }));

    const ds = await import('../data-source');
    const result = await ds.resolve_access_control_policy_v1({});
    // With a Supabase client present, the adapter MUST have invoked .rpc()
    // against the canonical _v2 sibling with a `p_args` jsonb envelope.
    expect(rpcMock).toHaveBeenCalledWith(
      'resolve_access_control_policy_v2',
      expect.objectContaining({ p_args: expect.any(Object) }),
    );
    expect(result.settings_resolution_id).toBe('srlv_test_001');
    vi.doUnmock('../supabase');
  });

  it('tenant signup review routes through the canonical edge function in live mode', async () => {
    vi.resetModules();
    const invokeMock = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        tenant_signup_request_id: '00000000-0000-4000-8000-000000000123',
        decision: 'approved',
        reviewed_at: '2026-05-08T09:00:00.000Z',
        result: {
          tenant_signup_request_id: '00000000-0000-4000-8000-000000000123',
          status: 'approved',
          approved_organization_id: '00000000-0000-4000-8000-000000000201',
          organization_id: '00000000-0000-4000-8000-000000000201',
          approved_user_id: '00000000-0000-4000-8000-000000000202',
          approved_auth_user_id: '00000000-0000-4000-8000-000000000302',
          invite_id: '00000000-0000-4000-8000-000000000203',
          invite_email_sent_at: '2026-05-08T09:00:01.000Z',
        },
      },
      error: null,
    });
    const apiRpcMock = apiReadbackRpcMock({
      tenant_signup_requests: {
        id: '00000000-0000-4000-8000-000000000123',
        status: 'approved',
        review_decision: 'approved',
        approved_organization_id: '00000000-0000-4000-8000-000000000201',
        approved_user_id: '00000000-0000-4000-8000-000000000202',
        approved_auth_user_id: '00000000-0000-4000-8000-000000000302',
        invite_id: '00000000-0000-4000-8000-000000000203',
        invite_email_sent_at: '2026-05-08T09:00:01.000Z',
      },
      tenant_signup_request_summary: {
        id: '00000000-0000-4000-8000-000000000123',
        status: 'approved',
        review_decision: 'approved',
        approved_organization_id: '00000000-0000-4000-8000-000000000201',
        approved_user_id: '00000000-0000-4000-8000-000000000202',
        approved_auth_user_id: '00000000-0000-4000-8000-000000000302',
        invite_id: '00000000-0000-4000-8000-000000000203',
        invite_email_sent_at: '2026-05-08T09:00:01.000Z',
      },
      organizations: { id: '00000000-0000-4000-8000-000000000201' },
      users: { id: '00000000-0000-4000-8000-000000000202' },
      user_directory: { id: '00000000-0000-4000-8000-000000000202' },
    });
    const schemaMock = vi.fn().mockReturnValue({ rpc: apiRpcMock });
    vi.doMock('../supabase', () => ({
      getSupabaseClient: () => ({
        functions: { invoke: invokeMock },
        schema: schemaMock,
      }),
      __resetSupabaseClientForTests: vi.fn(),
      rpc: vi.fn(),
    }));

    const ds = await import('../data-source');
    const result = await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: '00000000-0000-4000-8000-000000000123',
      decision: 'approved',
      decision_reason: 'KYC complete',
      decision_metadata: { source: 'console-v2/platform/organizations' },
    });

    expect(invokeMock).toHaveBeenCalledWith('tenant-signup-review', {
      body: {
        request_id: '00000000-0000-4000-8000-000000000123',
        decision: 'approved',
        reason: 'KYC complete',
        metadata: { source: 'console-v2/platform/organizations' },
      },
    });
    expect(result).toMatchObject({ ok: true, decision: 'approved' });
    vi.doUnmock('../supabase');
  });

  it('tenant signup review seed fallback returns approved tenant readiness handoff fields', async () => {
    const ds = await import('../data-source');

    const result = await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: 'tsr_221',
      decision: 'approved',
    });

    expect(result).toMatchObject({
      ok: true,
      tenant_signup_request_id: 'tsr_221',
      decision: 'approved',
      status: 'approved',
      approved_organization_id: 'org_riyadh_express',
      organization_id: 'org_riyadh_express',
      approved_user_id: 'usr_riyadh_express_admin',
      approved_auth_user_id: 'auth_riyadh_express_admin',
      invite_email_sent_at: expect.any(String),
    });
  });

  it('tenant admin profile and invite adapters route through browser-safe edge functions in live mode', async () => {
    vi.resetModules();
    const invokeMock = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          ok: true,
          organization_id: '00000000-0000-4000-8000-000000000201',
          updated_at: '2026-05-08T09:10:00.000Z',
          changed_fields: ['name', 'logo_url'],
          result: {
            organization_id: '00000000-0000-4000-8000-000000000201',
            name: 'Rashed Logistics Group',
            branding: {
              logo_url: 'https://assets.example/logo.svg',
            },
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          result: {
            user_id: '00000000-0000-4000-8000-000000000202',
            role_key: 'ops_admin',
            rbac_user_role_assignment_id: '00000000-0000-4000-8000-000000000402',
            invite_id: '00000000-0000-4000-8000-000000000403',
            invite_email_sent: true,
            invite_email_sent_at: '2026-05-08T09:15:00.000Z',
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          result: {
            id: '00000000-0000-4000-8000-000000000203',
            status: 'pending',
          },
        },
        error: null,
      });
    const apiRpcMock = apiReadbackRpcMock({
      organizations: {
        id: '00000000-0000-4000-8000-000000000201',
        name: 'Rashed Logistics Group',
        default_settings: {
          branding: {
            logo_url: 'https://assets.example/logo.svg',
          },
        },
      },
      users: {
        id: '00000000-0000-4000-8000-000000000202',
        access_scope_type: 'tenant',
      },
      user_directory: {
        id: '00000000-0000-4000-8000-000000000202',
        access_scope_type: 'tenant',
        active_role_keys: ['ops_admin'],
      },
      rbac_user_role_assignments: [
        {
          id: '00000000-0000-4000-8000-000000000402',
          user_id: '00000000-0000-4000-8000-000000000202',
          role_key: 'ops_admin',
        },
      ],
      user_security_actions: [
        {
          id: '00000000-0000-4000-8000-000000000502',
          resource_id: '00000000-0000-4000-8000-000000000202',
          decision_point: 'tenant_user_invite_apply_v1',
          role_key: 'ops_admin',
          invite_email: 'new.ops@example.com',
          invite_email_sent: true,
          send_invite_email_requested: true,
          invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
          decision_inputs: {
            target_user_id: '00000000-0000-4000-8000-000000000202',
            role_key: 'ops_admin',
            rbac_user_role_assignment_id: '00000000-0000-4000-8000-000000000402',
            email: 'new.ops@example.com',
            invite_email_sent: true,
            send_invite_email_requested: true,
            invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
          },
        },
      ],
      tenant_signup_requests: {
        id: '00000000-0000-4000-8000-000000000203',
        status: 'pending',
      },
      tenant_signup_request_summary: {
        id: '00000000-0000-4000-8000-000000000203',
        status: 'pending',
      },
    });
    const schemaMock = vi.fn().mockReturnValue({ rpc: apiRpcMock });
    vi.doMock('../supabase', () => ({
      getSupabaseClient: () => ({
        functions: { invoke: invokeMock },
        schema: schemaMock,
      }),
      __resetSupabaseClientForTests: vi.fn(),
      rpc: vi.fn(),
    }));

    const ds = await import('../data-source');
    await ds.ui_update_organization_profile_v1({
      organization_id: '00000000-0000-4000-8000-000000000201',
      name: 'Rashed Logistics Group',
      logo_url: 'https://assets.example/logo.svg',
    });
    await ds.tenant_user_invite_v1({
      organization_id: '00000000-0000-4000-8000-000000000201',
      email: 'new.ops@example.com',
      full_name: 'New Ops User',
      role_key: 'ops_admin',
      send_invite_email: true,
      invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
    });
    await ds.tenant_signup_console_request_v1({
      email: 'tenant.admin@example.com',
      full_name: 'Tenant Admin',
      organization_name: 'Console Created Tenant',
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'organization-profile', {
      body: {
        organization_id: '00000000-0000-4000-8000-000000000201',
        name: 'Rashed Logistics Group',
        logo_url: 'https://assets.example/logo.svg',
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'tenant-user-invite', {
      body: expect.objectContaining({
        organization_id: '00000000-0000-4000-8000-000000000201',
        email: 'new.ops@example.com',
        full_name: 'New Ops User',
        role_key: 'ops_admin',
        send_invite_email: true,
        invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
      }),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'tenant-signup-console-request', {
      body: expect.objectContaining({
        email: 'tenant.admin@example.com',
        full_name: 'Tenant Admin',
        organization_name: 'Console Created Tenant',
      }),
    });
    vi.doUnmock('../supabase');
  });

  it('generic registry reads route through the browser-safe api schema in live mode', async () => {
    vi.resetModules();
    const apiRpcMock = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          items: [{ id: 'shipment_1', status: 'created' }],
          total: 1,
          limit: 25,
          offset: 50,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: 'shipment_1', status: 'created' }, error: null })
      .mockResolvedValueOnce({ data: { total: 7, columns: {} }, error: null })
      .mockResolvedValueOnce({ data: { events: [] }, error: null });
    const publicRpcMock = vi.fn();
    const schemaMock = vi.fn().mockReturnValue({ rpc: apiRpcMock });
    vi.doMock('../supabase', () => ({
      getSupabaseClient: () => ({
        rpc: publicRpcMock,
        schema: schemaMock,
      }),
      __resetSupabaseClientForTests: vi.fn(),
      rpc: vi.fn(),
    }));

    const ds = await import('../data-source');
    const list = await ds.ui_list_resource_v1('shipments', {
      filter: { status: 'created' },
      sort: { key: 'created_at', dir: 'desc' },
      page: 2,
      page_size: 25,
    });
    const row = await ds.ui_get_resource_v1('shipments', 'shipment_1');
    const metrics = await ds.ui_resource_metrics_v1('shipments', {
      filter: { status: 'created' },
    });
    const timeline = await ds.ui_get_shipment_timeline_v1('00000000-0000-4000-8000-000000000456');

    expect(schemaMock).toHaveBeenCalledWith('api');
    expect(publicRpcMock).not.toHaveBeenCalled();
    expect(apiRpcMock).toHaveBeenNthCalledWith(1, 'ui_list_resource_v1', {
      p_resource: 'shipments',
      p_filters: { status: 'created' },
      p_limit: 25,
      p_offset: 50,
      p_sort: { key: 'created_at', direction: 'desc' },
    });
    expect(apiRpcMock).toHaveBeenNthCalledWith(2, 'ui_get_resource_v1', {
      p_resource: 'shipments',
      p_id: 'shipment_1',
    });
    expect(apiRpcMock).toHaveBeenNthCalledWith(3, 'ui_resource_metrics_v1', {
      p_resource: 'shipments',
      p_filters: { status: 'created' },
      p_columns: null,
    });
    expect(apiRpcMock).toHaveBeenNthCalledWith(4, 'ui_get_shipment_timeline_v1', {
      p_shipment_id: '00000000-0000-4000-8000-000000000456',
    });
    expect(list).toMatchObject({ total: 1, page: 2, page_size: 25 });
    expect(row).toMatchObject({ id: 'shipment_1' });
    expect(metrics.total).toBe(7);
    expect(timeline).toEqual([]);
    vi.doUnmock('../supabase');
  });

  it('canonical mutation facades route through the browser-safe api schema in live mode', async () => {
    vi.resetModules();
    const apiRpcMock = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        settlement_batch_id: '00000000-0000-4000-8000-000000000789',
        correlation_id: '00000000-0000-4000-8000-000000000111',
      },
      error: null,
    });
    const publicRpcMock = vi.fn();
    const schemaMock = vi.fn().mockReturnValue({ rpc: apiRpcMock });
    vi.doMock('../supabase', () => ({
      getSupabaseClient: () => ({
        rpc: publicRpcMock,
        schema: schemaMock,
      }),
      __resetSupabaseClientForTests: vi.fn(),
      rpc: vi.fn(),
    }));

    const ds = await import('../data-source');
    await ds.ui_create_settlement_batch_v1({
      scope_type: 'driver_shift',
      idempotency_key: 'test-key',
    });

    expect(schemaMock).toHaveBeenCalledWith('api');
    expect(publicRpcMock).not.toHaveBeenCalled();
    expect(apiRpcMock).toHaveBeenCalledWith('ui_create_settlement_batch_v1', {
      p_args: {
        scope_type: 'driver_shift',
        idempotency_key: 'test-key',
      },
    });
    vi.doUnmock('../supabase');
  });

  it('seed namespace is empty when VITE_USE_SEED is "false" (live-mode tree-shake contract)', async () => {
    // W56-B-2 closure (F6) — `api.seed.*` namespace fully retired in favor of
    // canonical `useResourceList<T>('<resource_key>')` / `api.ui_list_resource_v1<T>`
    // call sites. The contract under test now lives at the seed-loader seam:
    // when `VITE_USE_SEED=false`, the seed namespace MUST be the empty stub
    // (`{}`) so Rollup tree-shakes the seed-raw graph out of the production
    // bundle. Module call sites that previously consumed `api.seed.*` now
    // resolve through `ui_list_resource_v1`, which already short-circuits to
    // the `getSupabaseClient()` branch in live mode.
    vi.stubEnv('VITE_USE_SEED', 'false');
    vi.resetModules();
    const mod = await import('../seed-loader');
    expect(mod.SEED_MODE_ENABLED).toBe(false);
    // Empty stub — adapters in live mode never read seed values (the
    // getSupabaseClient() branch fires first), but a few sync helpers
    // (getNavigation/getReadRegistry/...) guard with `?? {}` / `?? []` and
    // expect a non-throwing access target.
    expect(mod.seed).toEqual({});
  });

  it('live mode fails closed instead of returning seed or synthetic data when Supabase env is missing', async () => {
    vi.stubEnv('VITE_USE_SEED', 'false');
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    vi.resetModules();

    const ds = await import('../data-source');
    const missingBackend = /VITE_USE_SEED=false disables Console V2 seed fallbacks/;
    await expect(ds.ui_list_resource_v1('shipments')).rejects.toThrow(
      missingBackend,
    );
    await expect(
      ds.create_billing_invoice_v1({
        client_id: 'client_test',
        currency: 'SAR',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.tenant_signup_review_apply_v1({
        tenant_signup_request_id: '00000000-0000-4000-8000-000000000123',
        decision: 'approve',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.tenant_signup_console_request_v1({
        email: 'tenant.admin@example.com',
        full_name: 'Tenant Admin',
        organization_name: 'Console Created Tenant',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.ui_update_organization_profile_v1({
        organization_id: '00000000-0000-4000-8000-000000000201',
        name: 'Rashed Logistics Group',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.tenant_user_invite_v1({
        organization_id: '00000000-0000-4000-8000-000000000201',
        email: 'new.ops@example.com',
        full_name: 'New Ops User',
        role_key: 'ops_admin',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.zone_create_v1({
        organization_id: '00000000-0000-4000-8000-000000000201',
        name: 'Central Riyadh',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.ui_update_basket_state_v1({
        basket_id: '00000000-0000-4000-8000-000000000301',
        state: 'closed',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.basket_create_v1({
        organization_id: '00000000-0000-4000-8000-000000000201',
        basket_type: 'route',
        state: 'open',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.ui_test_mapping_config_v1('00000000-0000-4000-8000-000000000014', {
        external_id: 'MX-1',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.runPluginTest('00000000-0000-4000-8000-000000000016', {
        external_id: 'MX-2',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.plugin_studio_parse_v1({
        source_type: 'curl',
        source_payload: {},
        plugin_kind: 'api',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.resource_import_studio_prepare_v1({
        file: new File(['external_id\nMX-1\n'], 'shipments.csv', { type: 'text/csv' }),
        resource_key: 'shipments',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.resource_import_studio_start_v1({
        run_id: '00000000-0000-4000-8000-000000000901',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.compute_cod_payment_collection_summary_v1({
        organization_id: '00000000-0000-4000-8000-000000000081',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.request_label_reprint('00000000-0000-4000-8000-000000000401', {
        reason: 'label damaged',
      }),
    ).rejects.toThrow(missingBackend);
    await expect(
      ds.complete_label_job('00000000-0000-4000-8000-000000000402', {
        status: 'completed',
      }),
    ).rejects.toThrow(missingBackend);
    expect(() => ds.streamEvidence(vi.fn())).toThrow(missingBackend);
  });

  it('device revoke routes to the canonical user_devices api-schema command in live mode', async () => {
    vi.resetModules();
    const readbackRpcMock = apiReadbackRpcMock({
      user_devices: {
        id: '00000000-0000-4000-8000-000000000555',
        status: 'revoked',
        is_revoked: true,
        revoked_at: '2026-05-03T10:00:00.000Z',
        revoked_reason: 'lost device',
      },
      user_device_summary: {
        id: '00000000-0000-4000-8000-000000000555',
        status: 'revoked',
        is_revoked: true,
        revoked_at: '2026-05-03T10:00:00.000Z',
        revoked_reason: 'lost device',
      },
    });
    const apiRpcMock = vi.fn(async (rpcName: string, args?: Record<string, unknown>) => {
      if (rpcName === 'ui_execute_user_device_revoke_v1') {
        return {
          data: {
            status: 'revoked',
            action_key: 'user_devices.revoke',
            resource_key: 'user_devices',
            count: 1,
            items: [
              {
                id: '00000000-0000-4000-8000-000000000555',
                status: 'revoked',
                revoked_at: '2026-05-03T10:00:00.000Z',
              },
            ],
          },
          error: null,
        };
      }
      return readbackRpcMock(rpcName, args);
    });
    const publicRpcMock = vi.fn();
    const schemaMock = vi.fn().mockReturnValue({ rpc: apiRpcMock });
    vi.doMock('../supabase', () => ({
      getSupabaseClient: () => ({
        rpc: publicRpcMock,
        schema: schemaMock,
      }),
      __resetSupabaseClientForTests: vi.fn(),
      rpc: vi.fn(),
    }));

    const ds = await import('../data-source');
    const result = await ds.ui_execute_user_device_revoke_v1(
      '00000000-0000-4000-8000-000000000555',
      'lost device',
    );

    expect(schemaMock).toHaveBeenCalledWith('api');
    expect(publicRpcMock).not.toHaveBeenCalled();
    expect(apiRpcMock).toHaveBeenCalledWith('ui_execute_user_device_revoke_v1', {
      p_action_key: 'user_devices.revoke',
      p_resource_key: 'user_devices',
      p_selection_ids: ['00000000-0000-4000-8000-000000000555'],
      p_selection_id: '00000000-0000-4000-8000-000000000555',
      p_selection_count: 1,
      p_params: { revoked_reason: 'lost device' },
    });
    expect(result).toMatchObject({
      ok: true,
      device_id: '00000000-0000-4000-8000-000000000555',
      status: 'revoked',
      action_key: 'user_devices.revoke',
    });
    vi.doUnmock('../supabase');
  });

  it('seed namespace is populated when seed mode is enabled (default vitest mode)', async () => {
    // Default (no env override) keeps the loader in seed mode.
    vi.resetModules();
    const mod = await import('../seed-loader');
    expect(mod.SEED_MODE_ENABLED).toBe(true);
    // The seed namespace must expose the canonical bootstrap fields used by
    // data-source.ts module-init (current_user, current_capabilities,
    // navigation, ui_read_registry).
    expect(mod.seed.current_user).toBeDefined();
    expect(mod.seed.recipients).toBeDefined();
    expect(Array.isArray(mod.seed.recipients)).toBe(true);
    expect((mod.seed.recipients as unknown[]).length).toBeGreaterThan(0);
  });
});
