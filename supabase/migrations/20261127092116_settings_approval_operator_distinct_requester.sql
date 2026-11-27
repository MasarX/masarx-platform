BEGIN;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.settings_approval_operator_task_resolve_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_task_type_key TEXT;
  v_manual_review_task_id UUID;
  v_outcome TEXT;
  v_user_id UUID;
  v_review public.manual_review_tasks%ROWTYPE;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.status, '') IS NOT DISTINCT FROM COALESCE(OLD.status, '') THEN
    RETURN NEW;
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = NEW.task_type_id;

  IF v_task_type_key IS DISTINCT FROM 'settings_approval' THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_manual_review_task_id := NULLIF(NEW.metadata->>'manual_review_task_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_manual_review_task_id := NULL;
  END;

  IF v_manual_review_task_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_outcome := CASE
    WHEN lower(NEW.status) IN ('completed', 'approved') THEN 'approved'
    WHEN lower(NEW.status) IN ('rejected', 'canceled', 'cancelled') THEN 'rejected'
    ELSE NULL
  END;

  IF v_outcome IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_review
    FROM public.manual_review_tasks mrt
   WHERE mrt.id = v_manual_review_task_id
   FOR UPDATE;

  IF NOT FOUND OR v_review.status = 'resolved' THEN
    RETURN NEW;
  END IF;

  SELECT auth.uid() INTO v_user_id;

  IF EXISTS (
    SELECT 1
      FROM public.settings_versions sv
     WHERE sv.requested_by = v_user_id
       AND (
         (v_review.resource_type = 'settings_version' AND sv.id = v_review.resource_id)
         OR (
           v_review.task_type = 'settings_approval'
           AND (v_review.resource_type IS DISTINCT FROM 'settings_version' OR v_review.resource_id IS NULL)
           AND EXISTS (
             SELECT 1
               FROM public.workflow_runs wr
              WHERE wr.id::text = v_review.metadata->>'workflow_run_id'
                AND wr.context->>'resource_id' = sv.id::text
                AND public.resolve_workflow_context_org_id(wr.context, wr.workflow_template_id) = v_review.organization_id
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'settings_approval_operator_task_resolve_v1 cannot resolve your own request'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.manual_review_tasks
     SET status = 'resolved',
         resolution_outcome = v_outcome,
         resolution_notes = COALESCE(NULLIF(NEW.status_reason, ''), 'Resolved from operator Review Queue task'),
         resolved_by = v_user_id,
         resolved_at = now(),
         metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'operator_task_id', NEW.id,
           'operator_task_status', NEW.status
         )),
         updated_at = now()
   WHERE id = v_manual_review_task_id;

  PERFORM public.log_decision(
    p_organization_id := v_review.organization_id,
    p_decision_category := 'manual_review',
    p_resource_type := 'manual_review_task',
    p_resource_id := v_manual_review_task_id,
    p_decision_point := 'resolve_task',
    p_decision_outcome := v_outcome,
    p_performed_by_system := 'settings_approval_operator_task_resolve_v1',
    p_correlation_id := NULL,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'operator_task_id', NEW.id,
      'operator_task_status', NEW.status,
      'task_type', 'settings_approval',
      'resource_type', v_review.resource_type,
      'resource_id', v_review.resource_id
    )),
    p_decision_reason := COALESCE(NULLIF(NEW.status_reason, ''), 'Resolved from operator Review Queue task')
  );

  RETURN NEW;
END;
$function$;

COMMIT;
