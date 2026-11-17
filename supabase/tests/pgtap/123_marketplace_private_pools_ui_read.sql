-- pgTAP: canonical UI read RPCs support security_invoker views for marketplace private pools
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT has_function(
  'public',
  'ui_assert_read_relation_allowed_v1',
  ARRAY['text', 'text', 'text', 'text'],
  'ui_assert_read_relation_allowed_v1 exists'
);

SELECT lives_ok(
  $$
    SELECT public.ui_assert_read_relation_allowed_v1(
      'ui_test_read_guard',
      'public.marketplace_private_pool_memberships',
      'public',
      'marketplace_private_pool_memberships'
    )
  $$,
  'ui read guard allows security_invoker marketplace private pool view'
);

CREATE VIEW public.ui_test_non_invoker_marketplace_private_pools_v AS
SELECT id FROM public.organizations;

SELECT throws_ok(
  $$
    SELECT public.ui_assert_read_relation_allowed_v1(
      'ui_test_read_guard',
      'public.ui_test_non_invoker_marketplace_private_pools_v',
      'public',
      'ui_test_non_invoker_marketplace_private_pools_v'
    )
  $$,
  'P0001',
  'ui_test_read_guard relation not allowed: public.ui_test_non_invoker_marketplace_private_pools_v',
  'ui read guard rejects non-security_invoker views'
);

DO $$
DECLARE
  v_requester_org UUID := '70000000-0000-0000-0000-000000000001'::uuid;
  v_supplier_org UUID := '70000000-0000-0000-0000-000000000002'::uuid;
  v_user UUID := '70000000-0000-0000-0000-000000000003'::uuid;
  v_request UUID := '70000000-0000-0000-0000-000000000004'::uuid;
  v_result JSONB;
  v_metrics JSONB;
  v_detail JSONB;
  v_values JSONB;
BEGIN
  INSERT INTO public.organizations (
    id,
    name,
    slug,
    timezone,
    locale,
    billing_status,
    default_settings
  )
  VALUES
    (
      v_requester_org,
      'Marketplace Private Pools Requester',
      'marketplace-private-pools-requester',
      'Asia/Riyadh',
      'en',
      'active',
      '{}'::jsonb
    ),
    (
      v_supplier_org,
      'Marketplace Private Pools Supplier',
      'marketplace-private-pools-supplier',
      'Asia/Riyadh',
      'en',
      'active',
      '{}'::jsonb
    )
  ON CONFLICT (id) DO NOTHING;

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
  VALUES (
    v_user,
    v_requester_org,
    'marketplace-private-pools-ui-read@example.com',
    'Marketplace Private Pools UI Reader',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.provision_rbac_roles_from_templates_v1(v_requester_org, ARRAY['ops_admin'], v_user);

  INSERT INTO public.rbac_user_role_assignments (
    organization_id,
    user_id,
    role_id,
    assigned_by_user_id,
    metadata
  )
  SELECT
    v_requester_org,
    v_user,
    r.id,
    v_user,
    jsonb_build_object('source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_requester_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.marketplace_requests (
    id,
    requester_organization_id,
    request_kind_key,
    status,
    release_state,
    title,
    summary,
    private_pool
  )
  VALUES (
    v_request,
    v_requester_org,
    'shipment_batch',
    'draft',
    'private_pool',
    'Private pool request',
    'UI read regression fixture',
    jsonb_build_array(v_supplier_org)
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM ok(
    public.user_has_resource_capability_v1('marketplace_requests', 'read'),
    'fixture user has marketplace_requests.read capability'
  );

  v_result := public.ui_list_resource_v1(
    'marketplace_private_pools',
    jsonb_build_object('request_id', v_request::text),
    10,
    0,
    NULL
  );

  PERFORM is(
    jsonb_array_length(COALESCE(v_result->'items', '[]'::jsonb)),
    1,
    'ui_list_resource_v1 returns the marketplace private pool row'
  );

  PERFORM is(
    v_result#>>'{items,0,request_id}',
    v_request::text,
    'ui_list_resource_v1 exposes request_id from the security_invoker view'
  );

  v_detail := public.ui_get_resource_v1('marketplace_private_pools', v_request);

  PERFORM is(
    v_detail->>'request_id',
    v_request::text,
    'ui_get_resource_v1 resolves detail rows for marketplace private pools'
  );

  v_metrics := public.ui_resource_metrics_v1(
    'marketplace_private_pools',
    jsonb_build_object('request_id', v_request::text),
    NULL
  );

  PERFORM is(
    (v_metrics->>'total')::int,
    1,
    'ui_resource_metrics_v1 counts security_invoker marketplace private pool rows'
  );

  v_values := public.ui_filter_distinct_values_v1(
    'marketplace_private_pools',
    'supplier_organization_id',
    v_supplier_org::text,
    10
  );

  PERFORM ok(
    v_values @> jsonb_build_array(v_supplier_org::text),
    'ui_filter_distinct_values_v1 returns supplier organization values from the security_invoker view'
  );
END $$;

SELECT * FROM finish();

ROLLBACK;
