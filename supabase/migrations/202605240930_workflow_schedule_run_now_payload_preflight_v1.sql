-- Migration: Workflow schedule Run-now payload preflight
-- Purpose: Manual Run-now and the recurring worker must not create workflow
-- runs that are known to fail because task_enqueue_dynamic payloads are absent.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.workflow_schedule_trigger_preflight_v1(
  p_trigger public.workflow_schedule_triggers,
  p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_step RECORD;
  v_payload_path TEXT;
  v_task_payload JSONB;
  v_reason TEXT;
BEGIN
  IF p_trigger.id IS NULL THEN
    RAISE EXCEPTION 'workflow_schedule_trigger_preflight_v1 requires workflow_schedule_triggers row';
  END IF;

  FOR v_step IN
    SELECT
      id,
      operation_name,
      handler_key,
      metadata,
      sequence_order
    FROM public.workflow_template_steps
    WHERE workflow_template_id = p_trigger.workflow_template_id
      AND enabled = TRUE
      AND handler_key = 'task_enqueue_dynamic'
    ORDER BY sequence_order ASC, id ASC
  LOOP
    v_payload_path := COALESCE(
      NULLIF(btrim(COALESCE(v_step.metadata->>'task_path', '')), ''),
      '$.context.binding_payload.task'
    );

    v_task_payload := public.safe_jsonpath_query_first(
      jsonb_build_object(
        'context', COALESCE(p_context, '{}'::jsonb),
        'operation_result', '{}'::jsonb
      ),
      v_payload_path
    );

    IF v_task_payload IS NULL OR jsonb_typeof(v_task_payload) <> 'object' THEN
      v_reason := format(
        'workflow_schedule_trigger_preflight: missing object at %s for operation %s',
        v_payload_path,
        COALESCE(NULLIF(v_step.operation_name, ''), v_step.id::text)
      );

      RETURN jsonb_build_object(
        'ok', FALSE,
        'status', 'preflight_failed',
        'reason', v_reason,
        'workflow_schedule_trigger_id', p_trigger.id,
        'workflow_template_id', p_trigger.workflow_template_id,
        'workflow_template_step_id', v_step.id,
        'operation_name', v_step.operation_name,
        'handler_key', v_step.handler_key,
        'payload_path', v_payload_path
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'status', 'preflight_ok',
    'workflow_schedule_trigger_id', p_trigger.id,
    'workflow_template_id', p_trigger.workflow_template_id
  );
END;
$$;

COMMENT ON FUNCTION public.workflow_schedule_trigger_preflight_v1(public.workflow_schedule_triggers, JSONB)
  IS 'Fail-closed preflight for workflow_schedule_triggers before starting task_enqueue_dynamic templates.';

REVOKE ALL ON FUNCTION public.workflow_schedule_trigger_preflight_v1(public.workflow_schedule_triggers, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_schedule_trigger_preflight_v1(public.workflow_schedule_triggers, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_schedule_trigger_preflight_v1(public.workflow_schedule_triggers, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.run_workflow_schedule_triggers_worker()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_items_processed INT := 0;
  v_error BOOLEAN := FALSE;
  v_row public.workflow_schedule_triggers%ROWTYPE;
  v_now TIMESTAMPTZ := public.workflow_now();
  v_run_id UUID;
  v_context_payload JSONB;
  v_preflight JSONB;
  v_preflight_reason TEXT;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_schedule_triggers_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('workflow_schedule_triggers_worker');

  FOR v_row IN
    SELECT *
    FROM public.workflow_schedule_triggers
    WHERE enabled = TRUE
      AND next_run_at <= v_now
    ORDER BY next_run_at ASC, id ASC
    LIMIT LEAST(v_throttle.batch_size, 100)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_items_processed := v_items_processed + 1;
    BEGIN
      v_context_payload := public.build_workflow_schedule_trigger_context_v1(
        v_row,
        'worker',
        v_context,
        v_row.next_run_at,
        NULL
      );

      v_preflight := public.workflow_schedule_trigger_preflight_v1(v_row, v_context_payload);
      IF COALESCE((v_preflight->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
        v_error := TRUE;
        v_preflight_reason := COALESCE(v_preflight->>'reason', 'workflow schedule preflight failed');

        UPDATE public.workflow_schedule_triggers
        SET
          last_run_at = v_now,
          last_run_id = NULL,
          last_error = v_preflight_reason,
          last_error_at = v_now,
          next_run_at = public.workflow_schedule_trigger_next_run_at(v_row.schedule, v_now),
          updated_at = now()
        WHERE id = v_row.id;

        CONTINUE;
      END IF;

      v_run_id := public.start_workflow_run(v_row.workflow_template_id, v_context_payload);

      UPDATE public.workflow_schedule_triggers
      SET
        last_run_at = v_now,
        last_run_id = v_run_id,
        last_error = NULL,
        last_error_at = NULL,
        next_run_at = public.workflow_schedule_trigger_next_run_at(v_row.schedule, v_now),
        updated_at = now()
      WHERE id = v_row.id;
    EXCEPTION
      WHEN others THEN
        v_error := TRUE;
        UPDATE public.workflow_schedule_triggers
        SET
          last_run_at = v_now,
          last_run_id = NULL,
          last_error = SQLERRM,
          last_error_at = v_now,
          next_run_at = public.workflow_schedule_trigger_next_run_at(v_row.schedule, v_now),
          updated_at = now()
        WHERE id = v_row.id;
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error, v_items_processed);
  PERFORM public.update_cron_config('workflow_schedule_triggers_worker');

  RETURN json_build_object(
    'status', 'completed',
    'items_processed', v_items_processed,
    'error', v_error
  );
END;
$$;

COMMENT ON FUNCTION public.run_workflow_schedule_triggers_worker()
  IS 'Start workflow runs from workflow_schedule_triggers when due; fail closed before known-invalid task_enqueue_dynamic schedules.';

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
  v_preflight JSONB;
  v_preflight_reason TEXT;
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

  v_preflight := public.workflow_schedule_trigger_preflight_v1(v_row, v_context);
  IF COALESCE((v_preflight->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    v_preflight_reason := COALESCE(v_preflight->>'reason', 'workflow schedule preflight failed');

    UPDATE public.workflow_schedule_triggers
    SET
      last_error = v_preflight_reason,
      last_error_at = v_now,
      updated_at = now()
    WHERE id = v_row.id;

    RETURN jsonb_build_object(
      'status', 'preflight_failed',
      'workflow_schedule_trigger_id', v_row.id,
      'workflow_template_id', v_row.workflow_template_id,
      'workflow_run_id', NULL,
      'last_error', v_preflight_reason,
      'last_error_at', v_now,
      'preflight', v_preflight
    );
  END IF;

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
  IS 'Console V2 workflow schedule Run-now wrapper. Requires workflows.write, preflights task payloads, and persists backend readback for no-reload visibility.';

REVOKE ALL ON FUNCTION public.ui_run_workflow_schedule_trigger_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_run_workflow_schedule_trigger_v1(UUID) TO authenticated, service_role;

COMMIT;
