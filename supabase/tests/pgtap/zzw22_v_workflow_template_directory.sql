-- pgTAP: public.v_workflow_template_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W22 (paired projection views — WORKFLOWS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_workflow_template_directory',
  'public.v_workflow_template_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_workflow_template_directory',
  ARRAY[
    'id', 'workflow_template_id', 'template_id',
    'name', 'description', 'version', 'status',
    'scope_type', 'scope_id', 'created_by', 'created_at',
    'published_at', 'retired_at', 'notes', 'steps_checksum',
    'step_count', 'active_run_count', 'total_run_count',
    'last_run_at', 'last_run_status',
    'binding_count', 'is_published'
  ],
  'v_workflow_template_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_workflow_template_directory', 'SELECT'),
  'service_role has SELECT on v_workflow_template_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_workflow_template_directory', 'SELECT'),
  'anon has no SELECT on v_workflow_template_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_workflow_template_directory', 'SELECT'),
  'authenticated has SELECT on v_workflow_template_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'workflow_templates'
       AND c.relkind = 'r'
  ),
  'public.workflow_templates remains a base table (SSOT preserved)'
);

-- 7) Projection: template + steps + active run resolves counters through the view.
DO $$
DECLARE
  v_template UUID := '00000000-0000-0000-0000-00000022b001';
  v_step1   UUID := '00000000-0000-0000-0000-00000022b002';
  v_step2   UUID := '00000000-0000-0000-0000-00000022b003';
  v_run     UUID := '00000000-0000-0000-0000-00000022b004';
  v_step_count INT;
  v_active_run_count INT;
  v_total_run_count INT;
  v_template_id_proj TEXT;
  v_is_published BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.workflow_templates (
    id, name, version, status, scope_type, published_at
  )
  VALUES (
    v_template, 'W22 Template Directory Test', 2, 'active', 'global',
    '2026-04-30T09:00:00Z'::timestamptz
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_template_steps (
    id, workflow_template_id, sequence_order, operation_name,
    transition_condition, manual_action_required, handler_key
  )
  VALUES
    (v_step1, v_template, 1, 'shipments.create_v1', 'always', FALSE, 'context_set_defaults'),
    (v_step2, v_template, 2, 'webhook.respond',     'success', FALSE, 'compute_webhook_ack')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.workflow_run_id', v_run::text, true);

  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point,
    workflow_status, started_at, retry_count
  )
  VALUES (
    v_run, v_template, 2, 'webhook', 'in_progress',
    '2026-04-30T10:00:00Z'::timestamptz, 0
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT step_count, active_run_count, total_run_count, template_id, is_published
    INTO v_step_count, v_active_run_count, v_total_run_count, v_template_id_proj, v_is_published
    FROM public.v_workflow_template_directory
   WHERE id = v_template;

  PERFORM ok(
    v_step_count = 2
      AND v_active_run_count = 1
      AND v_total_run_count = 1
      AND v_template_id_proj LIKE 'TPL-W22-TEMPLATE-DIRECTORY-TEST-V%'
      AND v_is_published = TRUE,
    'v_workflow_template_directory derives step_count + active_run_count + total_run_count + template_id (TPL-*-V*) + is_published'
  );
END;
$$;

-- 8) is_published = FALSE when status='active' but published_at IS NULL.
DO $$
DECLARE
  v_template UUID := '00000000-0000-0000-0000-00000022b011';
  v_is_published BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.workflow_templates (
    id, name, version, status, scope_type, published_at
  )
  VALUES (
    v_template, 'W22 Unpublished Active Test', 1, 'active', 'global', NULL
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT is_published
    INTO v_is_published
    FROM public.v_workflow_template_directory
   WHERE id = v_template;

  PERFORM ok(
    v_is_published = FALSE,
    'v_workflow_template_directory.is_published = FALSE when published_at IS NULL even if status=active'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
