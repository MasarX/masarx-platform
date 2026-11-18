-- pgTAP: Console V2 lookup catalog hydration is not truncated by RPC row caps.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_function(
  'api',
  'list_lookup_values_catalog_json_v1',
  ARRAY['boolean'],
  'api.list_lookup_values_catalog_json_v1 exists'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '85ed322a-cf4e-4d76-b737-d4d73e50b801'::uuid,
  'Console V2 Lookup Catalog Org',
  'console-v2-lookup-catalog-85ed322a'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  '294be038-a56c-43fd-ac94-1127cae3fc01'::uuid,
  '85ed322a-cf4e-4d76-b737-d4d73e50b801'::uuid,
  'console-v2-lookup-catalog@example.test',
  'Console V2 Lookup Catalog Super Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  '8a9f4bf7-8729-4ef1-b3d5-6057bd8f2d41'::uuid,
  '85ed322a-cf4e-4d76-b737-d4d73e50b801'::uuid,
  'console-v2-lookup-account-manager@example.test',
  'Console V2 Lookup Account Manager',
  'account_manager',
  'tenant',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', '294be038-a56c-43fd-ac94-1127cae3fc01', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '294be038-a56c-43fd-ac94-1127cae3fc01',
    'role', 'authenticated',
    'email', 'console-v2-lookup-catalog@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT ok(
  api.list_lookup_values_catalog_json_v1(false) ? 'tenant_signup_request_status',
  'grouped catalog includes tenant_signup_request_status beyond the table-RPC first page'
);

SELECT ok(
  api.list_lookup_values_catalog_json_v1(false) ? 'user_status',
  'grouped catalog includes user_status beyond the table-RPC first page'
);

SELECT is(
  api.list_lookup_values_catalog_json_v1(false)
    #>> '{user_status,0,metadata,is_active}',
  'true',
  'user_status.active carries canonical metadata for Console V2 counters'
);

SELECT is(
  api.list_lookup_values_catalog_json_v1(false)
    #>> '{tenant_signup_request_status,0,metadata,allows_review}',
  'true',
  'tenant_signup_request_status.pending carries canonical review metadata'
);

RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '8a9f4bf7-8729-4ef1-b3d5-6057bd8f2d41', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '8a9f4bf7-8729-4ef1-b3d5-6057bd8f2d41',
    'role', 'authenticated',
    'email', 'console-v2-lookup-account-manager@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT ok(
  api.list_lookup_values_catalog_json_v1(false) ? 'tenant_signup_request_status',
  'account_manager can hydrate read-only lookup catalog for Console V2 boot'
);

SELECT ok(
  NOT public.user_has_capability_v1('organizations.read', 'tenant', '85ed322a-cf4e-4d76-b737-d4d73e50b801'::uuid),
  'account_manager lookup catalog grant does not grant organizations.read'
);

RESET ROLE;

SELECT is(
  (
    SELECT COUNT(*)::int
      FROM public.settings_versions sv
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) role
     WHERE sv.category = 'access_control_policy'
       AND sv.approved_at IS NOT NULL
       AND sv.effective_until IS NULL
       AND role->>'key' = 'account_manager'
       AND NOT (COALESCE(role->'capability_keys', '[]'::jsonb) @> to_jsonb('lookups.read'::text))
  ),
  0,
  'all active scoped access policies grant account_manager read-only lookup metadata'
);

SELECT * FROM finish();

ROLLBACK;
