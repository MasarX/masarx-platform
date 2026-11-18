-- Migration: Workflow schedule Run-now Console V2 capability alignment
-- Purpose: Console V2 gates schedule Run-now on workflows.write; the backend
-- RPC must assert the same canonical capability instead of legacy
-- workflow_runs.write so read-only/limited operators see one permission truth.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ui_run_workflow_schedule_trigger_v1(
  p_workflow_schedule_trigger_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_row public.workflow_schedule_triggers%ROWTYPE;
  v_context JSONB;
  v_run_id UUID;
  v_now TIMESTAMPTZ := public.workflow_now();
BEGIN
  IF p_workflow_schedule_trigger_id IS NULL THEN
    RAISE EXCEPTION 'ui_run_workflow_schedule_trigger_v1 requires workflow_schedule_trigger_id';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write', v_scope_type, v_scope_id);

  SELECT *
  INTO v_row
  FROM public.workflow_schedule_triggers
  WHERE id = p_workflow_schedule_trigger_id
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ui_run_workflow_schedule_trigger_v1 schedule trigger not found';
  END IF;

  v_context := public.build_workflow_schedule_trigger_context_v1(
    v_row,
    'manual',
    NULL,
    NULL,
    auth.uid()
  );

  v_run_id := public.start_workflow_run(v_row.workflow_template_id, v_context);

  UPDATE public.workflow_schedule_triggers
  SET
    last_run_at = v_now,
    last_run_id = v_run_id,
    last_error = NULL,
    last_error_at = NULL,
    updated_at = now()
  WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'status', 'workflow_started',
    'workflow_schedule_trigger_id', v_row.id,
    'workflow_template_id', v_row.workflow_template_id,
    'workflow_run_id', v_run_id,
    'last_run_at', v_now
  );
END;
$$;

COMMENT ON FUNCTION public.ui_run_workflow_schedule_trigger_v1(UUID)
  IS 'Console V2 workflow schedule Run-now wrapper. Requires workflows.write, starts the scheduled template, and persists last_run_id/last_run_at for no-reload readback.';

REVOKE ALL ON FUNCTION public.ui_run_workflow_schedule_trigger_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_run_workflow_schedule_trigger_v1(UUID) TO authenticated, service_role;

COMMIT;
