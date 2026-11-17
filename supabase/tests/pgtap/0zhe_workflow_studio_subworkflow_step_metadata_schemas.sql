-- Plan: PLAN-202601-workflow-studio-dnd / Step: S95
-- pgTAP: Ensure schema_registry + operation_handlers are configured for subworkflow steps.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Subworkflow Schema Org', 'subworkflow-schema-org-' || left(v_org::text, 8));

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (
    v_client,
    v_org,
    'Subworkflow Schema Client',
    'subworkflow-schema-client-' || left(v_client::text, 8),
    'active'
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
