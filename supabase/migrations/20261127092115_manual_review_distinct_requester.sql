BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.resolve_manual_review_task_v1(p_task_id uuid, p_resolution_outcome text, p_resolution_notes text DEFAULT NULL::text)
 RETURNS manual_review_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_user_id UUID;
  v_task public.manual_review_tasks%ROWTYPE;
  v_outcome TEXT := lower(COALESCE(NULLIF(p_resolution_outcome, ''), ''));
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_manual_review_task_v1 requires an authenticated user';
  END IF;
  IF NOT public.user_has_resource_capability_v1('manual_review_tasks','write') THEN
    RAISE EXCEPTION 'resolve_manual_review_task_v1 requires manual_review.resolve capability';
  END IF;
  IF v_outcome NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Unsupported resolution_outcome % (expected approved|rejected)', p_resolution_outcome
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_task
    FROM public.manual_review_tasks mrt
   WHERE mrt.id = p_task_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual_review_task not found: %', p_task_id;
  END IF;

  IF NOT public.is_platform_user() AND v_task.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'manual_review_task % is outside current tenant scope', p_task_id
      USING ERRCODE = '42501';
  END IF;

  IF v_task.status = 'resolved' THEN
    RETURN v_task;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings_versions sv
     WHERE sv.requested_by = v_user_id
       AND (
         (v_task.resource_type = 'settings_version' AND sv.id = v_task.resource_id)
         OR (
           v_task.task_type = 'settings_approval'
           AND (v_task.resource_type IS DISTINCT FROM 'settings_version' OR v_task.resource_id IS NULL)
           AND EXISTS (
             SELECT 1
               FROM public.workflow_runs wr
              WHERE wr.id::text = v_task.metadata->>'workflow_run_id'
                AND wr.context->>'resource_id' = sv.id::text
                AND public.resolve_workflow_context_org_id(wr.context, wr.workflow_template_id) = v_task.organization_id
           )
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.zone_override_requests zor
     WHERE zor.organization_id = v_task.organization_id
       AND zor.requested_by = v_user_id
       AND (
         zor.manual_review_task_id = v_task.id
         OR (v_task.resource_type = 'zone_override_request' AND zor.id = v_task.resource_id)
       )
  ) THEN
    RAISE EXCEPTION 'resolve_manual_review_task_v1 cannot resolve your own request'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.manual_review_tasks
     SET status = 'resolved',
         resolution_outcome = v_outcome,
         resolution_notes = p_resolution_notes,
         resolved_by = v_user_id,
         resolved_at = now(),
         updated_at = now()
   WHERE id = p_task_id
   RETURNING * INTO v_task;

  PERFORM public.log_decision(
      p_organization_id := v_task.organization_id,
      p_decision_category := 'manual_review',
      p_resource_type := 'manual_review_task',
      p_resource_id := p_task_id,
      p_decision_point := 'resolve_task',
      p_decision_outcome := v_outcome,
      p_performed_by_system := 'resolve_manual_review_task_v1',
      p_correlation_id := NULL,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type', v_task.task_type,
        'resource_type', v_task.resource_type,
        'resource_id', v_task.resource_id
      )),
      p_decision_reason := p_resolution_notes
  );

  RETURN v_task;
END;
$function$;

COMMIT;
