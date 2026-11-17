-- Plan: PLAN-202512-ops-maintenance-universal / Step: S04
BEGIN;

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

COMMIT;
