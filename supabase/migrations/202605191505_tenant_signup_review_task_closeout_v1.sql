-- Migration: close tenant signup review tasks when a review decision is applied.
-- Purpose:
--   - The review request, task queue, and workflow run must agree after an
--     operator approves or rejects a tenant signup request.
--   - Keep the operator workflow no-reload friendly by closing the backend
--     task and progressing the short binding workflow in the same review RPC.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605191505_tenant_signup_review_task_closeout_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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

  RETURN jsonb_build_object(
    'ok', true,
    'closed_task_count', v_closed_count,
    'progressed_workflow_count', v_progressed_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_signup_review_apply_v1(
  p_request_id UUID,
  p_decision TEXT,
  p_reviewer_user_id UUID DEFAULT NULL,
  p_decision_reason TEXT DEFAULT NULL,
  p_invited_auth_user_id UUID DEFAULT NULL,
  p_invite_email_sent BOOLEAN DEFAULT FALSE,
  p_invite_redirect_to TEXT DEFAULT NULL,
  p_decision_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_metadata JSONB := COALESCE(p_decision_metadata, '{}'::jsonb);
  v_result JSONB;
  v_closeout JSONB;
  v_invite_error TEXT;
  v_invite_requested BOOLEAN := FALSE;
  v_invite_sent BOOLEAN := COALESCE(p_invite_email_sent, FALSE);
  v_error_at TIMESTAMPTZ;
BEGIN
  IF NOT public.request_role_is_service_claim_v1() THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'service_role_required')
    );
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  v_result := public.tenant_signup_review_apply_v1_impl_202605031930(
    p_request_id,
    p_decision,
    p_reviewer_user_id,
    p_decision_reason,
    p_invited_auth_user_id,
    p_invite_email_sent,
    p_invite_redirect_to,
    v_metadata
  );

  IF COALESCE((v_result->>'ok')::boolean, false)
     AND COALESCE((v_result->>'already_processed')::boolean, false) IS FALSE
     AND lower(COALESCE(v_result->>'status', v_result->>'decision', '')) IN ('approved', 'rejected') THEN
    v_closeout := public.tenant_signup_review_closeout_tasks_v1(
      p_request_id,
      COALESCE(v_result->>'status', p_decision),
      p_reviewer_user_id,
      jsonb_strip_nulls(v_metadata || jsonb_build_object(
        'source', COALESCE(v_metadata->>'source', 'tenant_signup_review_apply_v1'),
        'decision_reason', p_decision_reason
      ))
    );
    v_result := v_result || jsonb_build_object('task_closeout', v_closeout);
  END IF;

  v_invite_error := NULLIF(btrim(COALESCE(v_metadata->>'invite_error', '')), '');
  v_invite_requested := lower(COALESCE(v_metadata->>'invite_email_requested', 'false'))
    IN ('true', 't', '1', 'yes', 'on');
  v_invite_sent := v_invite_sent
    OR lower(COALESCE(v_metadata->>'invite_email_sent', 'false')) IN ('true', 't', '1', 'yes', 'on');

  IF COALESCE(v_result->>'ok', 'false') = 'true'
     AND lower(COALESCE(v_result->>'status', v_result->>'decision', '')) = 'approved'
     AND v_invite_requested
     AND NOT v_invite_sent
     AND v_invite_error IS NOT NULL THEN
    UPDATE public.tenant_signup_requests
       SET last_error_code = 'invite_email_failed',
           last_error_message = left(v_invite_error, 800),
           last_error_at = COALESCE(last_error_at, now()),
           updated_at = now()
     WHERE id = p_request_id
       AND status = 'approved'
     RETURNING last_error_at INTO v_error_at;

    IF FOUND THEN
      v_result := COALESCE(v_result, '{}'::jsonb)
        || jsonb_build_object(
          'last_error_code', 'invite_email_failed',
          'last_error_message', left(v_invite_error, 800),
          'last_error_at', v_error_at
        );
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

DO $do$
DECLARE
  v_req record;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  FOR v_req IN
    SELECT id, review_decision, reviewed_by, decision_metadata
      FROM public.tenant_signup_requests
     WHERE status IN ('approved', 'rejected')
  LOOP
    PERFORM public.tenant_signup_review_closeout_tasks_v1(
      v_req.id,
      COALESCE(v_req.review_decision, 'approved'),
      v_req.reviewed_by,
      COALESCE(v_req.decision_metadata, '{}'::jsonb) || jsonb_build_object('repair_source', '202605191505_tenant_signup_review_task_closeout_v1')
    );
  END LOOP;
END;
$do$;

REVOKE ALL ON FUNCTION public.tenant_signup_review_closeout_tasks_v1(UUID, TEXT, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_review_closeout_tasks_v1(UUID, TEXT, UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.tenant_signup_review_closeout_tasks_v1(UUID, TEXT, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_signup_review_closeout_tasks_v1(UUID, TEXT, UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) TO service_role;

COMMENT ON FUNCTION public.tenant_signup_review_closeout_tasks_v1(UUID, TEXT, UUID, JSONB)
  IS 'Service-only closeout for tenant_signup_review tasks and their short binding workflow after a tenant signup review decision is applied.';
COMMENT ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) IS
  'Service-claim-only tenant signup review entrypoint. Delegates provisioning, closes review tasks, progresses the binding workflow, and preserves approved-signup invite email failures in canonical readback fields.';

SELECT pg_advisory_unlock(hashtext('202605191505_tenant_signup_review_task_closeout_v1'));

COMMIT;
