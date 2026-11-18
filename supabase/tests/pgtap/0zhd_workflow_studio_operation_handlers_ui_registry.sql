-- Plan: PLAN-202601-workflow-studio-dnd / Step: S95
-- pgTAP: operation_handlers is exposed via ui_read_registry and listable for workflow roles.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  EXECUTE 'GRANT SELECT ON TABLE public.operation_handlers TO authenticated';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Workflow Ops Org', 'workflow-ops-org-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Workflow Ops Client', 'workflow-ops-client-' || left(v_client::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender,
    v_client,
    'Workflow Ops Sender',
    'Workflow Ops Sender',
    TRUE,
    'active'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:workflow-studio-operation-handlers-ui-registry-fixture-bootstrap'
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'workflow-ops-' || left(v_user::text, 8) || '@example.com',
    'Workflow Ops Client Admin',
    'client_admin',
    'client',
    v_client
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is(
    COALESCE((
      SELECT value->>'relation'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
      WHERE value->>'key' = 'operation_handlers'
      LIMIT 1
    ), ''),
    'public.v_operation_handler_directory',
    'operation_handlers registry reads through scoped catalog projection'
  );

  PERFORM is(
    COALESCE((
      SELECT value#>>'{scope_columns,client}'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
      WHERE value->>'key' = 'operation_handlers'
      LIMIT 1
    ), ''),
    'client_id',
    'operation_handlers registry declares client scope column'
  );

  PERFORM is(
    COALESCE((
      SELECT value->>'write_relation'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
      WHERE value->>'key' = 'operation_handlers'
      LIMIT 1
    ), ''),
    'public.operation_handlers',
    'operation_handlers registry writes through canonical handler table'
  );

  PERFORM is(
    COALESCE((
      SELECT value#>>'{scope_columns,sender}'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
      WHERE value->>'key' = 'operation_handlers'
      LIMIT 1
    ), ''),
    'sender_id',
    'operation_handlers registry declares sender scope column'
  );

  v_result := public.ui_list_resource_v1('operation_handlers', '{}'::jsonb, 5, 0, NULL);

  PERFORM ok(
    jsonb_typeof(v_result->'items') = 'array',
    'ui_list_resource_v1(operation_handlers) returns array items'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(v_result->'keys', '[]'::jsonb)) AS value
      WHERE value = 'handler_key'
    ),
    'ui_list_resource_v1(operation_handlers) includes handler_key in keys'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(v_result->'keys', '[]'::jsonb)) AS value
      WHERE value = 'ui_label'
    ),
    'ui_list_resource_v1(operation_handlers) includes ui_label in keys'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(v_result->'keys', '[]'::jsonb)) AS value
      WHERE value = 'ui_category'
    ),
    'ui_list_resource_v1(operation_handlers) includes ui_category in keys'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(v_result->'keys', '[]'::jsonb)) AS value
      WHERE value = 'ui_description'
    ),
    'ui_list_resource_v1(operation_handlers) includes ui_description in keys'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(v_result->'keys', '[]'::jsonb)) AS value
      WHERE value = 'config_schema_category'
    ),
    'ui_list_resource_v1(operation_handlers) includes config_schema_category in keys'
  );

  PERFORM ok(
    COALESCE((
      SELECT ui_label = 'Outbound HTTP'
      FROM public.operation_handlers
      WHERE handler_key = 'outbound_http'
    ), FALSE),
    'outbound_http ui_label is set for palette'
  );

  PERFORM ok(
    COALESCE((
      SELECT ui_category = 'HTTP'
      FROM public.operation_handlers
      WHERE handler_key = 'outbound_http'
    ), FALSE),
    'outbound_http ui_category is set for palette'
  );

  PERFORM ok(
    COALESCE((
      SELECT ui_description IS NOT NULL
      FROM public.operation_handlers
      WHERE handler_key = 'outbound_http'
    ), FALSE),
    'outbound_http ui_description is present'
  );

  PERFORM ok(
    COALESCE((
      SELECT ui_category = 'Labels'
      FROM public.operation_handlers
      WHERE handler_key = 'label_job'
    ), FALSE),
    'label_job ui_category is Labels'
  );

  PERFORM ok(
    COALESCE((
      SELECT ui_label IS NOT NULL
      FROM public.operation_handlers
      WHERE handler_key = 'label_job'
    ), FALSE),
    'label_job ui_label is present'
  );

  PERFORM ok(
    COALESCE((
      SELECT ui_category = 'Workflow'
      FROM public.operation_handlers
      WHERE handler_key = 'workflow_control'
    ), FALSE),
    'workflow_control ui_category is Workflow'
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
