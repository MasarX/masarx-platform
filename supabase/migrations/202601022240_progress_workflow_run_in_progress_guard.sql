-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S04
-- Migration: Guard progress_workflow_run against in-progress step fan-out
-- Purpose:
--   The workflow engine can be invoked by safety-net workers (e.g., webhook_processor_worker)
--   while an earlier step is still `in_progress` (waiting for an external event like an
--   outbound HTTP response). Without a guard, later `pending` steps may execute prematurely.
--   This breaks workflows that rely on the completion of the in-progress step (e.g., geocoding
--   decision steps running before provider attempts are recorded).
-- Strategy:
--   Wrap the existing implementation as `progress_workflow_run_base` and short-circuit with a
--   `waiting` response when any step is in-progress and not yet completed.
-- Alignment: SIMPLE, workflow-engine safe, row-driven (no tenant hardcoding).
-- Date: 2026-01-02

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

DO $$
BEGIN
  -- Only rename once; keep idempotent across environments.
  IF to_regprocedure('public.progress_workflow_run_base(uuid,jsonb)') IS NULL
     AND to_regprocedure('public.progress_workflow_run(uuid,jsonb)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.progress_workflow_run(uuid, jsonb) RENAME TO progress_workflow_run_base';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.progress_workflow_run(
  p_workflow_run_id uuid,
  p_operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'workflow_handlers', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_in_progress_step_id UUID;
  v_in_progress_operation TEXT;
  v_defaults JSONB;
  v_poll_seconds INT := 60;
BEGIN
  -- Block advancing other steps while any step is still in-progress.
  SELECT wrs.id, wrs.operation_name
  INTO v_in_progress_step_id, v_in_progress_operation
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.step_status = 'in_progress'
    AND wrs.operation_completed_at IS NULL
  ORDER BY wrs.sequence_order
  LIMIT 1;

  IF v_in_progress_step_id IS NOT NULL THEN
    v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
    BEGIN
      v_poll_seconds := COALESCE(NULLIF(v_defaults->>'poll_seconds', '')::INT, v_poll_seconds);
    EXCEPTION
      WHEN others THEN
        v_poll_seconds := 60;
    END;
    v_poll_seconds := LEAST(GREATEST(v_poll_seconds, 15), 300);

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'workflow_run_id', p_workflow_run_id,
      'status', 'waiting',
      'reason', 'step_in_progress',
      'in_progress_step_id', v_in_progress_step_id,
      'in_progress_operation', v_in_progress_operation,
      'next_run_at', now() + make_interval(secs => v_poll_seconds)
    ));
  END IF;

  -- No in-progress steps: defer to the base engine.
  RETURN public.progress_workflow_run_base(p_workflow_run_id, p_operation_result);
END;
$function$;

COMMENT ON FUNCTION public.progress_workflow_run(uuid, jsonb)
  IS 'Workflow engine dispatcher with an in-progress guard to prevent later pending steps from executing before external responses complete.';

COMMIT;

