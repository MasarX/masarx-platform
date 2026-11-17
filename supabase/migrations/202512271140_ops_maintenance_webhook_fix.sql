-- Plan: PLAN-202512-ops-maintenance-universal / Step: S04
BEGIN;

CREATE OR REPLACE FUNCTION public.ops_maintenance_retry_webhook_inbox(p_task JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_task_key TEXT := NULLIF(btrim(p_task->>'task_key'), '');
  v_args JSONB := COALESCE(p_task->'arguments', '{}'::jsonb);

  v_batch_size INT := COALESCE(NULLIF(v_args->>'batch_size', '')::INT, 100);
  v_statuses TEXT[] := ARRAY['failed'];
  v_max_retries_default INT := COALESCE(NULLIF(v_args->>'max_retries', '')::INT, 3);
  v_backoff_default JSONB := COALESCE(v_args->'backoff_seconds', '[]'::jsonb);
  v_quarantine_after_minutes_default INT := NULLIF(v_args->>'quarantine_after_minutes', '')::INT;
  v_next_action_default TEXT := NULLIF(btrim(v_args->>'next_action'), '');
  v_now TIMESTAMPTZ := now();

  v_requeued INT := 0;
  v_quarantined INT := 0;
  v_skipped INT := 0;
  v_backoff_wait INT := 0;
  v_errors INT := 0;

  v_row RECORD;
  v_context JSONB;
  v_policy_row RECORD;
  v_task_config JSONB;
  v_task_args JSONB;
  v_max_retries INT;
  v_backoff JSONB;
  v_quarantine_after_minutes INT;
  v_next_action TEXT;
  v_next_retry_count INT;
  v_backoff_seconds INT;
  v_last_attempt TIMESTAMPTZ;
  v_age_seconds INT;
  v_age_minutes INT;
  v_settings_resolution_id UUID;
BEGIN
  IF jsonb_typeof(v_args->'statuses') = 'array' THEN
    SELECT array_agg(value)
      INTO v_statuses
      FROM jsonb_array_elements_text(v_args->'statuses') a(value);
  END IF;
  IF v_statuses IS NULL OR array_length(v_statuses, 1) IS NULL THEN
    v_statuses := ARRAY['failed'];
  END IF;

  FOR v_row IN
    SELECT wi.id,
           wi.retry_count,
           wi.max_retries,
           wi.processing_status,
           wi.error_message,
           wi.processed_at,
           wi.created_at,
           wi.correlation_id,
           wi.webhook_source_id,
           ws.organization_id,
           ws.sender_id,
           s.client_id
      FROM public.webhook_inbox wi
      JOIN public.webhook_sources ws ON ws.id = wi.webhook_source_id
      LEFT JOIN public.senders s ON s.id = ws.sender_id
     WHERE wi.processing_status = ANY(v_statuses)
       AND NOT EXISTS (
         SELECT 1
         FROM public.ops_quarantine oq
         WHERE oq.resource_type = 'webhook_inbox'
           AND oq.resource_id = wi.id
           AND oq.status = 'open'
       )
     ORDER BY COALESCE(wi.processed_at, wi.created_at) ASC
     LIMIT GREATEST(COALESCE(v_batch_size, 100), 1)
     FOR UPDATE OF wi SKIP LOCKED
  LOOP
    BEGIN
      v_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_row.organization_id,
        'webhook_source_id', v_row.webhook_source_id,
        'sender_id', v_row.sender_id,
        'client_id', v_row.client_id
      ));

      v_policy_row := NULL;
      v_task_config := p_task;
      v_task_args := v_args;

      SELECT *
        INTO v_policy_row
        FROM public.resolve_settings_row_from_context('ops_maintenance_policy', v_context)
       LIMIT 1;

      IF FOUND AND v_policy_row.value IS NOT NULL AND v_task_key IS NOT NULL THEN
        v_task_config := COALESCE(public.ops_maintenance_extract_task(v_policy_row.value, v_task_key), p_task);
        v_task_args := COALESCE(v_task_config->'arguments', '{}'::jsonb);
      END IF;

      v_max_retries := COALESCE(v_row.max_retries, NULLIF(v_task_args->>'max_retries', '')::INT, v_max_retries_default);
      IF v_max_retries IS NULL THEN
        v_max_retries := v_max_retries_default;
      END IF;

      v_backoff := COALESCE(v_task_args->'backoff_seconds', v_backoff_default);
      v_quarantine_after_minutes := COALESCE(NULLIF(v_task_args->>'quarantine_after_minutes', '')::INT, v_quarantine_after_minutes_default);
      v_next_action := COALESCE(NULLIF(btrim(v_task_args->>'next_action'), ''), v_next_action_default);

      v_next_retry_count := COALESCE(v_row.retry_count, 0) + 1;
      v_backoff_seconds := public.ops_maintenance_pick_backoff(v_backoff, v_next_retry_count);
      v_last_attempt := COALESCE(v_row.processed_at, v_row.created_at, v_now);
      v_age_seconds := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - v_last_attempt)))::INT);
      v_age_minutes := GREATEST(0, FLOOR(v_age_seconds / 60.0)::INT);

      v_settings_resolution_id := NULL;
      IF v_policy_row.settings_id IS NOT NULL THEN
        v_settings_resolution_id := public.log_settings_resolution(
          p_organization_id := v_row.organization_id,
          p_category := 'ops_maintenance_policy',
          p_winning_scope_type := v_policy_row.scope_type,
          p_winning_scope_id := v_policy_row.scope_id,
          p_winning_settings_id := v_policy_row.settings_id,
          p_winning_settings_version_id := v_policy_row.settings_version_id,
          p_winning_version := v_policy_row.version,
          p_scope_path := v_policy_row.scope_path,
          p_inputs := jsonb_strip_nulls(jsonb_build_object(
            'task_key', v_task_key,
            'resource_type', 'webhook_inbox',
            'resource_id', v_row.id,
            'retry_count', v_row.retry_count,
            'max_retries', v_max_retries
          )),
          p_merge_notes := NULL
        );
      END IF;

      IF v_quarantine_after_minutes IS NOT NULL AND v_age_minutes >= v_quarantine_after_minutes THEN
        PERFORM public.enqueue_ops_quarantine(
          p_organization_id := v_row.organization_id,
          p_resource_type := 'webhook_inbox',
          p_resource_id := v_row.id,
          p_reason := 'stale_retry_window_exceeded',
          p_next_action := v_next_action,
          p_details := jsonb_strip_nulls(jsonb_build_object(
            'status', v_row.processing_status,
            'retry_count', v_row.retry_count,
            'max_retries', v_max_retries,
            'error_message', v_row.error_message,
            'last_attempt_at', v_last_attempt,
            'age_minutes', v_age_minutes,
            'task_key', v_task_key
          )),
          p_settings_resolution_id := v_settings_resolution_id
        );

        PERFORM public.log_decision(
          p_organization_id := v_row.organization_id,
          p_decision_category := 'ops_maintenance',
          p_resource_type := 'webhook_inbox',
          p_resource_id := v_row.id,
          p_decision_point := COALESCE(v_task_key, 'retry_webhook_inbox'),
          p_decision_outcome := 'quarantined',
          p_performed_by_system := 'ops_maintenance_worker',
          p_correlation_id := v_row.correlation_id,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'reason', 'stale_retry_window_exceeded',
            'retry_count', v_row.retry_count,
            'max_retries', v_max_retries,
            'age_minutes', v_age_minutes
          )),
          p_decision_reason := 'Webhook inbox entry exceeded quarantine window.',
          p_settings_resolution_id := v_settings_resolution_id
        );

        v_quarantined := v_quarantined + 1;
        CONTINUE;
      END IF;

      IF v_next_retry_count > v_max_retries THEN
        PERFORM public.enqueue_ops_quarantine(
          p_organization_id := v_row.organization_id,
          p_resource_type := 'webhook_inbox',
          p_resource_id := v_row.id,
          p_reason := 'max_retries_exhausted',
          p_next_action := v_next_action,
          p_details := jsonb_strip_nulls(jsonb_build_object(
            'status', v_row.processing_status,
            'retry_count', v_row.retry_count,
            'max_retries', v_max_retries,
            'error_message', v_row.error_message,
            'task_key', v_task_key
          )),
          p_settings_resolution_id := v_settings_resolution_id
        );

        PERFORM public.log_decision(
          p_organization_id := v_row.organization_id,
          p_decision_category := 'ops_maintenance',
          p_resource_type := 'webhook_inbox',
          p_resource_id := v_row.id,
          p_decision_point := COALESCE(v_task_key, 'retry_webhook_inbox'),
          p_decision_outcome := 'quarantined',
          p_performed_by_system := 'ops_maintenance_worker',
          p_correlation_id := v_row.correlation_id,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'reason', 'max_retries_exhausted',
            'retry_count', v_row.retry_count,
            'max_retries', v_max_retries
          )),
          p_decision_reason := 'Webhook inbox entry exceeded max retries.',
          p_settings_resolution_id := v_settings_resolution_id
        );

        v_quarantined := v_quarantined + 1;
        CONTINUE;
      END IF;

      IF v_age_seconds < v_backoff_seconds THEN
        v_backoff_wait := v_backoff_wait + 1;
        CONTINUE;
      END IF;

      UPDATE public.webhook_inbox
         SET processing_status = 'pending',
             retry_count = v_next_retry_count,
             max_retries = COALESCE(v_row.max_retries, v_max_retries),
             processed_at = NULL,
             error_message = NULL,
             lease_expires_at = NULL
       WHERE id = v_row.id;

      PERFORM public.log_decision(
        p_organization_id := v_row.organization_id,
        p_decision_category := 'ops_maintenance',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_row.id,
        p_decision_point := COALESCE(v_task_key, 'retry_webhook_inbox'),
        p_decision_outcome := 'retry_scheduled',
        p_performed_by_system := 'ops_maintenance_worker',
        p_correlation_id := v_row.correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'retry_count', v_next_retry_count,
          'max_retries', v_max_retries,
          'backoff_seconds', v_backoff_seconds
        )),
        p_decision_reason := 'Requeued failed webhook for retry.',
        p_settings_resolution_id := v_settings_resolution_id
      );

      v_requeued := v_requeued + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      CONTINUE;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'completed',
    'requeued', v_requeued,
    'quarantined', v_quarantined,
    'skipped', v_skipped,
    'backoff_wait', v_backoff_wait,
    'errors', v_errors
  );
END;
$$;

COMMIT;
