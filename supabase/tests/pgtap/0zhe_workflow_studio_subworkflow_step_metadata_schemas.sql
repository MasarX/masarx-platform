-- Plan: PLAN-202601-workflow-studio-dnd / Step: S95
-- pgTAP: Ensure schema_registry + operation_handlers are configured for subworkflow steps.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Subworkflow Schema Org', 'subworkflow-schema-org-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (
    v_client,
    v_org,
    'Subworkflow Schema Client',
    'subworkflow-schema-client-' || left(v_client::text, 8),
    'active'
  );

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    gen_random_uuid(),
    v_client,
    'Subworkflow Schema Sender',
    'Subworkflow Schema Sender',
    TRUE,
    'active'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:workflow-studio-subworkflow-step-metadata-schemas-fixture-bootstrap'
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'subworkflow-schema-' || left(v_user::text, 8) || '@example.com',
    'Subworkflow Schema Admin',
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
      WHERE value->>'key' = 'schema_registry'
      LIMIT 1
    ), ''),
    'public.v_schema_registry_directory',
    'schema_registry reads through scoped catalog projection'
  );

  PERFORM is(
    COALESCE((
      SELECT value#>>'{scope_columns,client}'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
      WHERE value->>'key' = 'schema_registry'
      LIMIT 1
    ), ''),
    'client_id',
    'schema_registry declares client scope column'
  );

  PERFORM is(
    COALESCE((
      SELECT value->>'write_relation'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
      WHERE value->>'key' = 'schema_registry'
      LIMIT 1
    ), ''),
    'public.schema_registry',
    'schema_registry writes through canonical schema table'
  );

  PERFORM is(
    COALESCE((
      SELECT value#>>'{scope_columns,sender}'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
      WHERE value->>'key' = 'schema_registry'
      LIMIT 1
    ), ''),
    'sender_id',
    'schema_registry declares sender scope column'
  );

  -- schema_registry entries are readable by workflow studio users
  v_result := public.ui_list_resource_v1(
    'schema_registry',
    jsonb_build_object('category', 'workflow_step_start_workflow_metadata', 'is_active', true),
    1,
    0,
    NULL
  );

  PERFORM ok(
    jsonb_typeof(v_result->'items') = 'array' AND jsonb_array_length(v_result->'items') >= 1,
    'schema_registry has workflow_step_start_workflow_metadata v1 active'
  );

  PERFORM ok(
    COALESCE((
      SELECT
        schema->'x-masarx'->>'extends' = 'workflow_template_step_metadata'
        AND schema->'properties' ? 'child_workflow_template_id'
        AND schema->'properties'->'child_workflow_template_id'->'x-ui'->>'widget' = 'resource_select'
      FROM public.schema_registry
      WHERE category = 'workflow_step_start_workflow_metadata'
        AND version = 1
    ), FALSE),
    'workflow_step_start_workflow_metadata extends base and uses resource_select for child_workflow_template_id'
  );

  v_result := public.ui_list_resource_v1(
    'schema_registry',
    jsonb_build_object('category', 'workflow_step_wait_workflow_metadata', 'is_active', true),
    1,
    0,
    NULL
  );

  PERFORM ok(
    jsonb_typeof(v_result->'items') = 'array' AND jsonb_array_length(v_result->'items') >= 1,
    'schema_registry has workflow_step_wait_workflow_metadata v1 active'
  );

  -- operation_handlers config_schema_category routes to handler-specific schema
  v_result := public.ui_list_resource_v1(
    'operation_handlers',
    jsonb_build_object('handler_key', 'start_workflow', 'is_active', true),
    1,
    0,
    NULL
  );

  PERFORM ok(
    jsonb_typeof(v_result->'items') = 'array' AND jsonb_array_length(v_result->'items') = 1,
    'operation_handlers returns start_workflow'
  );

  PERFORM is(
    (v_result->'items'->0->>'config_schema_category'),
    'workflow_step_start_workflow_metadata',
    'start_workflow config_schema_category points to workflow_step_start_workflow_metadata'
  );

  v_result := public.ui_list_resource_v1(
    'operation_handlers',
    jsonb_build_object('handler_key', 'wait_workflow', 'is_active', true),
    1,
    0,
    NULL
  );

  PERFORM ok(
    jsonb_typeof(v_result->'items') = 'array' AND jsonb_array_length(v_result->'items') = 1,
    'operation_handlers returns wait_workflow'
  );

  PERFORM is(
    (v_result->'items'->0->>'config_schema_category'),
    'workflow_step_wait_workflow_metadata',
    'wait_workflow config_schema_category points to workflow_step_wait_workflow_metadata'
  );

  PERFORM ok(
    COALESCE((
      SELECT schema->'properties'->'operation_template_id'->'x-ui'->>'widget' = 'resource_select'
      FROM public.schema_registry
      WHERE category = 'workflow_template_step_metadata'
        AND version = 1
    ), FALSE),
    'workflow_template_step_metadata includes x-ui widget for operation_template_id'
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
