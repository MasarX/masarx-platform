-- Migration: Manual review resolve requires assignee
-- Purpose:
--   - Prevent resolving manual review tasks until an assignee is set.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_manual_review_resolve_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_org UUID := COALESCE(NULLIF(v_ctx->>'organization_id', '')::UUID, current_user_org_id());
    v_task_id UUID;
    v_task_id_text TEXT := COALESCE(
        p_operation_result->>'manual_review_task_id',
        p_step.operation_result->>'manual_review_task_id',
        v_ctx->>'manual_review_task_id'
    );
    v_resolution TEXT := COALESCE(NULLIF(p_operation_result->>'resolution_notes', ''), p_step.metadata->>'resolution_notes');
    v_assigned_to UUID;
    v_policy_row RECORD;
    v_defaults JSONB;
    v_poll_seconds INT := NULL;
    v_poll_min INT := NULL;
    v_poll_max INT := NULL;
    v_resp workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, pg_temp', false);

    IF v_task_id_text IS NOT NULL AND btrim(v_task_id_text) <> '' THEN
        v_task_id := v_task_id_text::UUID;
    END IF;
    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'manual_review_resolve: manual_review_task_id missing';
    END IF;

    SELECT assigned_to
    INTO v_assigned_to
    FROM manual_review_tasks
    WHERE id = v_task_id;

    IF v_assigned_to IS NULL THEN
        SELECT *
          INTO v_policy_row
          FROM public.resolve_settings_row_from_context('workflow_defaults', v_ctx)
         LIMIT 1;
        v_defaults := v_policy_row.value;
        IF v_defaults IS NULL THEN
          v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
        END IF;
        IF v_defaults IS NULL THEN
          RAISE EXCEPTION 'workflow_defaults_missing';
        END IF;

        BEGIN
          v_poll_seconds := NULLIF(v_defaults->>'poll_seconds', '')::INT;
        EXCEPTION
          WHEN others THEN
            v_poll_seconds := NULL;
        END;
        IF v_poll_seconds IS NULL THEN
          RAISE EXCEPTION 'workflow_defaults.poll_seconds missing';
        END IF;

        BEGIN
          v_poll_min := NULLIF(v_defaults->>'poll_seconds_min', '')::INT;
        EXCEPTION
          WHEN others THEN
            v_poll_min := NULL;
        END;
        BEGIN
          v_poll_max := NULLIF(v_defaults->>'poll_seconds_max', '')::INT;
        EXCEPTION
          WHEN others THEN
            v_poll_max := NULL;
        END;

        v_poll_min := COALESCE(v_poll_min, v_poll_seconds);
        v_poll_max := COALESCE(v_poll_max, v_poll_seconds);
        v_poll_seconds := LEAST(GREATEST(v_poll_seconds, v_poll_min), v_poll_max);

        v_resp.status := 'pending';
        v_resp.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_resp.next_run_at := now() + make_interval(secs => v_poll_seconds);
        v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'resolved', FALSE,
          'reason', 'assigned_to_missing',
          'next_poll_seconds', v_poll_seconds
        ));
        RETURN v_resp;
    END IF;

    UPDATE manual_review_tasks
    SET status = 'resolved',
        resolution_notes = COALESCE(v_resolution, resolution_notes),
        resolved_at = now(),
        updated_at = now()
    WHERE id = v_task_id;

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'manual_review',
        p_resource_type := 'manual_review_task',
        p_resource_id := v_task_id,
        p_decision_point := 'resolve_task',
        p_decision_outcome := 'resolved',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('resolution_notes', v_resolution),
        p_decision_reason := NULL
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id, 'resolution_notes', v_resolution);
    RETURN v_resp;
END;
$function$;

COMMIT;
