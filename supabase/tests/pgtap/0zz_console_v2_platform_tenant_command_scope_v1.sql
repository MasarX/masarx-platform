-- pgTAP: Console workflow commands use the receiving scoped workflow boundary.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- The command authority in 202609041020_workflow_progress_access_boundary_v1.sql
-- derives the actor organization and checks template visibility.
SELECT matches(
  pg_get_functiondef('public.ui_execute_command_v1(text,text,text[],text,integer,jsonb)'::regprocedure),
  'workflow_template_scope_allowed\(v_template_scope_type, v_template_scope_id\)',
  'workflow command validates the selected template against the actor scope'
);

SELECT matches(
  pg_get_functiondef('public.ui_execute_command_v1(text,text,text[],text,integer,jsonb)'::regprocedure),
  '''organization_id'', public.current_user_org_id\(\)',
  'workflow command derives organization lineage from the authenticated actor'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') AS resource(value)
     WHERE resource.value->>'key' = 'shipments'
       AND resource.value->>'relation' = 'public.shipments'
       AND resource.value#>>'{scope_columns,tenant}' = 'organization_id'
  ),
  'shipments read registry exposes the tenant scope needed for platform command validation'
);

SELECT * FROM finish();

ROLLBACK;
