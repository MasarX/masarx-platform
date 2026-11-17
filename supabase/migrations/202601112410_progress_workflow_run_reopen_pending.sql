-- Migration: Reopen completed workflow runs when pending steps exist
-- Purpose:
--   - Allow progress_workflow_run to resume when pending steps were left behind.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-11

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

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
  v_run_status TEXT;
  v_has_pending BOOLEAN;
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

  SELECT workflow_status
  INTO v_run_status
  FROM public.workflow_runs
  WHERE id = p_workflow_run_id;

  IF v_run_status = 'completed' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.workflow_run_steps
      WHERE workflow_run_id = p_workflow_run_id
        AND step_status = 'pending'
    )
    INTO v_has_pending;

    IF v_has_pending THEN
      UPDATE public.workflow_runs
      SET workflow_status = 'in_progress',
          completed_at = NULL,
          updated_at = now()
      WHERE id = p_workflow_run_id;
    END IF;
  END IF;

  -- No in-progress steps: defer to the base engine.
  RETURN public.progress_workflow_run_base(p_workflow_run_id, p_operation_result);
END;
$function$;

COMMENT ON FUNCTION public.progress_workflow_run(uuid, jsonb)
  IS 'Workflow engine dispatcher with in-progress guard and pending-step reopen support.';

COMMIT;
