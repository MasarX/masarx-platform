-- Return persisted task closeout evidence in the signup review result.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261122027000_tenant_signup_closeout_evidence'));

CREATE OR REPLACE FUNCTION public.tenant_signup_review_closeout_tasks_v1(
  p_request_id uuid,
  p_decision text,
  p_reviewer_user_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_decision text := lower(NULLIF(btrim(COALESCE(p_decision, '')), ''));
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_task record;
  v_next_version int;
  v_event_id uuid;
  v_decision_id uuid;
  v_decision_log_ids uuid[] := ARRAY[]::uuid[];
  v_task_event_ids uuid[] := ARRAY[]::uuid[];
  v_closed_count int := 0;
  v_progressed_count int := 0;
  v_workflow record;
BEGIN
  IF NOT public.request_role_is_service_claim_v1() THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object('code', 'service_role_required')
    );
  END IF;

  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object('code', 'request_id_required')
    );
  END IF;

  IF v_decision IN ('approve') THEN
    v_decision := 'approved';
  ELSIF v_decision IN ('reject') THEN
    v_decision := 'rejected';
  END IF;

  IF v_decision NOT IN ('approved', 'rejected') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', jsonb_build_object('code', 'invalid_decision')
    );
  END IF;

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  FOR v_task IN
    SELECT
      t.*
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
    WHERE t.resource_type = 'tenant_signup_request'
      AND t.resource_id = p_request_id
      AND tt.key = 'tenant_signup_review'
      AND lower(COALESCE(t.status, '')) NOT IN ('completed', 'canceled', 'cancelled', 'rejected', 'expired')
    ORDER BY t.created_at
    FOR UPDATE OF t
  LOOP
    v_event_id := NULL;
    v_next_version := COALESCE(v_task.version, 0) + 1;

    v_decision_id := public.log_decision(
      p_organization_id := v_task.organization_id,
      p_decision_category := 'task',
      p_resource_type := 'task',
      p_resource_id := v_task.id,
      p_decision_point := 'tenant_signup_review_closeout',
      p_decision_outcome := 'status_changed',
      p_performed_by_system := 'tenant_signup_review_apply_v1',
      p_correlation_id := public.current_correlation_id(),
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'from_status', v_task.status,
        'to_status', 'completed',
        'review_decision', v_decision,
        'tenant_signup_request_id', p_request_id
      )),
      p_decision_reason := NULL,
      p_settings_resolution_id := NULL
    );

    UPDATE public.tasks
       SET status = 'completed',
           status_reason = 'tenant signup review ' || v_decision,
           version = v_next_version,
           started_at = COALESCE(started_at, now()),
           completed_at = COALESCE(completed_at, now()),
           metadata = public.jsonb_deep_merge(
             COALESCE(metadata, '{}'::jsonb),
             jsonb_build_object(
               'tenant_signup_review', jsonb_build_object(
                 'decision', v_decision,
                 'request_id', p_request_id,
                 'reviewed_by', p_reviewer_user_id,
                 'reviewed_at', now()
               )
             )
           ),
           updated_at = now()
     WHERE id = v_task.id;

    IF NOT EXISTS (
      SELECT 1
        FROM public.task_events te
       WHERE te.task_id = v_task.id
         AND te.idempotency_key = 'tenant_signup_review_task_closeout:' || p_request_id::text || ':' || v_task.id::text
    ) THEN
      INSERT INTO public.task_events (
        task_id,
        organization_id,
        event_type,
        from_status,
        to_status,
        actor_user_id,
        actor_system,
        payload,
        idempotency_key,
        task_version,
        decision_log_id,
        settings_resolution_id
      )
      VALUES (
        v_task.id,
        v_task.organization_id,
        'status_changed',
        v_task.status,
        'completed',
        p_reviewer_user_id,
        'tenant_signup_review_apply_v1',
        jsonb_strip_nulls(v_payload || jsonb_build_object(
          'status_reason', 'tenant signup review ' || v_decision,
          'review_decision', v_decision,
          'tenant_signup_request_id', p_request_id,
          'correlation_id', public.current_correlation_id()
        )),
        'tenant_signup_review_task_closeout:' || p_request_id::text || ':' || v_task.id::text,
        v_next_version,
        v_decision_id,
        NULL
      )
      RETURNING id INTO v_event_id;
    END IF;

    IF v_decision_id IS NOT NULL THEN
      v_decision_log_ids := array_append(v_decision_log_ids, v_decision_id);
    END IF;
    IF v_event_id IS NOT NULL THEN
      v_task_event_ids := array_append(v_task_event_ids, v_event_id);
    END IF;
    v_closed_count := v_closed_count + 1;
  END LOOP;

  FOR v_workflow IN
    SELECT wr.id
      FROM public.workflow_runs wr
     WHERE wr.workflow_status = 'in_progress'
       AND wr.failure_reason IS NULL
       AND wr.context::text LIKE '%' || p_request_id::text || '%'
     ORDER BY wr.created_at
  LOOP
    BEGIN
      PERFORM public.progress_workflow_run(v_workflow.id, '{}'::jsonb);
      v_progressed_count := v_progressed_count + 1;
    EXCEPTION
      WHEN others THEN
        UPDATE public.workflow_runs
           SET metadata = public.jsonb_deep_merge(
                 COALESCE(metadata, '{}'::jsonb),
                 jsonb_build_object(
                   'tenant_signup_review_closeout_warning',
                   jsonb_build_object('message', SQLERRM, 'sqlstate', SQLSTATE, 'at', now())
                 )
               ),
               updated_at = now()
         WHERE id = v_workflow.id;
    END;
  END LOOP;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'closed_task_count', v_closed_count,
    'progressed_workflow_count', v_progressed_count,
    'decision_log_id', v_decision_log_ids[1],
    'decision_log_ids', to_jsonb(v_decision_log_ids),
    'task_event_id', v_task_event_ids[1],
    'task_event_ids', to_jsonb(v_task_event_ids)
  ));
END;
$function$;

COMMIT;
