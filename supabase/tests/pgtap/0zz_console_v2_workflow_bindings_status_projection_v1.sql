-- pgTAP: Console V2 workflow binding projection separates operator enabled
-- status from canonical configurability posture.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(15);

SELECT ok(
  to_regclass('public.workflow_bindings_console_v1') IS NOT NULL,
  'workflow_bindings_console_v1 exists'
);

SELECT ok(
  pg_get_viewdef('public.workflow_bindings_console_v1'::regclass, true) LIKE '%COALESCE(fs.is_enabled, true)%active%'
  AND pg_get_viewdef('public.workflow_bindings_console_v1'::regclass, true) LIKE '%ELSE ''disabled''%',
  'workflow_bindings_console_v1 projects operator status from stage is_enabled'
);

SELECT ok(
  pg_get_viewdef('public.workflow_bindings_console_v1'::regclass, true) LIKE '%wbr.configurability_status%',
  'workflow_bindings_console_v1 keeps canonical configurability_status visible separately'
);

SELECT ok(
  pg_get_viewdef('public.workflow_bindings_console_v1'::regclass, true) NOT LIKE '%wbr.configurability_status AS status%',
  'workflow_bindings_console_v1 no longer feeds configurability posture into operator status'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workflow_binding_stage_registry'
      AND column_name = 'workflow_template_id'
      AND udt_name = 'uuid'
  ),
  'workflow_binding_stage_registry stores the stage workflow_template_id for Console readback'
);

SELECT ok(
  pg_get_viewdef('public.workflow_bindings_console_v1'::regclass, true) LIKE '%COALESCE(ld.workflow_template_id, fs.workflow_template_id)%'
  AND pg_get_viewdef('public.workflow_bindings_console_v1'::regclass, true) LIKE '%wbsr.workflow_template_id%',
  'workflow_bindings_console_v1 resolves template_id from stage registry before any dispatch exists'
);

SELECT ok(
  pg_get_functiondef('public.register_workflow_binding_v1(jsonb)'::regprocedure) LIKE '%INSERT INTO public.workflow_binding_registry%'
  AND pg_get_functiondef('public.register_workflow_binding_v1(jsonb)'::regprocedure) LIKE '%INSERT INTO public.workflow_binding_stage_registry%',
  'register_workflow_binding_v1 mirrors Console registrations into registry and stage rows'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workflow_binding_stage_registry'
      AND column_name = 'condition'
      AND udt_name = 'jsonb'
  ),
  'workflow_binding_stage_registry stores the stage condition for Console readback'
);

SELECT ok(
  pg_get_viewdef('public.workflow_bindings_console_v1'::regclass, true) LIKE '%fs.condition%'
  AND pg_get_functiondef('public.register_workflow_binding_v1(jsonb)'::regprocedure) LIKE '%''condition'', v_condition%',
  'register_workflow_binding_v1 and workflow_bindings_console_v1 keep binding conditions refreshable'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values row ON row.lookup_definition_id = ld.id
    WHERE ld.category = 'workflow_binding_status'
      AND row.value = 'active'
      AND row.label = 'Active'
      AND row.is_default
      AND row.metadata->>'toggle_to' = 'disabled'
      AND row.metadata->>'is_enabled' = 'true'
  ),
  'workflow_binding_status.active resolves with toggle metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values row ON row.lookup_definition_id = ld.id
    WHERE ld.category = 'workflow_binding_status'
      AND row.value = 'disabled'
      AND row.label = 'Disabled'
      AND row.metadata->>'toggle_to' = 'active'
      AND row.metadata->>'is_enabled' = 'false'
  ),
  'workflow_binding_status.disabled resolves with re-enable metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values row ON row.lookup_definition_id = ld.id
    WHERE ld.category = 'workflow_binding_status'
      AND row.value = 'paused'
      AND row.label = 'Paused'
      AND row.metadata->>'action_label' = 'Pause'
  ),
  'workflow_binding_status.paused resolves for row-driven action metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'workflow_binding_defaults'
      AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
  ),
  'workflow_binding_defaults is registered as a hard-fail category with global default'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'workflow_binding_defaults'
      AND version = 1
      AND is_active
      AND schema->'required' ? 'default_priority'
      AND schema->'required' ? 'default_stage'
      AND schema->'required' ? 'default_scope_type'
      AND schema->'required' ? 'condition_max_depth'
  ),
  'workflow_binding_defaults schema requires the create-modal defaults'
);

SELECT is(
  public.resolve_settings('workflow_binding_defaults', 'global', NULL::uuid),
  jsonb_build_object(
    'default_priority', 10,
    'default_stage', 'default',
    'default_scope_type', 'tenant',
    'condition_max_depth', 3
  ),
  'workflow_binding_defaults resolves global Console create defaults'
);

SELECT * FROM finish();

ROLLBACK;
