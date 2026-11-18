-- Keep workflow failure diagnostics type-compatible when the step error is absent.

CREATE OR REPLACE FUNCTION public.run_task_completion_effects_v1(
  p_task_id UUID,
  p_task_event_id UUID,
  p_actor_system TEXT DEFAULT 'dispatch_exception_resolution',
  p_context_overrides JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_task public.tasks%ROWTYPE;
  v_task_event public.task_events%ROWTYPE;
  v_task_type_key TEXT := NULL;
  v_template_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_step RECORD;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF COALESCE(v_role, '') NOT IN ('service_role', 'supabase_admin') AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 requires service_role context'
      USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL OR p_task_event_id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 requires task_id and task_event_id';
  END IF;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = p_task_id
   LIMIT 1;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task % not found', p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
    INTO v_task_event
    FROM public.task_events te
   WHERE te.id = p_task_event_id
     AND te.task_id = p_task_id
   LIMIT 1;

  IF v_task_event.id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task_event % not found for task %', p_task_event_id, p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id
   LIMIT 1;

  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task_type missing for task %', p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT wt.id
    INTO v_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = 'task_completion_effects_v1'
     AND wt.status = 'active'
   ORDER BY wt.version DESC, wt.updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task_completion_effects_v1 template missing'
      USING ERRCODE = '23503';
  END IF;

  v_workflow_run_id := public.start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_task.organization_id,
        'client_id', v_task.client_id,
        'sender_id', v_task.sender_id,
        'resource_type', COALESCE(NULLIF(btrim(COALESCE(v_task.resource_type, '')), ''), 'task'),
        'resource_id', COALESCE(v_task.resource_id, v_task.id),
        'payload', jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_task.organization_id,
          'client_id', v_task.client_id,
          'sender_id', v_task.sender_id,
          'resource_type', v_task.resource_type,
          'resource_id', v_task.resource_id,
          'task_id', v_task.id,
          'task_event_id', v_task_event.id,
          'task_type_key', lower(v_task_type_key),
          'task_event_payload', COALESCE(v_task_event.payload, '{}'::jsonb),
          'task_event_created_at', v_task_event.created_at,
          'actor_user_id', v_task_event.actor_user_id,
          'actor_system', COALESCE(NULLIF(btrim(COALESCE(p_actor_system, '')), ''), 'dispatch_exception_resolution')
        ))
      ) || COALESCE(p_context_overrides, '{}'::jsonb)
    )
  );

  v_progress := public.progress_workflow_run(v_workflow_run_id);

  SELECT
    wr.workflow_status,
    wr.last_error,
    wts.operation_result,
    wts.last_error AS step_last_error
  INTO v_step
  FROM public.workflow_runs wr
  LEFT JOIN public.workflow_run_steps wts
    ON wts.workflow_run_id = wr.id
  WHERE wr.id = v_workflow_run_id
  ORDER BY wts.sequence_order DESC NULLS LAST
  LIMIT 1;

  IF COALESCE(v_step.workflow_status, '') IN ('failed', 'blocked', 'cancelled') THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 failed for task %: %',
      p_task_id,
      COALESCE(v_step.step_last_error, v_step.last_error::TEXT, 'workflow_failed');
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', v_workflow_run_id,
    'workflow_status', v_step.workflow_status,
    'progress_status', v_progress->>'status',
    'operation_result', v_step.operation_result
  ));
END;
$function$;

COMMENT ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB)
  IS 'Service-only helper that starts the canonical task_completion_effects_v1 workflow for a specific completed task event and returns the terminal step result.';

REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) TO service_role;
