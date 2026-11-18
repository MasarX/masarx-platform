-- pgTAP: Console V2 platform tenant command scope must preserve the active
-- tenant on workflow-backed row actions instead of starting workflows under
-- the platform organization.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  pg_get_functiondef('public.ui_execute_command_v1(text,text,text[],text,integer,jsonb)'::regprocedure)
    LIKE '%v_effective_org_id UUID := public.current_user_org_id()%',
  'ui_execute_command_v1 computes an effective organization for workflow commands'
);

SELECT ok(
  pg_get_functiondef('public.ui_execute_command_v1(text,text,text[],text,integer,jsonb)'::regprocedure)
    LIKE '%public.resolve_settings_merged(''ui_read_registry'', v_scope_type, v_scope_id)%',
  'ui_execute_command_v1 validates platform tenant overrides through ui_read_registry'
);

SELECT ok(
  pg_get_functiondef('public.ui_execute_command_v1(text,text,text[],text,integer,jsonb)'::regprocedure)
    LIKE '%v_read_resource#>>ARRAY[''scope_columns'', ''tenant'']%',
  'ui_execute_command_v1 uses the row-driven tenant scope column contract'
);

SELECT ok(
  pg_get_functiondef('public.ui_execute_command_v1(text,text,text[],text,integer,jsonb)'::regprocedure)
    LIKE '%''organization_id'', v_effective_org_id%',
  'ui_execute_command_v1 writes the effective organization into workflow payload and context'
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
