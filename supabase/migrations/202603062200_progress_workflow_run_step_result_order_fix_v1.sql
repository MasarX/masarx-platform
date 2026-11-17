-- Migration: progress_workflow_run_step_result_v1 sequence-aware ordering fix
-- Purpose:
--   - Let external step results target the next logical workflow step even when later-sequence control steps have earlier run_at timestamps.
--   - Preserve fail-closed ordering by rejecting only true earlier-sequence blockers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603062200_progress_workflow_run_step_result_order_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.progress_workflow_run_step_result_v1(
  p_workflow_run_id uuid,
  p_workflow_run_step_id uuid,
  p_operation_result jsonb DEFAULT '{}'::jsonb,
  p_budget_ms int DEFAULT NULL,
  p_max_steps int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_run public.workflow_runs%ROWTYPE;
  v_step public.workflow_run_steps%ROWTYPE;
  v_payload jsonb := COALESCE(p_operation_result, '{}'::jsonb);
  v_blocking_step_id uuid := NULL;
  v_min_other_run_at timestamptz := NULL;
  v_target_run_at timestamptz := NULL;
BEGIN
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'progress_workflow_run_step_result_v1 requires workflow_run_id';
  END IF;
  IF p_workflow_run_step_id IS NULL THEN
    RAISE EXCEPTION 'progress_workflow_run_step_result_v1 requires workflow_run_step_id';
  END IF;
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'progress_workflow_run_step_result_v1 requires object operation_result';
  END IF;

  SELECT *
  INTO v_run
  FROM public.workflow_runs
  WHERE id = p_workflow_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'progress_workflow_run_step_result_v1 workflow_run not found %', p_workflow_run_id;
  END IF;

  SELECT *
  INTO v_step
  FROM public.workflow_run_steps
  WHERE id = p_workflow_run_step_id
    AND workflow_run_id = p_workflow_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'progress_workflow_run_step_result_v1 workflow_run_step not found % for run %', p_workflow_run_step_id, p_workflow_run_id;
  END IF;

  IF v_run.workflow_status IN ('completed', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object(
      'workflow_run_id', p_workflow_run_id,
      'workflow_run_step_id', p_workflow_run_step_id,
      'status', 'terminal',
      'workflow_status', v_run.workflow_status
    );
  END IF;

  IF v_step.step_status = 'completed' THEN
    RETURN jsonb_build_object(
      'workflow_run_id', p_workflow_run_id,
      'workflow_run_step_id', p_workflow_run_step_id,
      'status', 'already_completed',
      'workflow_status', v_run.workflow_status
    );
  END IF;

  IF v_step.step_status <> 'pending' THEN
    RETURN jsonb_build_object(
      'workflow_run_id', p_workflow_run_id,
      'workflow_run_step_id', p_workflow_run_step_id,
      'status', 'not_pending',
      'workflow_status', v_run.workflow_status,
      'step_status', v_step.step_status
    );
  END IF;

  SELECT wrs.id
  INTO v_blocking_step_id
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.step_status = 'pending'
    AND wrs.sequence_order < v_step.sequence_order
  ORDER BY wrs.sequence_order
  LIMIT 1
  FOR UPDATE;

  IF v_blocking_step_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'workflow_run_id', p_workflow_run_id,
      'workflow_run_step_id', p_workflow_run_step_id,
      'status', 'out_of_order',
      'workflow_status', v_run.workflow_status,
      'blocking_step_id', v_blocking_step_id
    );
  END IF;

  SELECT MIN(wrs.run_at)
  INTO v_min_other_run_at
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.step_status = 'pending'
    AND wrs.id <> p_workflow_run_step_id;

  v_target_run_at := COALESCE(
    LEAST(
      clock_timestamp(),
      COALESCE(v_min_other_run_at - interval '1 millisecond', clock_timestamp())
    ),
    clock_timestamp()
  );

  UPDATE public.workflow_run_steps
  SET run_at = LEAST(COALESCE(run_at, v_target_run_at), v_target_run_at),
      updated_at = now()
  WHERE id = p_workflow_run_step_id;

  RETURN public.progress_workflow_run_until_wait_v1(
    p_workflow_run_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'workflow_run_step_id', p_workflow_run_step_id,
        'external_step_result', true
      ) || v_payload
    ),
    p_budget_ms,
    p_max_steps
  );
END;
$$;

COMMENT ON FUNCTION public.progress_workflow_run_step_result_v1(uuid, uuid, jsonb, int, int)
  IS 'Validate and deliver an external step result into the next logical pending workflow step, then advance the workflow until its next wait boundary.';

REVOKE ALL ON FUNCTION public.progress_workflow_run_step_result_v1(uuid, uuid, jsonb, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.progress_workflow_run_step_result_v1(uuid, uuid, jsonb, int, int) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.progress_workflow_run_step_result_v1(uuid, uuid, jsonb, int, int) TO edge_label_renderer_role;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603062200_progress_workflow_run_step_result_order_fix_v1'));
COMMIT;
