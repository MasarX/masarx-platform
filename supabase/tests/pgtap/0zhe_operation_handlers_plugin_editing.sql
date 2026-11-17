-- Plan: PLAN-202601-workflow-studio-dnd / Step: S95
-- pgTAP: global operation_handlers metadata is editable by platform admins and denied for tenant roles.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE TEMP TABLE pgtap_operation_handlers_plugin_edit_ctx (
  org_id UUID NOT NULL,
  client_id UUID NOT NULL,
  user_client_admin UUID NOT NULL,
  user_ops_admin UUID NOT NULL,
  user_platform_admin UUID NOT NULL
);

INSERT INTO pgtap_operation_handlers_plugin_edit_ctx (org_id, client_id, user_client_admin, user_ops_admin, user_platform_admin)
VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid());

SET LOCAL ROLE postgres;

INSERT INTO organizations (id, name, slug)
SELECT
  org_id,
  'Plugin Ops Org',
  'plugin-ops-org-' || left(org_id::text, 8)
FROM pgtap_operation_handlers_plugin_edit_ctx
LIMIT 1;

INSERT INTO clients (id, organization_id, name, slug, status)
SELECT
  client_id,
  org_id,
  'Plugin Ops Client',
  'plugin-ops-client-' || left(client_id::text, 8),
  'active'
FROM pgtap_operation_handlers_plugin_edit_ctx
LIMIT 1;

INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
SELECT
  user_client_admin,
  org_id,
  'plugin-client-admin-' || left(user_client_admin::text, 8) || '@example.com',
  'Plugin Client Admin',
  'client_admin',
  'client',
  client_id
FROM pgtap_operation_handlers_plugin_edit_ctx
LIMIT 1;

INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
SELECT
  user_ops_admin,
  org_id,
  'plugin-ops-admin-' || left(user_ops_admin::text, 8) || '@example.com',
  'Plugin Ops Admin',
  'ops_admin',
  'tenant',
  NULL
FROM pgtap_operation_handlers_plugin_edit_ctx
LIMIT 1;

INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
SELECT
  user_platform_admin,
  org_id,
  'plugin-platform-admin-' || left(user_platform_admin::text, 8) || '@example.com',
  'Plugin Platform Admin',
  'super_admin',
  'platform',
  NULL
FROM pgtap_operation_handlers_plugin_edit_ctx
LIMIT 1;

RESET ROLE;

-- Client admin cannot update operation handlers (capability denied).
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT user_client_admin::text FROM pgtap_operation_handlers_plugin_edit_ctx LIMIT 1),
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_update_resource_v1('operation_handlers', 'outbound_http', '{"ui_category":"Denied"}'::jsonb); $$,
  '42501',
  'Capability denied: operation_handlers.write'
);
RESET ROLE;

-- A tenant ops admin cannot mutate a shared global catalog.
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT user_ops_admin::text FROM pgtap_operation_handlers_plugin_edit_ctx LIMIT 1),
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_update_resource_v1('operation_handlers', 'outbound_http', '{"ui_category":"Denied"}'::jsonb); $$,
  '42501',
  'ui_read_registry global catalogs require platform mutation'
);
RESET ROLE;

-- A platform admin can update plugin UI metadata.
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT user_platform_admin::text FROM pgtap_operation_handlers_plugin_edit_ctx LIMIT 1),
  true
);
SET LOCAL ROLE authenticated;
WITH updated AS (
  SELECT public.ui_update_resource_v1(
    'operation_handlers',
    'outbound_http',
    jsonb_build_object('ui_category','HTTP', 'ui_label','Outbound HTTP', 'ui_description','Outbound HTTP plugin')
  ) AS row
)
SELECT ok(
  (row->>'ui_category') = 'HTTP',
  'platform admin can update ui_category'
)
FROM updated
UNION ALL
SELECT ok(
  (row->>'ui_label') = 'Outbound HTTP',
  'platform admin can update ui_label'
)
FROM updated;

-- Platform admins cannot update identity fields through ui_update_resource_v1 (edit_mode=none).
SELECT throws_ok(
  $$ SELECT public.ui_update_resource_v1('operation_handlers', 'outbound_http', '{"handler_schema":"workflow_handlers"}'::jsonb); $$,
  'P0001',
  'ui_update_resource_v1 column not editable: handler_schema'
);
RESET ROLE;

-- ui_read_registry exposes operation_handlers write capability as operation_handlers.write.
SELECT is(
  (
    SELECT value->>'capability_write'
    FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
    WHERE value->>'key' = 'operation_handlers'
    LIMIT 1
  ),
  'operation_handlers.write',
  'ui_read_registry operation_handlers capability_write is operation_handlers.write'
);

SELECT * FROM finish();
ROLLBACK;
