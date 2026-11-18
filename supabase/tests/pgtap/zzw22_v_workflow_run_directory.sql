-- pgTAP: public.v_workflow_run_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W22 (paired projection views — WORKFLOWS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_workflow_run_directory',
  'public.v_workflow_run_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_workflow_run_directory',
  ARRAY[
    'id', 'run_id', 'workflow_template_id', 'template_id',
    'template_name', 'template_version',
    'workflow_status', 'status', 'entry_point', 'triggered_by',
    'failure_reason', 'error',
    'started_at', 'completed_at', 'created_at', 'updated_at',
    'duration_ms', 'correlation_id',
    'retry_count', 'max_retries', 'context', 'metadata',
    'last_error', 'current_step_id', 'workflow_template_version'
  ],
  'v_workflow_run_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_workflow_run_directory', 'SELECT'),
  'service_role has SELECT on v_workflow_run_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_workflow_run_directory', 'SELECT'),
  'anon has no SELECT on v_workflow_run_directory'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_workflow_run_directory', 'SELECT'),
  'authenticated has SELECT on v_workflow_run_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'workflow_runs'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.workflow_runs remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a workflow + run, verify projections resolve through the view.
DO $$
DECLARE
  v_template UUID := '00000000-0000-0000-0000-00000022a001';
  v_run     UUID := '00000000-0000-0000-0000-00000022a002';
  v_run_id_proj TEXT;
  v_template_name TEXT;
  v_duration_ms INT;
  v_status TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.workflow_templates (
    id, name, version, status, scope_type
  )
  VALUES (
    v_template, 'W22 Run Directory Test', 1, 'active', 'global'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.workflow_run_id', v_run::text, true);

  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point,
    workflow_status, started_at, completed_at, retry_count
  )
  VALUES (
    v_run, v_template, 1, 'webhook', 'completed',
    '2026-04-30T10:00:00Z'::timestamptz,
    '2026-04-30T10:00:01.500Z'::timestamptz,
    0
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT run_id, template_name, duration_ms, status
    INTO v_run_id_proj, v_template_name, v_duration_ms, v_status
    FROM public.v_workflow_run_directory
   WHERE id = v_run;

  PERFORM ok(
    v_run_id_proj LIKE 'WFR-%'
      AND v_template_name = 'W22 Run Directory Test'
      AND v_duration_ms = 1500
      AND v_status = 'completed',
    'v_workflow_run_directory projects run_id (WFR-*) + template_name + duration_ms + status legacy alias'
  );
END;
$$;

-- 8) duration_ms = NULL when completed_at is NULL (running run).
DO $$
DECLARE
  v_template UUID := '00000000-0000-0000-0000-00000022a011';
  v_run_running UUID := '00000000-0000-0000-0000-00000022a012';
  v_duration INT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.workflow_templates (
    id, name, version, status, scope_type
  )
  VALUES (
    v_template, 'W22 Running Run Test', 1, 'active', 'global'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.workflow_run_id', v_run_running::text, true);

  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point,
    workflow_status, started_at, completed_at, retry_count
  )
  VALUES (
    v_run_running, v_template, 1, 'webhook', 'in_progress',
    '2026-04-30T11:00:00Z'::timestamptz,
    NULL,
    0
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT duration_ms
    INTO v_duration
    FROM public.v_workflow_run_directory
   WHERE id = v_run_running;

  PERFORM ok(
    v_duration IS NULL,
    'v_workflow_run_directory.duration_ms = NULL for in-progress run (no completed_at)'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
