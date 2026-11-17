-- Plan: PLAN-202512-ops-maintenance-universal / Step: S04
-- Migration: Ops maintenance worker (policy-driven retries + quarantine)
-- Purpose:
--   - Provide a universal, row-driven maintenance worker for retries + quarantine.
--   - Log settings provenance + decisions for every retry/quarantine action.
-- Date: 2025-12-27

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1) Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ops_maintenance_extract_task(
  p_policy JSONB,
  p_task_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_task JSONB;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy->'tasks') <> 'array' THEN
    RETURN NULL;
  END IF;

  SELECT value
    INTO v_task
    FROM jsonb_array_elements(p_policy->'tasks')
   WHERE COALESCE(value->>'task_key', '') = COALESCE(p_task_key, '')
   LIMIT 1;

  RETURN v_task;
END;
$$;

COMMENT ON FUNCTION public.ops_maintenance_extract_task(JSONB, TEXT)
  IS 'Extract a task object by task_key from ops_maintenance_policy.tasks.';

CREATE OR REPLACE FUNCTION public.ops_maintenance_pick_backoff(
  p_backoff JSONB,
  p_attempt INT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_seconds INT := 0;
  v_attempt INT := COALESCE(p_attempt, 1);
BEGIN
  IF v_attempt < 1 THEN
    v_attempt := 1;
  END IF;

  IF p_backoff IS NULL OR jsonb_typeof(p_backoff) <> 'array' OR jsonb_array_length(p_backoff) = 0 THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(NULLIF(value, '')::INT, 0)
    INTO v_seconds
    FROM jsonb_array_elements_text(p_backoff) WITH ORDINALITY AS arr(value, idx)
   WHERE idx = LEAST(jsonb_array_length(p_backoff), v_attempt)
   LIMIT 1;

  RETURN GREATEST(COALESCE(v_seconds, 0), 0);
END;
$$;

COMMENT ON FUNCTION public.ops_maintenance_pick_backoff(JSONB, INT)
  IS 'Select a backoff delay (seconds) for the given attempt using a JSONB array.';

-- ---------------------------------------------------------------------------
-- 2) Handler: retry webhook_inbox
-- ---------------------------------------------------------------------------

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

COMMENT ON FUNCTION public.ops_maintenance_retry_webhook_inbox(JSONB)
  IS 'Requeue failed webhook_inbox rows with policy-driven backoff; quarantine exhausted/stale records.';

-- ---------------------------------------------------------------------------
-- 3) Handler: retry domain_events
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ops_maintenance_retry_domain_events(p_task JSONB)
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
    SELECT de.id,
           de.organization_id,
           de.retry_count,
           de.max_retries,
           de.status,
           de.error_reason,
           de.processed_at,
           de.updated_at,
           de.created_at,
           de.correlation_id
      FROM public.domain_events de
     WHERE de.status = ANY(v_statuses)
       AND NOT EXISTS (
         SELECT 1
           FROM public.ops_quarantine oq
          WHERE oq.resource_type = 'domain_event'
            AND oq.resource_id = de.id
            AND oq.status = 'open'
       )
     ORDER BY COALESCE(de.processed_at, de.updated_at, de.created_at) ASC
     LIMIT GREATEST(COALESCE(v_batch_size, 100), 1)
     FOR UPDATE OF de SKIP LOCKED
  LOOP
    BEGIN
      IF v_row.organization_id IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_row.organization_id
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
      v_last_attempt := COALESCE(v_row.processed_at, v_row.updated_at, v_row.created_at, v_now);
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
            'resource_type', 'domain_event',
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
          p_resource_type := 'domain_event',
          p_resource_id := v_row.id,
          p_reason := 'stale_retry_window_exceeded',
          p_next_action := v_next_action,
          p_details := jsonb_strip_nulls(jsonb_build_object(
            'status', v_row.status,
            'retry_count', v_row.retry_count,
            'max_retries', v_max_retries,
            'error_reason', v_row.error_reason,
            'last_attempt_at', v_last_attempt,
            'age_minutes', v_age_minutes,
            'task_key', v_task_key
          )),
          p_settings_resolution_id := v_settings_resolution_id
        );

        PERFORM public.log_decision(
          p_organization_id := v_row.organization_id,
          p_decision_category := 'ops_maintenance',
          p_resource_type := 'domain_event',
          p_resource_id := v_row.id,
          p_decision_point := COALESCE(v_task_key, 'retry_domain_events'),
          p_decision_outcome := 'quarantined',
          p_performed_by_system := 'ops_maintenance_worker',
          p_correlation_id := v_row.correlation_id,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'reason', 'stale_retry_window_exceeded',
            'retry_count', v_row.retry_count,
            'max_retries', v_max_retries,
            'age_minutes', v_age_minutes
          )),
          p_decision_reason := 'Domain event exceeded quarantine window.',
          p_settings_resolution_id := v_settings_resolution_id
        );

        v_quarantined := v_quarantined + 1;
        CONTINUE;
      END IF;

      IF v_next_retry_count > v_max_retries THEN
        PERFORM public.enqueue_ops_quarantine(
          p_organization_id := v_row.organization_id,
          p_resource_type := 'domain_event',
          p_resource_id := v_row.id,
          p_reason := 'max_retries_exhausted',
          p_next_action := v_next_action,
          p_details := jsonb_strip_nulls(jsonb_build_object(
            'status', v_row.status,
            'retry_count', v_row.retry_count,
            'max_retries', v_max_retries,
            'error_reason', v_row.error_reason,
            'task_key', v_task_key
          )),
          p_settings_resolution_id := v_settings_resolution_id
        );

        PERFORM public.log_decision(
          p_organization_id := v_row.organization_id,
          p_decision_category := 'ops_maintenance',
          p_resource_type := 'domain_event',
          p_resource_id := v_row.id,
          p_decision_point := COALESCE(v_task_key, 'retry_domain_events'),
          p_decision_outcome := 'quarantined',
          p_performed_by_system := 'ops_maintenance_worker',
          p_correlation_id := v_row.correlation_id,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'reason', 'max_retries_exhausted',
            'retry_count', v_row.retry_count,
            'max_retries', v_max_retries
          )),
          p_decision_reason := 'Domain event exceeded max retries.',
          p_settings_resolution_id := v_settings_resolution_id
        );

        v_quarantined := v_quarantined + 1;
        CONTINUE;
      END IF;

      IF v_age_seconds < v_backoff_seconds THEN
        v_backoff_wait := v_backoff_wait + 1;
        CONTINUE;
      END IF;

      UPDATE public.domain_events
         SET status = 'pending',
             retry_count = v_next_retry_count,
             max_retries = COALESCE(v_row.max_retries, v_max_retries),
             processed_at = NULL,
             error_reason = NULL,
             updated_at = now()
       WHERE id = v_row.id;

      PERFORM public.log_decision(
        p_organization_id := v_row.organization_id,
        p_decision_category := 'ops_maintenance',
        p_resource_type := 'domain_event',
        p_resource_id := v_row.id,
        p_decision_point := COALESCE(v_task_key, 'retry_domain_events'),
        p_decision_outcome := 'retry_scheduled',
        p_performed_by_system := 'ops_maintenance_worker',
        p_correlation_id := v_row.correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'retry_count', v_next_retry_count,
          'max_retries', v_max_retries,
          'backoff_seconds', v_backoff_seconds
        )),
        p_decision_reason := 'Requeued failed domain event for retry.',
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

COMMENT ON FUNCTION public.ops_maintenance_retry_domain_events(JSONB)
  IS 'Requeue failed domain_events rows with policy-driven backoff; quarantine exhausted/stale records.';

-- ---------------------------------------------------------------------------
-- 4) Handler: quarantine outbound_calls
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ops_maintenance_quarantine_outbound_calls(p_task JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_task_key TEXT := NULLIF(btrim(p_task->>'task_key'), '');
  v_args JSONB := COALESCE(p_task->'arguments', '{}'::jsonb);

  v_batch_size INT := COALESCE(NULLIF(v_args->>'batch_size', '')::INT, 200);
  v_statuses TEXT[] := ARRAY['permanently_failed'];
  v_min_age_minutes_default INT := COALESCE(NULLIF(v_args->>'min_age_minutes', '')::INT, 5);
  v_only_exhausted_default BOOLEAN := COALESCE(NULLIF(v_args->>'only_exhausted', '')::BOOLEAN, TRUE);
  v_next_action_default TEXT := NULLIF(btrim(v_args->>'next_action'), '');
  v_now TIMESTAMPTZ := now();

  v_quarantined INT := 0;
  v_skipped INT := 0;
  v_errors INT := 0;

  v_row RECORD;
  v_context JSONB;
  v_policy_row RECORD;
  v_task_config JSONB;
  v_task_args JSONB;
  v_min_age_minutes INT;
  v_only_exhausted BOOLEAN;
  v_next_action TEXT;
  v_last_attempt TIMESTAMPTZ;
  v_age_seconds INT;
  v_age_minutes INT;
  v_settings_resolution_id UUID;
  v_org UUID;
  v_org_text TEXT;
  v_client_text TEXT;
  v_sender_text TEXT;
  v_uuid_re TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF jsonb_typeof(v_args->'statuses') = 'array' THEN
    SELECT array_agg(value)
      INTO v_statuses
      FROM jsonb_array_elements_text(v_args->'statuses') a(value);
  END IF;
  IF v_statuses IS NULL OR array_length(v_statuses, 1) IS NULL THEN
    v_statuses := ARRAY['permanently_failed'];
  END IF;

  FOR v_row IN
    SELECT oc.id,
           oc.call_type,
           oc.target_type,
           oc.target_id,
           oc.status,
           oc.retry_count,
           oc.max_retries,
           oc.completed_at,
           oc.created_at,
           oc.error_message,
           oc.response_status_code,
           oc.correlation_id,
           oc.shipment_id,
           oc.context,
           COALESCE(p.organization_id, c.organization_id, sc.organization_id) AS organization_id
      FROM public.outbound_calls oc
      LEFT JOIN public.providers p ON oc.target_type = 'provider' AND p.id = oc.target_id
      LEFT JOIN public.clients c ON oc.target_type = 'client' AND c.id = oc.target_id
      LEFT JOIN public.shipments sh ON oc.shipment_id IS NOT NULL AND sh.id = oc.shipment_id
      LEFT JOIN public.clients sc ON sh.client_id = sc.id
     WHERE oc.status = ANY(v_statuses)
       AND NOT EXISTS (
         SELECT 1
           FROM public.ops_quarantine oq
          WHERE oq.resource_type = 'outbound_call'
            AND oq.resource_id = oc.id
            AND oq.status = 'open'
       )
     ORDER BY COALESCE(oc.completed_at, oc.created_at) ASC
     LIMIT GREATEST(COALESCE(v_batch_size, 200), 1)
     FOR UPDATE OF oc SKIP LOCKED
  LOOP
    BEGIN
      v_context := COALESCE(v_row.context, '{}'::jsonb);
      v_org := v_row.organization_id;

      IF v_org IS NULL THEN
        v_org_text := NULLIF(btrim(v_context->>'organization_id'), '');
        IF v_org_text IS NOT NULL AND v_org_text ~* v_uuid_re THEN
          v_org := v_org_text::uuid;
        END IF;
      END IF;

      IF v_org IS NULL THEN
        v_client_text := NULLIF(btrim(v_context->>'client_id'), '');
        IF v_client_text IS NOT NULL AND v_client_text ~* v_uuid_re THEN
          SELECT c.organization_id
            INTO v_org
            FROM public.clients c
           WHERE c.id = v_client_text::uuid
           LIMIT 1;
        END IF;
      END IF;

      IF v_org IS NULL THEN
        v_sender_text := NULLIF(btrim(v_context->>'sender_id'), '');
        IF v_sender_text IS NOT NULL AND v_sender_text ~* v_uuid_re THEN
          SELECT c.organization_id
            INTO v_org
            FROM public.senders s
            JOIN public.clients c ON c.id = s.client_id
           WHERE s.id = v_sender_text::uuid
           LIMIT 1;
        END IF;
      END IF;

      IF v_org IS NULL AND v_row.shipment_id IS NOT NULL THEN
        SELECT c.organization_id
          INTO v_org
          FROM public.shipments sh
          JOIN public.clients c ON c.id = sh.client_id
         WHERE sh.id = v_row.shipment_id
         LIMIT 1;
      END IF;

      IF v_org IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_context := jsonb_strip_nulls(v_context || jsonb_build_object(
        'organization_id', v_org,
        'call_type', v_row.call_type,
        'target_type', v_row.target_type,
        'target_id', v_row.target_id,
        'shipment_id', v_row.shipment_id
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

      v_min_age_minutes := COALESCE(NULLIF(v_task_args->>'min_age_minutes', '')::INT, v_min_age_minutes_default);
      v_only_exhausted := COALESCE(NULLIF(v_task_args->>'only_exhausted', '')::BOOLEAN, v_only_exhausted_default);
      v_next_action := COALESCE(NULLIF(btrim(v_task_args->>'next_action'), ''), v_next_action_default);

      v_last_attempt := COALESCE(v_row.completed_at, v_row.created_at, v_now);
      v_age_seconds := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - v_last_attempt)))::INT);
      v_age_minutes := GREATEST(0, FLOOR(v_age_seconds / 60.0)::INT);

      IF v_min_age_minutes IS NOT NULL AND v_age_minutes < v_min_age_minutes THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      IF v_only_exhausted IS TRUE
         AND v_row.status <> 'permanently_failed'
         AND COALESCE(v_row.retry_count, 0) < COALESCE(v_row.max_retries, 0) THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_settings_resolution_id := NULL;
      IF v_policy_row.settings_id IS NOT NULL THEN
        v_settings_resolution_id := public.log_settings_resolution(
          p_organization_id := v_org,
          p_category := 'ops_maintenance_policy',
          p_winning_scope_type := v_policy_row.scope_type,
          p_winning_scope_id := v_policy_row.scope_id,
          p_winning_settings_id := v_policy_row.settings_id,
          p_winning_settings_version_id := v_policy_row.settings_version_id,
          p_winning_version := v_policy_row.version,
          p_scope_path := v_policy_row.scope_path,
          p_inputs := jsonb_strip_nulls(jsonb_build_object(
            'task_key', v_task_key,
            'resource_type', 'outbound_call',
            'resource_id', v_row.id,
            'status', v_row.status,
            'retry_count', v_row.retry_count,
            'max_retries', v_row.max_retries
          )),
          p_merge_notes := NULL
        );
      END IF;

      PERFORM public.enqueue_ops_quarantine(
        p_organization_id := v_org,
        p_resource_type := 'outbound_call',
        p_resource_id := v_row.id,
        p_reason := 'retry_exhausted_or_permanent',
        p_next_action := v_next_action,
        p_details := jsonb_strip_nulls(jsonb_build_object(
          'status', v_row.status,
          'retry_count', v_row.retry_count,
          'max_retries', v_row.max_retries,
          'error_message', v_row.error_message,
          'response_status_code', v_row.response_status_code,
          'call_type', v_row.call_type,
          'target_type', v_row.target_type,
          'target_id', v_row.target_id,
          'age_minutes', v_age_minutes,
          'task_key', v_task_key
        )),
        p_settings_resolution_id := v_settings_resolution_id
      );

      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'ops_maintenance',
        p_resource_type := 'outbound_call',
        p_resource_id := v_row.id,
        p_decision_point := COALESCE(v_task_key, 'quarantine_outbound_calls'),
        p_decision_outcome := 'quarantined',
        p_performed_by_system := 'ops_maintenance_worker',
        p_correlation_id := v_row.correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'reason', 'retry_exhausted_or_permanent',
          'status', v_row.status,
          'retry_count', v_row.retry_count,
          'max_retries', v_row.max_retries
        )),
        p_decision_reason := 'Outbound call exhausted or permanently failed.',
        p_settings_resolution_id := v_settings_resolution_id
      );

      v_quarantined := v_quarantined + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      CONTINUE;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'completed',
    'quarantined', v_quarantined,
    'skipped', v_skipped,
    'errors', v_errors
  );
END;
$$;

COMMENT ON FUNCTION public.ops_maintenance_quarantine_outbound_calls(JSONB)
  IS 'Quarantine failed outbound_calls once retries are exhausted or permanently failed.';

-- ---------------------------------------------------------------------------
-- 5) Handler: quarantine label_jobs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ops_maintenance_quarantine_label_jobs(p_task JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_task_key TEXT := NULLIF(btrim(p_task->>'task_key'), '');
  v_args JSONB := COALESCE(p_task->'arguments', '{}'::jsonb);

  v_batch_size INT := COALESCE(NULLIF(v_args->>'batch_size', '')::INT, 200);
  v_statuses TEXT[] := ARRAY['failed'];
  v_min_age_minutes_default INT := COALESCE(NULLIF(v_args->>'min_age_minutes', '')::INT, 5);
  v_only_exhausted_default BOOLEAN := COALESCE(NULLIF(v_args->>'only_exhausted', '')::BOOLEAN, TRUE);
  v_next_action_default TEXT := NULLIF(btrim(v_args->>'next_action'), '');
  v_now TIMESTAMPTZ := now();

  v_quarantined INT := 0;
  v_skipped INT := 0;
  v_errors INT := 0;

  v_row RECORD;
  v_context JSONB;
  v_policy_row RECORD;
  v_task_config JSONB;
  v_task_args JSONB;
  v_min_age_minutes INT;
  v_only_exhausted BOOLEAN;
  v_next_action TEXT;
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
    SELECT lj.id,
           lj.organization_id,
           lj.client_id,
           lj.shipment_id,
           lj.status,
           lj.attempts,
           lj.max_attempts,
           lj.last_attempt_at,
           lj.updated_at,
           lj.created_at,
           lj.error_reason,
           lj.label_type,
           lj.job_purpose
      FROM public.label_jobs lj
     WHERE lj.status = ANY(v_statuses)
       AND NOT EXISTS (
         SELECT 1
           FROM public.ops_quarantine oq
          WHERE oq.resource_type = 'label_job'
            AND oq.resource_id = lj.id
            AND oq.status = 'open'
       )
     ORDER BY COALESCE(lj.last_attempt_at, lj.updated_at, lj.created_at) ASC
     LIMIT GREATEST(COALESCE(v_batch_size, 200), 1)
     FOR UPDATE OF lj SKIP LOCKED
  LOOP
    BEGIN
      IF v_row.organization_id IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_row.organization_id,
        'client_id', v_row.client_id,
        'shipment_id', v_row.shipment_id,
        'label_type', v_row.label_type,
        'job_purpose', v_row.job_purpose
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

      v_min_age_minutes := COALESCE(NULLIF(v_task_args->>'min_age_minutes', '')::INT, v_min_age_minutes_default);
      v_only_exhausted := COALESCE(NULLIF(v_task_args->>'only_exhausted', '')::BOOLEAN, v_only_exhausted_default);
      v_next_action := COALESCE(NULLIF(btrim(v_task_args->>'next_action'), ''), v_next_action_default);

      v_last_attempt := COALESCE(v_row.last_attempt_at, v_row.updated_at, v_row.created_at, v_now);
      v_age_seconds := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - v_last_attempt)))::INT);
      v_age_minutes := GREATEST(0, FLOOR(v_age_seconds / 60.0)::INT);

      IF v_min_age_minutes IS NOT NULL AND v_age_minutes < v_min_age_minutes THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      IF v_only_exhausted IS TRUE
         AND COALESCE(v_row.attempts, 0) < COALESCE(v_row.max_attempts, 0) THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

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
            'resource_type', 'label_job',
            'resource_id', v_row.id,
            'status', v_row.status,
            'attempts', v_row.attempts,
            'max_attempts', v_row.max_attempts
          )),
          p_merge_notes := NULL
        );
      END IF;

      PERFORM public.enqueue_ops_quarantine(
        p_organization_id := v_row.organization_id,
        p_resource_type := 'label_job',
        p_resource_id := v_row.id,
        p_reason := 'retry_exhausted_or_stale',
        p_next_action := v_next_action,
        p_details := jsonb_strip_nulls(jsonb_build_object(
          'status', v_row.status,
          'attempts', v_row.attempts,
          'max_attempts', v_row.max_attempts,
          'error_reason', v_row.error_reason,
          'last_attempt_at', v_last_attempt,
          'age_minutes', v_age_minutes,
          'label_type', v_row.label_type,
          'job_purpose', v_row.job_purpose,
          'task_key', v_task_key
        )),
        p_settings_resolution_id := v_settings_resolution_id
      );

      PERFORM public.log_decision(
        p_organization_id := v_row.organization_id,
        p_decision_category := 'ops_maintenance',
        p_resource_type := 'label_job',
        p_resource_id := v_row.id,
        p_decision_point := COALESCE(v_task_key, 'quarantine_label_jobs'),
        p_decision_outcome := 'quarantined',
        p_performed_by_system := 'ops_maintenance_worker',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'reason', 'retry_exhausted_or_stale',
          'status', v_row.status,
          'attempts', v_row.attempts,
          'max_attempts', v_row.max_attempts
        )),
        p_decision_reason := 'Label job exhausted or stale; quarantined for review.',
        p_settings_resolution_id := v_settings_resolution_id
      );

      v_quarantined := v_quarantined + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      CONTINUE;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'completed',
    'quarantined', v_quarantined,
    'skipped', v_skipped,
    'errors', v_errors
  );
END;
$$;

COMMENT ON FUNCTION public.ops_maintenance_quarantine_label_jobs(JSONB)
  IS 'Quarantine failed label_jobs once retry attempts are exhausted or stale.';

-- ---------------------------------------------------------------------------
-- 6) Handler: quarantine stale workflow runs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ops_maintenance_quarantine_stale_workflow_runs(p_task JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_task_key TEXT := NULLIF(btrim(p_task->>'task_key'), '');
  v_args JSONB := COALESCE(p_task->'arguments', '{}'::jsonb);

  v_batch_size INT := COALESCE(NULLIF(v_args->>'batch_size', '')::INT, 100);
  v_statuses TEXT[] := ARRAY['pending', 'in_progress'];
  v_stale_minutes_default INT := COALESCE(NULLIF(v_args->>'stale_minutes', '')::INT, 60);
  v_mark_failed_default BOOLEAN := COALESCE(NULLIF(v_args->>'mark_failed', '')::BOOLEAN, TRUE);
  v_next_action_default TEXT := NULLIF(btrim(v_args->>'next_action'), '');
  v_now TIMESTAMPTZ := now();

  v_quarantined INT := 0;
  v_marked_failed INT := 0;
  v_skipped INT := 0;
  v_errors INT := 0;

  v_row RECORD;
  v_context JSONB;
  v_policy_row RECORD;
  v_task_config JSONB;
  v_task_args JSONB;
  v_stale_minutes INT;
  v_mark_failed BOOLEAN;
  v_next_action TEXT;
  v_last_activity TIMESTAMPTZ;
  v_age_seconds INT;
  v_age_minutes INT;
  v_settings_resolution_id UUID;

  v_org UUID;
  v_org_text TEXT;
  v_client_text TEXT;
  v_sender_text TEXT;
  v_shipment_text TEXT;
  v_uuid_re TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF jsonb_typeof(v_args->'statuses') = 'array' THEN
    SELECT array_agg(value)
      INTO v_statuses
      FROM jsonb_array_elements_text(v_args->'statuses') a(value);
  END IF;
  IF v_statuses IS NULL OR array_length(v_statuses, 1) IS NULL THEN
    v_statuses := ARRAY['pending', 'in_progress'];
  END IF;

  FOR v_row IN
    SELECT wr.id,
           wr.workflow_template_id,
           wr.workflow_status,
           wr.retry_count,
           wr.max_retries,
           wr.failure_reason,
           wr.last_error,
           wr.context,
           wr.created_at,
           wr.started_at,
           wr.updated_at,
           wr.completed_at,
           wr.triggered_by_request_id
      FROM public.workflow_runs wr
     WHERE wr.workflow_status = ANY(v_statuses)
       AND NOT EXISTS (
         SELECT 1
           FROM public.ops_quarantine oq
          WHERE oq.resource_type = 'workflow_run'
            AND oq.resource_id = wr.id
            AND oq.status = 'open'
       )
     ORDER BY COALESCE(wr.updated_at, wr.started_at, wr.created_at) ASC
     LIMIT GREATEST(COALESCE(v_batch_size, 100), 1)
     FOR UPDATE OF wr SKIP LOCKED
  LOOP
    BEGIN
      v_context := COALESCE(v_row.context, '{}'::jsonb);
      v_org := NULL;

      v_org_text := NULLIF(btrim(v_context->>'organization_id'), '');
      IF v_org_text IS NOT NULL AND v_org_text ~* v_uuid_re THEN
        v_org := v_org_text::uuid;
      END IF;

      IF v_org IS NULL THEN
        v_client_text := NULLIF(btrim(v_context->>'client_id'), '');
        IF v_client_text IS NOT NULL AND v_client_text ~* v_uuid_re THEN
          SELECT c.organization_id
            INTO v_org
            FROM public.clients c
           WHERE c.id = v_client_text::uuid
           LIMIT 1;
        END IF;
      END IF;

      IF v_org IS NULL THEN
        v_sender_text := NULLIF(btrim(v_context->>'sender_id'), '');
        IF v_sender_text IS NOT NULL AND v_sender_text ~* v_uuid_re THEN
          SELECT c.organization_id
            INTO v_org
            FROM public.senders s
            JOIN public.clients c ON c.id = s.client_id
           WHERE s.id = v_sender_text::uuid
           LIMIT 1;
        END IF;
      END IF;

      IF v_org IS NULL THEN
        v_shipment_text := NULLIF(btrim(v_context->>'shipment_id'), '');
        IF v_shipment_text IS NOT NULL AND v_shipment_text ~* v_uuid_re THEN
          SELECT c.organization_id
            INTO v_org
            FROM public.shipments sh
            JOIN public.clients c ON c.id = sh.client_id
           WHERE sh.id = v_shipment_text::uuid
           LIMIT 1;
        END IF;
      END IF;

      IF v_org IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_context := jsonb_strip_nulls(v_context || jsonb_build_object('organization_id', v_org));

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

      v_stale_minutes := COALESCE(NULLIF(v_task_args->>'stale_minutes', '')::INT, v_stale_minutes_default);
      v_mark_failed := COALESCE(NULLIF(v_task_args->>'mark_failed', '')::BOOLEAN, v_mark_failed_default);
      v_next_action := COALESCE(NULLIF(btrim(v_task_args->>'next_action'), ''), v_next_action_default);

      v_last_activity := COALESCE(v_row.updated_at, v_row.started_at, v_row.created_at, v_now);
      v_age_seconds := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - v_last_activity)))::INT);
      v_age_minutes := GREATEST(0, FLOOR(v_age_seconds / 60.0)::INT);

      IF v_stale_minutes IS NOT NULL AND v_age_minutes < v_stale_minutes THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_settings_resolution_id := NULL;
      IF v_policy_row.settings_id IS NOT NULL THEN
        v_settings_resolution_id := public.log_settings_resolution(
          p_organization_id := v_org,
          p_category := 'ops_maintenance_policy',
          p_winning_scope_type := v_policy_row.scope_type,
          p_winning_scope_id := v_policy_row.scope_id,
          p_winning_settings_id := v_policy_row.settings_id,
          p_winning_settings_version_id := v_policy_row.settings_version_id,
          p_winning_version := v_policy_row.version,
          p_scope_path := v_policy_row.scope_path,
          p_inputs := jsonb_strip_nulls(jsonb_build_object(
            'task_key', v_task_key,
            'resource_type', 'workflow_run',
            'resource_id', v_row.id,
            'status', v_row.workflow_status,
            'age_minutes', v_age_minutes
          )),
          p_merge_notes := NULL
        );
      END IF;

      IF v_mark_failed IS TRUE AND v_row.workflow_status <> 'failed' THEN
        UPDATE public.workflow_runs
           SET workflow_status = 'failed',
               failure_reason = COALESCE(v_row.failure_reason, 'stale_timeout'),
               updated_at = now(),
               completed_at = COALESCE(v_row.completed_at, now())
         WHERE id = v_row.id;

        v_marked_failed := v_marked_failed + 1;
      END IF;

      PERFORM public.enqueue_ops_quarantine(
        p_organization_id := v_org,
        p_resource_type := 'workflow_run',
        p_resource_id := v_row.id,
        p_reason := 'stale_workflow_run',
        p_next_action := v_next_action,
        p_details := jsonb_strip_nulls(jsonb_build_object(
          'status', v_row.workflow_status,
          'age_minutes', v_age_minutes,
          'stale_minutes', v_stale_minutes,
          'mark_failed', v_mark_failed,
          'workflow_template_id', v_row.workflow_template_id,
          'task_key', v_task_key
        )),
        p_settings_resolution_id := v_settings_resolution_id
      );

      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'ops_maintenance',
        p_resource_type := 'workflow_run',
        p_resource_id := v_row.id,
        p_decision_point := COALESCE(v_task_key, 'quarantine_stale_workflow_runs'),
        p_decision_outcome := 'quarantined',
        p_performed_by_system := 'ops_maintenance_worker',
        p_correlation_id := v_row.triggered_by_request_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'reason', 'stale_workflow_run',
          'status', v_row.workflow_status,
          'age_minutes', v_age_minutes,
          'stale_minutes', v_stale_minutes,
          'mark_failed', v_mark_failed
        )),
        p_decision_reason := 'Workflow run stale beyond configured threshold.',
        p_settings_resolution_id := v_settings_resolution_id
      );

      v_quarantined := v_quarantined + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      CONTINUE;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'completed',
    'quarantined', v_quarantined,
    'marked_failed', v_marked_failed,
    'skipped', v_skipped,
    'errors', v_errors
  );
END;
$$;

COMMENT ON FUNCTION public.ops_maintenance_quarantine_stale_workflow_runs(JSONB)
  IS 'Quarantine workflow runs that are stale beyond a configured threshold (optionally mark failed).';

-- ---------------------------------------------------------------------------
-- 7) Worker: run_ops_maintenance_worker
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.run_ops_maintenance_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_tasks_executed INT := 0;
  v_error_occurred BOOLEAN := FALSE;

  v_policy JSONB;
  v_enabled BOOLEAN := FALSE;
  v_tasks JSONB;
  v_task JSONB;

  v_handler_key TEXT;
  v_handler RECORD;
  v_result JSONB;
  v_results JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('ops_maintenance_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('ops_maintenance_worker');

  v_policy := public.resolve_settings('ops_maintenance_policy', 'global', NULL);
  v_enabled := FALSE;
  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, FALSE);
  EXCEPTION WHEN OTHERS THEN
    v_enabled := FALSE;
  END;

  IF NOT v_enabled THEN
    PERFORM public.complete_request_context(v_context, FALSE, 0);
    PERFORM public.update_cron_config('ops_maintenance_worker');
    RETURN json_build_object('status', 'disabled');
  END IF;

  v_tasks := CASE
    WHEN jsonb_typeof(v_policy->'tasks') = 'array' THEN v_policy->'tasks'
    ELSE '[]'::jsonb
  END;

  FOR v_task IN
    SELECT value FROM jsonb_array_elements(v_tasks)
  LOOP
    BEGIN
      IF COALESCE(NULLIF(v_task->>'enabled', '')::BOOLEAN, TRUE) IS NOT TRUE THEN
        CONTINUE;
      END IF;

      v_handler_key := NULLIF(btrim(v_task->>'handler_key'), '');
      IF v_handler_key IS NULL THEN
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'status', 'skipped',
          'reason', 'missing_handler_key'
        ));
        CONTINUE;
      END IF;

      SELECT handler_key, handler_schema, handler_name, handler_signature, handler_version
        INTO v_handler
        FROM public.operation_handlers
       WHERE handler_key = v_handler_key
         AND is_active = TRUE;

      IF NOT FOUND THEN
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'handler_key', v_handler_key,
          'status', 'skipped',
          'reason', 'handler_not_registered'
        ));
        CONTINUE;
      END IF;

      IF COALESCE(v_handler.handler_signature, '') <> '(jsonb)' THEN
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'handler_key', v_handler_key,
          'status', 'skipped',
          'reason', 'unsupported_handler_signature',
          'signature', v_handler.handler_signature
        ));
        CONTINUE;
      END IF;

      EXECUTE format('SELECT %I.%I($1)', v_handler.handler_schema, v_handler.handler_name)
      INTO v_result
      USING v_task;

      v_tasks_executed := v_tasks_executed + 1;
      v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'handler_key', v_handler_key,
        'handler_version', v_handler.handler_version,
        'result', v_result
      )));
    EXCEPTION WHEN OTHERS THEN
      v_error_occurred := TRUE;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'handler_key', COALESCE(v_handler_key, '<unknown>'),
        'status', 'error',
        'error', SQLERRM
      ));
      CONTINUE;
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error_occurred, v_tasks_executed);
  PERFORM public.update_cron_config('ops_maintenance_worker');

  RETURN json_build_object(
    'status', 'completed',
    'tasks_executed', v_tasks_executed,
    'error_occurred', v_error_occurred,
    'results', v_results
  );
EXCEPTION WHEN OTHERS THEN
  v_error_occurred := TRUE;
  PERFORM public.complete_request_context(v_context, TRUE, v_tasks_executed);
  PERFORM public.update_cron_config('ops_maintenance_worker');
  RETURN json_build_object('status', 'failed', 'error', SQLERRM);
END;
$$;

ALTER FUNCTION public.run_ops_maintenance_worker()
  SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 8) Register handlers in operation_handlers (safe dynamic dispatch)
-- ---------------------------------------------------------------------------

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  created_by,
  notes,
  doc_url
)
VALUES
  (
    'ops_maintenance_retry_webhook_inbox',
    'public',
    'ops_maintenance_retry_webhook_inbox',
    '(jsonb)',
    'v1',
    TRUE,
    NULL,
    'Requeue failed webhook_inbox rows with policy-driven backoff; quarantine exhausted/stale records.',
    'docs/ops/runbooks/ops_maintenance_worker.md'
  ),
  (
    'ops_maintenance_retry_domain_events',
    'public',
    'ops_maintenance_retry_domain_events',
    '(jsonb)',
    'v1',
    TRUE,
    NULL,
    'Requeue failed domain_events rows with policy-driven backoff; quarantine exhausted/stale records.',
    'docs/ops/runbooks/ops_maintenance_worker.md'
  ),
  (
    'ops_maintenance_quarantine_outbound_calls',
    'public',
    'ops_maintenance_quarantine_outbound_calls',
    '(jsonb)',
    'v1',
    TRUE,
    NULL,
    'Quarantine outbound_calls that are permanently failed or retry-exhausted.',
    'docs/ops/runbooks/ops_maintenance_worker.md'
  ),
  (
    'ops_maintenance_quarantine_label_jobs',
    'public',
    'ops_maintenance_quarantine_label_jobs',
    '(jsonb)',
    'v1',
    TRUE,
    NULL,
    'Quarantine label_jobs that are retry-exhausted or stale.',
    'docs/ops/runbooks/ops_maintenance_worker.md'
  ),
  (
    'ops_maintenance_quarantine_stale_workflow_runs',
    'public',
    'ops_maintenance_quarantine_stale_workflow_runs',
    '(jsonb)',
    'v1',
    TRUE,
    NULL,
    'Quarantine workflow_runs that are stale beyond the configured threshold.',
    'docs/ops/runbooks/ops_maintenance_worker.md'
  )
ON CONFLICT (handler_key) DO UPDATE
SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 9) Schema registry entry for ops_maintenance_policy
-- ---------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'ops_maintenance_policy',
  1,
  '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":true,"properties":{"enabled":{"type":"boolean"},"tasks":{"type":"array","items":{"type":"object","additionalProperties":true}}}}'::jsonb,
  'Ops maintenance policy (retry + quarantine tasks).',
  jsonb_build_array(
    jsonb_build_object(
      'enabled', true,
      'tasks', jsonb_build_array(
        jsonb_build_object(
          'task_key', 'retry_webhook_inbox',
          'enabled', true,
          'handler_key', 'ops_maintenance_retry_webhook_inbox',
          'arguments', jsonb_build_object('batch_size', 100)
        )
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

-- ---------------------------------------------------------------------------
-- 10) Seed default global policy (do not override if already configured)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_version_id UUID;
  v_existing_value JSONB;
  v_value JSONB := jsonb_build_object(
    'enabled', TRUE,
    'tasks', jsonb_build_array(
      jsonb_build_object(
        'task_key', 'retry_webhook_inbox',
        'enabled', TRUE,
        'handler_key', 'ops_maintenance_retry_webhook_inbox',
        'arguments', jsonb_build_object(
          'batch_size', 100,
          'statuses', jsonb_build_array('failed'),
          'max_retries', 3,
          'backoff_seconds', jsonb_build_array(60, 300, 900),
          'quarantine_after_minutes', 1440,
          'next_action', 'investigate'
        )
      ),
      jsonb_build_object(
        'task_key', 'retry_domain_events',
        'enabled', TRUE,
        'handler_key', 'ops_maintenance_retry_domain_events',
        'arguments', jsonb_build_object(
          'batch_size', 100,
          'statuses', jsonb_build_array('failed'),
          'max_retries', 3,
          'backoff_seconds', jsonb_build_array(60, 300, 900),
          'quarantine_after_minutes', 1440,
          'next_action', 'investigate'
        )
      ),
      jsonb_build_object(
        'task_key', 'quarantine_outbound_calls',
        'enabled', TRUE,
        'handler_key', 'ops_maintenance_quarantine_outbound_calls',
        'arguments', jsonb_build_object(
          'batch_size', 200,
          'statuses', jsonb_build_array('permanently_failed'),
          'min_age_minutes', 5,
          'only_exhausted', TRUE,
          'next_action', 'investigate'
        )
      ),
      jsonb_build_object(
        'task_key', 'quarantine_label_jobs',
        'enabled', TRUE,
        'handler_key', 'ops_maintenance_quarantine_label_jobs',
        'arguments', jsonb_build_object(
          'batch_size', 200,
          'statuses', jsonb_build_array('failed'),
          'min_age_minutes', 5,
          'only_exhausted', TRUE,
          'next_action', 'rerender_or_manual'
        )
      ),
      jsonb_build_object(
        'task_key', 'quarantine_stale_workflow_runs',
        'enabled', TRUE,
        'handler_key', 'ops_maintenance_quarantine_stale_workflow_runs',
        'arguments', jsonb_build_object(
          'batch_size', 100,
          'statuses', jsonb_build_array('pending', 'in_progress'),
          'stale_minutes', 60,
          'mark_failed', TRUE,
          'next_action', 'review_workflow'
        )
      )
    )
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ops_maintenance_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ) THEN
    RETURN;
  END IF;

  SELECT sv.id
    INTO v_version_id
    FROM public.settings_versions sv
   WHERE sv.category = 'ops_maintenance_policy'
     AND sv.scope_type = 'global'
     AND sv.scope_hash = v_scope_hash
     AND sv.effective_until IS NULL
   ORDER BY sv.approved_at DESC NULLS LAST, sv.created_at DESC
   LIMIT 1;

  IF v_version_id IS NULL THEN
    v_version_id := gen_random_uuid();
    INSERT INTO public.settings_versions (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    )
    VALUES (
      v_version_id,
      'ops_maintenance_policy',
      'global',
      NULL,
      v_scope_hash,
      1,
      v_value,
      1,
      'Seed ops_maintenance_policy defaults',
      now(),
      now()
    );
  ELSE
    SELECT sv.value
      INTO v_existing_value
      FROM public.settings_versions sv
     WHERE sv.id = v_version_id
       AND sv.scope_hash = v_scope_hash
     LIMIT 1;
  END IF;

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'ops_maintenance_policy',
    'global',
    NULL,
    v_scope_hash,
    v_version_id,
    COALESCE(v_existing_value, v_value),
    now()
  )
  ON CONFLICT (category, scope_type, scope_hash)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END $$;

-- ---------------------------------------------------------------------------
-- 11) Worker registry + cron_config baseline + pg_cron schedule
-- ---------------------------------------------------------------------------

INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'ops_maintenance_worker',
  'maintenance',
  'Universal ops maintenance worker: retries + quarantine for failed/stale jobs (policy-driven).',
  '*/5 * * * *',
  jsonb_build_object('policy_category', 'ops_maintenance_policy'),
  TRUE
)
ON CONFLICT (worker_name) DO UPDATE
SET
  worker_type = EXCLUDED.worker_type,
  description = EXCLUDED.description,
  schedule = EXCLUDED.schedule,
  config = EXCLUDED.config,
  is_active = TRUE,
  updated_at = now();

INSERT INTO public.cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
  'ops_maintenance_worker',
  300,
  100,
  TRUE,
  'Ops maintenance (settings: ops_maintenance_policy). Retries failed jobs and quarantines exhausted/stale items.'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = TRUE,
  notes = EXCLUDED.notes;

DO $$
DECLARE
  v_schedule TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ops_maintenance_tick') THEN
    PERFORM cron.unschedule('ops_maintenance_tick');
  END IF;

  SELECT schedule
    INTO v_schedule
    FROM public.worker_registry
   WHERE worker_name = 'ops_maintenance_worker'
   LIMIT 1;

  v_schedule := COALESCE(NULLIF(btrim(v_schedule), ''), '*/5 * * * *');

  PERFORM cron.schedule(
    'ops_maintenance_tick',
    v_schedule,
    'SELECT public.run_ops_maintenance_worker();'
  );
END $$;

COMMIT;
