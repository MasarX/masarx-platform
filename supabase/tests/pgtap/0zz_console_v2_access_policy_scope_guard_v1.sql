-- pgTAP: Console V2 access-policy resolver cross-tenant scope guard

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT has_function(
  'public',
  'access_policy_scope_is_visible_to_current_user_v1',
  ARRAY['text','uuid'],
  'access_policy_scope_is_visible_to_current_user_v1 exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.access_policy_scope_is_visible_to_current_user_v1(text,uuid)',
    'EXECUTE'
  ),
  'authenticated can execute access_policy_scope_is_visible_to_current_user_v1'
);

DO $$
DECLARE
  v_org_a UUID := gen_random_uuid();
  v_org_b UUID := gen_random_uuid();
  v_tenant_user UUID := gen_random_uuid();
  v_platform_user UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES
    (v_org_a, 'Access Policy Guard Org A', 'access-policy-guard-a-' || left(v_org_a::text, 8), 'active'),
    (v_org_b, 'Access Policy Guard Org B', 'access-policy-guard-b-' || left(v_org_b::text, 8), 'active');

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES
    (
      v_tenant_user,
      v_org_a,
      'access-policy-guard-tenant-' || left(v_tenant_user::text, 8) || '@example.test',
      'Access Policy Guard Tenant User',
      'ops_admin',
      'active',
      'tenant',
      NULL
    ),
    (
      v_platform_user,
      v_org_a,
      'access-policy-guard-platform-' || left(v_platform_user::text, 8) || '@example.test',
      'Access Policy Guard Platform User',
      'super_admin',
      'active',
      'platform',
      NULL
    );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'access_control_policy'
        AND s.scope_type = 'tenant'
        AND s.scope_id = v_org_b
    ),
    'fixture organization B has a tenant access policy row to guard from leakage'
  );

  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_tenant_user,
      'role', 'authenticated',
      'email', 'access-policy-guard-tenant-' || left(v_tenant_user::text, 8) || '@example.test'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM ok(
    public.access_policy_scope_is_visible_to_current_user_v1('tenant', v_org_a),
    'tenant-scoped caller may resolve its own tenant policy scope'
  );

  PERFORM ok(
    NOT public.access_policy_scope_is_visible_to_current_user_v1('tenant', v_org_b),
    'tenant-scoped caller cannot resolve another tenant policy scope'
  );

  PERFORM is(
    (
      SELECT scope_id::text
      FROM public.resolve_access_control_policy_v1('tenant', v_org_a, FALSE)
      LIMIT 1
    ),
    v_org_a::text,
    'public resolver returns same-tenant policy for tenant-scoped caller'
  );

  PERFORM ok(
    NOT EXISTS (
      SELECT 1
      FROM public.resolve_access_control_policy_v1('tenant', v_org_b, FALSE)
    ),
    'public resolver returns no rows for cross-tenant policy override'
  );

  PERFORM ok(
    (
      api.resolve_access_control_policy_v2(
        jsonb_build_object('scope_type', 'tenant', 'scope_id', v_org_b::text)
      )->>'settings_id'
    ) IS NULL,
    'api v2 resolver envelope omits settings_id for cross-tenant policy override'
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_platform_user,
      'role', 'authenticated',
      'email', 'access-policy-guard-platform-' || left(v_platform_user::text, 8) || '@example.test'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is(
    (
      api.resolve_access_control_policy_v2(
        jsonb_build_object('scope_type', 'tenant', 'scope_id', v_org_b::text)
      )->>'scope_id'
    ),
    v_org_b::text,
    'platform caller keeps explicit cross-tenant policy resolver reach'
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();

ROLLBACK;
