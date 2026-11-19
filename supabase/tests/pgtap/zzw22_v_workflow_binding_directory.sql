-- pgTAP: public.v_workflow_binding_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W22 (paired projection views — WORKFLOWS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_workflow_binding_directory',
  'public.v_workflow_binding_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_workflow_binding_directory',
  ARRAY[
    'binding_key', 'id', 'label', 'description',
    'resource_type', 'actor_surface', 'entrypoint_type',
    'current_execution_kind', 'configurability_status',
    'owner', 'migration_phase', 'is_business_affecting',
    'created_at', 'updated_at',
    'stage_count', 'dispatch_count',
    'last_dispatch_at', 'last_dispatch_outcome',
    'default_workflow_template_id', 'default_template_name',
    'last_workflow_run_id',
    'completed_dispatch_count', 'failed_dispatch_count',
    'waiting_dispatch_count', 'started_dispatch_count',
    'is_active'
  ],
  'v_workflow_binding_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_workflow_binding_directory', 'SELECT'),
  'service_role has SELECT on v_workflow_binding_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_workflow_binding_directory', 'SELECT'),
  'anon has no SELECT on v_workflow_binding_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_workflow_binding_directory', 'SELECT'),
  'authenticated has SELECT on v_workflow_binding_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'workflow_binding_registry'
       AND c.relkind = 'r'
  ),
  'public.workflow_binding_registry remains a base table (SSOT preserved)'
);

-- 7) Projection: registry + stage + dispatches resolves counters through the view.
DO $$
DECLARE
  v_template UUID := '00000000-0000-0000-0000-00000022c001';
  v_run     UUID := '00000000-0000-0000-0000-00000022c002';
  v_binding TEXT := 'w22.test.binding.v1';
  v_stage_count INT;
  v_dispatch_count INT;
  v_completed_count INT;
  v_is_active BOOLEAN;
  v_last_outcome TEXT;
  v_default_template_name TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  -- Need workflow_template + run before dispatches.
  INSERT INTO public.workflow_templates (
    id, name, version, status, scope_type
  )
  VALUES (
    v_template, 'W22 Binding Directory Test', 1, 'active', 'global'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.workflow_run_id', v_run::text, true);

  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point,
    workflow_status, retry_count
  )
  VALUES (
    v_run, v_template, 1, 'webhook', 'completed', 0
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_binding_registry (
    binding_key, label, actor_surface, entrypoint_type,
    current_execution_kind, configurability_status, owner, migration_phase
  )
  VALUES (
    v_binding, 'W22 Test Binding', 'edge_function', 'edge',
    'workflow_native', 'workflow_configurable', 'workflows', 'phase_3'
  )
  ON CONFLICT (binding_key) DO NOTHING;

  INSERT INTO public.workflow_binding_stage_registry (
    binding_key, stage_key, label, sequence_order, is_enabled
  )
  VALUES
    (v_binding, 'default', 'Default Stage', 10, TRUE),
    (v_binding, 'retry',   'Retry Stage',   20, TRUE)
  ON CONFLICT (binding_key, stage_key) DO NOTHING;

  -- Two completed dispatches, one failed.
  INSERT INTO public.workflow_binding_dispatches (
    id, binding_key, stage_key, resolved_scope_type, resolved_scope_hash,
    workflow_template_id, workflow_run_id, outcome
  )
  VALUES
    (gen_random_uuid(), v_binding, 'default', 'global', '00000000-0000-0000-0000-000000000000'::uuid, v_template, v_run, 'completed'),
    (gen_random_uuid(), v_binding, 'default', 'global', '00000000-0000-0000-0000-000000000000'::uuid, v_template, v_run, 'completed'),
    (gen_random_uuid(), v_binding, 'retry',   'global', '00000000-0000-0000-0000-000000000000'::uuid, v_template, v_run, 'failed');

  SELECT stage_count, dispatch_count, completed_dispatch_count, is_active,
         last_dispatch_outcome, default_template_name
    INTO v_stage_count, v_dispatch_count, v_completed_count, v_is_active,
         v_last_outcome, v_default_template_name
    FROM public.v_workflow_binding_directory
   WHERE binding_key = v_binding;

  PERFORM ok(
    v_stage_count = 2
      AND v_dispatch_count = 3
      AND v_completed_count = 2
      AND v_is_active = TRUE
      AND v_last_outcome IS NOT NULL
      AND v_default_template_name = 'W22 Binding Directory Test',
    'v_workflow_binding_directory derives stage_count + dispatch_count + per-outcome counters + default_template_name + is_active'
  );
END;
$$;

-- 8) is_active = FALSE when configurability_status != 'workflow_configurable'.
DO $$
DECLARE
  v_binding_locked TEXT := 'w22.locked.binding.v1';
  v_is_active BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.workflow_binding_registry (
    binding_key, label, actor_surface, entrypoint_type,
    current_execution_kind, configurability_status, owner, migration_phase
  )
  VALUES (
    v_binding_locked, 'W22 Locked Binding', 'edge_function', 'edge',
    'direct_rpc', 'not_configurable', 'workflows', 'phase_3'
  )
  ON CONFLICT (binding_key) DO NOTHING;

  SELECT is_active
    INTO v_is_active
    FROM public.v_workflow_binding_directory
   WHERE binding_key = v_binding_locked;

  PERFORM ok(
    v_is_active = FALSE,
    'v_workflow_binding_directory.is_active = FALSE for not_configurable binding'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
