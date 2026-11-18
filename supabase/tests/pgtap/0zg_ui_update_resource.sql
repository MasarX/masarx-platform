-- Test Suite: UI update resource RPC
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT has_function(
  'public',
  'ui_update_resource_v1',
  ARRAY['text','text','jsonb'],
  'ui_update_resource_v1 exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'ui_read_registry'
       AND schema #> '{properties,resources,items,properties,columns}' IS NOT NULL
  ),
  'ui_read_registry schema includes columns metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'ui_read_registry'
       AND schema #> '{properties,resources,items,properties,capability_write}' IS NOT NULL
  ),
  'ui_read_registry schema includes capability_write'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'ui_read_registry'
       AND schema #> '{properties,resources,items,properties,write_relation}' IS NOT NULL
  ),
  'ui_read_registry schema includes write_relation'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value ? 'columns'
       )
  ),
  'ui_read_registry defaults include column metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value ? 'capability_write'
       )
  ),
  'ui_read_registry defaults include capability_write'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_update_resource_v1(text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute ui_update_resource_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_update_resource_v1(text,text,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute ui_update_resource_v1'
);

SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

INSERT INTO public.organizations (id, name, slug)
VALUES
  ('3b8c3c72-1af7-4e85-8ff4-7e900a5f1101'::uuid, 'UI Update Scope Org A', 'ui-update-scope-org-a'),
  ('3b8c3c72-1af7-4e85-8ff4-7e900a5f1102'::uuid, 'UI Update Scope Org B', 'ui-update-scope-org-b')
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.organization_onboarding_source', '', true);

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
  '3b8c3c72-1af7-4e85-8ff4-7e900a5f1112'::uuid,
  '3b8c3c72-1af7-4e85-8ff4-7e900a5f1102'::uuid,
  'ui-update-scope-org-b@example.test',
  'UI Update Scope Org B Operator',
  'ops_admin',
  'tenant',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES
  (
    '3b8c3c72-1af7-4e85-8ff4-7e900a5f1121'::uuid,
    '3b8c3c72-1af7-4e85-8ff4-7e900a5f1101'::uuid,
    'UI Update Scope Client A',
    'ui-update-scope-client-a',
    'active'
  ),
  (
    '3b8c3c72-1af7-4e85-8ff4-7e900a5f1122'::uuid,
    '3b8c3c72-1af7-4e85-8ff4-7e900a5f1102'::uuid,
    'UI Update Scope Client B',
    'ui-update-scope-client-b',
    'active'
  )
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    organization_id = EXCLUDED.organization_id,
    slug = EXCLUDED.slug,
    status = EXCLUDED.status;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES
  (
    '3b8c3c72-1af7-4e85-8ff4-7e900a5f1131'::uuid,
    '3b8c3c72-1af7-4e85-8ff4-7e900a5f1121'::uuid,
    'UI Update Scope Sender A',
    'UI Update Scope Sender A',
    TRUE,
    'active'
  ),
  (
    '3b8c3c72-1af7-4e85-8ff4-7e900a5f1132'::uuid,
    '3b8c3c72-1af7-4e85-8ff4-7e900a5f1122'::uuid,
    'UI Update Scope Sender B',
    'UI Update Scope Sender B',
    TRUE,
    'active'
  )
ON CONFLICT (id) DO UPDATE
SET client_id = EXCLUDED.client_id,
    name = EXCLUDED.name,
    brand_name = EXCLUDED.brand_name,
    auto_provisioned = EXCLUDED.auto_provisioned,
    status = EXCLUDED.status;

SELECT public.bootstrap_tenant_onboarding_v1(
  '3b8c3c72-1af7-4e85-8ff4-7e900a5f1101'::uuid,
  'pgtap:ui-update-resource-scope-org-a-fixture-bootstrap'
);

SELECT public.bootstrap_tenant_onboarding_v1(
  '3b8c3c72-1af7-4e85-8ff4-7e900a5f1102'::uuid,
  'pgtap:ui-update-resource-scope-org-b-fixture-bootstrap'
);

SELECT set_config('request.jwt.claim.sub', '3b8c3c72-1af7-4e85-8ff4-7e900a5f1112', true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '3b8c3c72-1af7-4e85-8ff4-7e900a5f1112',
    'role', 'authenticated',
    'email', 'ui-update-scope-org-b@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$
    SELECT public.ui_update_resource_v1(
      'clients',
      '3b8c3c72-1af7-4e85-8ff4-7e900a5f1121',
      '{"name":"UI Update Scope Leak"}'::jsonb
    )
  $$,
  '42501',
  'ui_update_resource_v1 resource not available',
  'ui_update_resource_v1 denies direct cross-tenant writes with a generic response'
);

RESET ROLE;
SET LOCAL search_path TO public, extensions, pg_temp;

SELECT is(
  (SELECT name FROM public.clients WHERE id = '3b8c3c72-1af7-4e85-8ff4-7e900a5f1121'::uuid),
  'UI Update Scope Client A',
  'ui_update_resource_v1 cross-tenant denial does not mutate the target row'
);

SELECT * FROM finish();
ROLLBACK;
