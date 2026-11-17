-- Plan: PLAN-202512-unified-jobs-maintenance / Step: S04
-- Migration: Outbound worker retry unification (policy-driven)
-- Purpose:
--   - Make outbound_worker claim retry-scheduled jobs (status=failed) and edge-queued jobs (status=pending_edge).
--   - Centralize retry/backoff into a reusable helper (mark_outbound_call_failure_v2) with executor attribution.
--   - Ensure failed/exception outcomes schedule retries via outbound_retry_policy (no lost/stale jobs).
-- Date: 2025-12-26

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) Claiming: include pending_edge + retry-scheduled failures
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_pending_jobs(
    p_batch_size INT
)
RETURNS TABLE (
    job_id UUID,
    call_type TEXT,
    target_type TEXT,
    target_id UUID,
    method TEXT,
    url TEXT,
    headers JSONB,
    body JSONB,
    priority INT,
    retry_count INT,
    max_retries INT,
    correlation_id UUID,
    shipment_id UUID,
    context JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    UPDATE public.outbound_calls AS oc
    SET lease_expires_at = now() + interval '30 seconds'
    WHERE oc.id IN (
        SELECT oc2.id
        FROM public.outbound_calls oc2
        WHERE oc2.status IN ('pending', 'pending_edge', 'failed')
          AND oc2.scheduled_at <= now()
          AND (oc2.lease_expires_at IS NULL OR oc2.lease_expires_at < now())
          AND (oc2.status <> 'failed' OR oc2.retry_count < oc2.max_retries)
        ORDER BY oc2.priority DESC, oc2.scheduled_at
        LIMIT GREATEST(COALESCE(p_batch_size, 10), 1)
        FOR UPDATE SKIP LOCKED
    )
    RETURNING oc.id, oc.call_type, oc.target_type, oc.target_id, oc.method, oc.url, oc.headers, oc.body,
              oc.priority, oc.retry_count, oc.max_retries, oc.correlation_id, oc.shipment_id, oc.context;
END;
$$;

COMMENT ON FUNCTION public.claim_pending_jobs(INT)
  IS 'Claim due outbound_calls jobs (status=pending|pending_edge|failed, scheduled_at<=now) by acquiring a short lease.';

-- -----------------------------------------------------------------------------
-- 2) Failure marking: policy-driven retries with executor attribution (v2)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_outbound_call_failure_v2(
    p_job_id UUID,
    p_status_code INT,
    p_headers JSONB,
    p_body JSONB,
    p_error TEXT,
    p_performed_by_system TEXT,
    p_correlation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_org UUID;
    v_next_retry_count INT;
    v_new_status TEXT;
    v_headers_norm JSONB := public.normalize_headers(COALESCE(p_headers, '{}'::jsonb));

    v_provider_id UUID := NULL;
    v_attempt_number INT := NULL;

    -- Retry policy resolution + provenance
    v_policy_row RECORD;
    v_policy JSONB := '{}'::jsonb;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_settings_version_id UUID;
    v_policy_version INT;
    v_scope_path JSONB := '[]'::jsonb;
    v_settings_resolution_id UUID;

    -- Policy fields
    v_retryable_codes JSONB := NULL;
    v_retryable_ranges JSONB := NULL;
    v_permanent_ranges JSONB := NULL;
    v_retry_after_header TEXT;
    v_respect_retry_after BOOLEAN := NULL;
    v_backoff JSONB := NULL;
    v_max_delay_seconds INT := NULL;

    -- Computed decision
    v_is_permanent BOOLEAN := FALSE;
    v_is_retryable BOOLEAN := FALSE;
    v_should_retry BOOLEAN := FALSE;
    v_backoff_seconds INT := 0;
    v_retry_after_seconds INT := NULL;
    v_delay_seconds INT := 0;
    v_retry_reason TEXT := NULL;

    v_executor TEXT := NULLIF(btrim(COALESCE(p_performed_by_system, '')), '');
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    IF v_executor IS NULL THEN
        v_executor := 'unknown_executor';
    END IF;

    SELECT *
      INTO v_job
      FROM public.outbound_calls
     WHERE id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Outbound call % not found', p_job_id;
    END IF;

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    IF v_job.target_type = 'provider' THEN
      v_provider_id := v_job.target_id;
    END IF;

    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row_from_context(
        'outbound_retry_policy',
        jsonb_strip_nulls(COALESCE(v_job.context, '{}'::jsonb) || jsonb_build_object('organization_id', v_org))
      )
      LIMIT 1;

    IF NOT FOUND OR v_policy_row.value IS NULL THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing';
    END IF;

    v_policy := v_policy_row.value;
    v_policy_scope_type := v_policy_row.scope_type;
    v_policy_scope_id := v_policy_row.scope_id;
    v_policy_settings_id := v_policy_row.settings_id;
    v_policy_settings_version_id := v_policy_row.settings_version_id;
    v_policy_version := v_policy_row.version;
    v_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb);

    -- Apply call_type override if present (deep merge).
    IF v_policy ? 'call_type_overrides' AND jsonb_typeof(v_policy->'call_type_overrides') = 'object' THEN
      v_policy := public.jsonb_deep_merge(
        v_policy,
        COALESCE(v_policy->'call_type_overrides'->v_job.call_type, '{}'::jsonb)
      );
    END IF;

    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org,
      p_category := 'outbound_retry_policy',
      p_winning_scope_type := v_policy_scope_type,
      p_winning_scope_id := v_policy_scope_id,
      p_winning_settings_id := v_policy_settings_id,
      p_winning_settings_version_id := v_policy_settings_version_id,
      p_winning_version := v_policy_version,
      p_scope_path := v_scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'job_id', p_job_id,
        'call_type', v_job.call_type,
        'target_type', v_job.target_type,
        'target_id', v_job.target_id,
        'status_code', p_status_code,
        'executor', v_executor
      )),
      p_merge_notes := NULL
    );

    v_retryable_codes := v_policy#>'{http,retryable_status_codes}';
    v_retryable_ranges := v_policy#>'{http,retryable_status_ranges}';
    v_permanent_ranges := v_policy#>'{http,permanent_status_ranges}';
    v_retry_after_header := lower(NULLIF(v_policy#>>'{http,retry_after_header}', ''));
    v_respect_retry_after := NULLIF(v_policy->>'respect_retry_after', '')::BOOLEAN;
    v_backoff := v_policy->'backoff_seconds';
    v_max_delay_seconds := NULLIF(v_policy->>'max_retry_delay_seconds', '')::INT;

    IF v_retry_after_header IS NULL THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_retry_after_header';
    END IF;
    IF v_retryable_codes IS NULL OR jsonb_typeof(v_retryable_codes) <> 'array' THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_retryable_status_codes';
    END IF;
    IF v_retryable_ranges IS NULL OR jsonb_typeof(v_retryable_ranges) <> 'array' THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_retryable_status_ranges';
    END IF;
    IF v_permanent_ranges IS NULL OR jsonb_typeof(v_permanent_ranges) <> 'array' THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_permanent_status_ranges';
    END IF;
    IF v_respect_retry_after IS NULL THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_respect_retry_after';
    END IF;
    IF jsonb_typeof(v_backoff) <> 'array' OR jsonb_array_length(v_backoff) = 0 THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_backoff_seconds';
    END IF;
    IF v_max_delay_seconds IS NULL OR v_max_delay_seconds < 0 THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_max_retry_delay_seconds';
    END IF;

    v_next_retry_count := v_job.retry_count + 1;
    v_attempt_number := v_next_retry_count;

    -- Retryable classification (explicit codes/ranges override permanent ranges).
    v_is_retryable := EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_retryable_codes) AS c(val)
      WHERE (c.val)::INT = p_status_code
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_retryable_ranges) AS r(elem)
      WHERE jsonb_typeof(r.elem) = 'array'
        AND jsonb_array_length(r.elem) = 2
        AND p_status_code BETWEEN (r.elem->>0)::INT AND (r.elem->>1)::INT
    );

    v_is_permanent := (NOT v_is_retryable) AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_permanent_ranges) AS r(elem)
      WHERE jsonb_typeof(r.elem) = 'array'
        AND jsonb_array_length(r.elem) = 2
        AND p_status_code BETWEEN (r.elem->>0)::INT AND (r.elem->>1)::INT
    );

    v_should_retry := v_is_retryable AND (v_next_retry_count < v_job.max_retries);

    -- Backoff delay selection by attempt number (1-based).
    SELECT COALESCE(NULLIF(value, '')::INT, 0)
      INTO v_backoff_seconds
      FROM jsonb_array_elements_text(v_backoff) WITH ORDINALITY AS arr(value, idx)
     WHERE idx = LEAST(jsonb_array_length(v_backoff), GREATEST(1, v_next_retry_count))
     LIMIT 1;

    v_delay_seconds := GREATEST(COALESCE(v_backoff_seconds, 0), 0);

    -- Optional Retry-After header support (numeric seconds only).
    IF v_respect_retry_after THEN
      BEGIN
        v_retry_after_seconds := NULLIF(v_headers_norm->>v_retry_after_header, '')::INT;
      EXCEPTION
        WHEN others THEN
          v_retry_after_seconds := NULL;
      END;
      IF v_retry_after_seconds IS NOT NULL AND v_retry_after_seconds > v_delay_seconds THEN
        v_delay_seconds := v_retry_after_seconds;
      END IF;
    END IF;

    IF v_max_delay_seconds IS NOT NULL AND v_max_delay_seconds > 0 THEN
      v_delay_seconds := LEAST(v_delay_seconds, v_max_delay_seconds);
    END IF;

    IF v_should_retry THEN
      v_new_status := 'failed';
      v_retry_reason := 'retry_scheduled';
    ELSE
      v_new_status := 'permanently_failed';
      v_retry_reason := CASE
        WHEN v_is_permanent THEN 'permanent_status_code'
        WHEN NOT v_is_retryable THEN 'not_retryable_by_policy'
        WHEN v_next_retry_count >= v_job.max_retries THEN 'max_retries_exhausted'
        ELSE 'retry_disallowed'
      END;
    END IF;

    UPDATE public.outbound_calls
       SET status = v_new_status,
           retry_count = v_next_retry_count,
           response_status_code = p_status_code,
           response_headers = COALESCE(p_headers, '{}'::jsonb),
           response_body = COALESCE(p_body, '{}'::jsonb),
           error_message = p_error,
           scheduled_at = CASE
             WHEN v_new_status = 'failed' THEN now() + make_interval(secs => v_delay_seconds)
             ELSE public.outbound_calls.scheduled_at
           END,
           completed_at = CASE WHEN v_new_status = 'permanently_failed' THEN now() ELSE NULL END,
           lease_expires_at = NULL,
           context = CASE
               WHEN context IS NULL THEN NULL
               ELSE (context - 'edge_dispatch' - 'async_request_id')
           END
      WHERE id = p_job_id;

    -- Comms attempt logging (failure): keep SSOT visibility even when no provider_message_id exists.
    IF v_job.call_type IN ('comms_whatsapp', 'comms_sms', 'comms_email', 'comms_voice')
       AND v_provider_id IS NOT NULL
       AND v_attempt_number IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.comms_attempts ca
        WHERE ca.outbound_call_id = p_job_id
          AND ca.attempt_number = v_attempt_number
      ) THEN
        INSERT INTO public.comms_attempts (
          outbound_call_id,
          provider_id,
          attempt_number,
          status,
          provider_message_id,
          error_code,
          error_message,
          cost,
          timestamp
        )
        VALUES (
          p_job_id,
          v_provider_id,
          v_attempt_number,
          'failed',
          NULL,
          v_retry_reason,
          p_error,
          v_job.cost,
          now()
        );
      END IF;
    END IF;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := v_new_status,
        p_performed_by_system := v_executor,
        p_correlation_id := p_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'status', p_status_code,
          'error', p_error,
          'next_retry_count', v_next_retry_count,
          'max_retries', v_job.max_retries,
          'retryable', v_is_retryable,
          'permanent', v_is_permanent,
          'retry_after_seconds', v_retry_after_seconds,
          'delay_seconds', v_delay_seconds,
          'retry_reason', v_retry_reason
        )),
        p_decision_reason := format('Outbound HTTP request failed (executor=%s).', v_executor),
        p_settings_resolution_id := v_settings_resolution_id
    );
END;
$$;

COMMENT ON FUNCTION public.mark_outbound_call_failure_v2(UUID, INT, JSONB, JSONB, TEXT, TEXT, UUID)
  IS 'Policy-driven outbound_call failure handler with scheduled retry/backoff (outbound_retry_policy) and executor attribution.';

-- Preserve the canonical RPC signature used by edge api-caller (delegates to v2).
CREATE OR REPLACE FUNCTION public.mark_outbound_call_failure(
    p_job_id UUID,
    p_status_code INT,
    p_headers JSONB,
    p_body JSONB,
    p_error TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
    PERFORM public.mark_outbound_call_failure_v2(
      p_job_id := p_job_id,
      p_status_code := p_status_code,
      p_headers := p_headers,
      p_body := p_body,
      p_error := p_error,
      p_performed_by_system := 'api_caller_edge',
      p_correlation_id := NULL
    );
END;
$$;

COMMENT ON FUNCTION public.mark_outbound_call_failure(UUID, INT, JSONB, JSONB, TEXT)
  IS 'Mark outbound_call failure and, when policy permits, schedule a retry using scheduled_at backoff (row-driven via outbound_retry_policy).';

-- -----------------------------------------------------------------------------
-- 3) Outbound worker: use v2 retry scheduling for failures/exceptions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.run_outbound_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_job RECORD;
    v_org UUID;
    v_spec JSONB;
    v_result JSONB;
    v_status INT;
    v_completed BOOLEAN;
    v_optout JSONB;
    v_async_request_id BIGINT := NULL;
    v_poll JSONB := NULL;
BEGIN
    SELECT * INTO v_throttle FROM public.check_throttle('outbound_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := public.create_request_context('outbound_worker');

    FOR v_job IN SELECT * FROM public.claim_pending_jobs(v_throttle.batch_size)
    LOOP
        BEGIN
            IF v_job.target_type = 'provider' THEN
                v_org := public.resolve_organization_id_strict('provider', v_job.target_id);
            ELSIF v_job.target_type = 'client' THEN
                v_org := public.resolve_organization_id_strict('client', v_job.target_id);
            ELSIF v_job.shipment_id IS NOT NULL THEN
                v_org := public.resolve_organization_id_strict('shipment', v_job.shipment_id);
            ELSE
                v_org := public.resolve_organization_id_strict('outbound_call', v_job.job_id);
            END IF;

            v_optout := public.should_skip_outbound_call_for_opt_out(
              v_job.call_type,
              v_job.shipment_id,
              COALESCE(v_job.context, '{}'::jsonb)
            );
            IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
                UPDATE public.outbound_calls
                   SET status = 'skipped',
                       error_message = COALESCE(v_optout->>'reason', 'skipped'),
                       completed_at = now(),
                       lease_expires_at = NULL
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'opt_out',
                    p_decision_outcome := 'skipped',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := v_optout,
                    p_decision_reason := v_optout->>'reason'
                );

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

            -- If this job already has an async pg_net request_id, poll for completion instead of re-sending.
            v_async_request_id := NULL;
            BEGIN
              v_async_request_id := NULLIF(v_job.context->>'async_request_id', '')::BIGINT;
            EXCEPTION
              WHEN others THEN
                v_async_request_id := NULL;
            END;

            IF v_async_request_id IS NOT NULL THEN
                v_poll := public.check_async_response(v_async_request_id);
                v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
                v_status := COALESCE((v_poll->>'status')::INT, 0);

                IF NOT v_completed THEN
                    UPDATE public.outbound_calls
                       SET status = 'pending',
                           scheduled_at = now() + interval '30 seconds',
                           lease_expires_at = NULL
                     WHERE id = v_job.job_id;

                    PERFORM public.log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'async_pending',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_inputs := jsonb_build_object(
                          'async_request_id', v_async_request_id,
                          'poll', v_poll
                        ),
                        p_decision_reason := 'Awaiting async HTTP response (polling pg_net).'
                    );

                    v_items_processed := v_items_processed + 1;
                    CONTINUE;
                END IF;

                IF v_completed AND v_status BETWEEN 200 AND 299 THEN
                    UPDATE public.outbound_calls
                       SET status = 'completed',
                           response_status_code = v_status,
                           response_body = v_poll->'body',
                           response_headers = v_poll->'headers',
                           completed_at = now(),
                           error_message = NULL,
                           lease_expires_at = NULL,
                           context = (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id' - 'edge_dispatch')
                     WHERE id = v_job.job_id;

                    -- Response processing failures should not flip delivery state or trigger resends.
                    BEGIN
                      PERFORM public.orchestrate_api_response_processing(v_job.job_id);
                    EXCEPTION
                      WHEN OTHERS THEN
                        v_error := TRUE;
                        UPDATE public.outbound_calls
                           SET requires_investigation = TRUE,
                               root_cause = 'response_processing_exception',
                               resolution_notes = SQLERRM
                         WHERE id = v_job.job_id;

                        PERFORM public.log_decision(
                          p_organization_id := v_org,
                          p_decision_category := 'outbound_call',
                          p_resource_type := 'outbound_call',
                          p_resource_id := v_job.job_id,
                          p_decision_point := 'response_processing',
                          p_decision_outcome := 'exception',
                          p_performed_by_system := 'outbound_worker',
                          p_correlation_id := v_job.correlation_id,
                          p_decision_reason := SQLERRM
                        );
                    END;

                    PERFORM public.log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'success',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_inputs := jsonb_build_object(
                          'status', v_status,
                          'async_request_id', v_async_request_id
                        ),
                        p_decision_reason := 'Outbound HTTP request completed successfully.'
                    );
                ELSE
                    PERFORM public.mark_outbound_call_failure_v2(
                      p_job_id := v_job.job_id,
                      p_status_code := v_status,
                      p_headers := COALESCE(v_poll->'headers', '{}'::jsonb),
                      p_body := COALESCE(v_poll->'body', '{}'::jsonb),
                      p_error := COALESCE(v_poll->'body'->>'error', format('HTTP %s failure', v_status)),
                      p_performed_by_system := 'outbound_worker',
                      p_correlation_id := v_job.correlation_id
                    );
                END IF;

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

            -- First attempt: build call spec and dispatch via call_api (pg_net).
            v_spec := public.get_job_call_spec(v_job.job_id);
            v_result := public.call_api(
                v_spec->>'url',
                COALESCE(v_spec->>'method', 'POST'),
                COALESCE(v_spec->'headers', '{}'::jsonb),
                COALESCE(v_spec->'body', '{}'::jsonb),
                NULL
            );

            v_status := COALESCE((v_result->>'status')::INT, 0);
            v_completed := COALESCE((v_result->>'completed')::BOOLEAN, FALSE);

            IF v_completed AND v_status BETWEEN 200 AND 299 THEN
                UPDATE public.outbound_calls
                   SET status = 'completed',
                       response_status_code = v_status,
                       response_body = v_result->'body',
                       response_headers = v_result->'headers',
                       latency_ms = NULLIF(v_result->>'latency_ms', '')::INT,
                       completed_at = now(),
                       error_message = NULL,
                       lease_expires_at = NULL,
                       context = (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id' - 'edge_dispatch')
                 WHERE id = v_job.job_id;

                -- Response processing failures should not flip delivery state or trigger resends.
                BEGIN
                  PERFORM public.orchestrate_api_response_processing(v_job.job_id);
                EXCEPTION
                  WHEN OTHERS THEN
                    v_error := TRUE;
                    UPDATE public.outbound_calls
                       SET requires_investigation = TRUE,
                           root_cause = 'response_processing_exception',
                           resolution_notes = SQLERRM
                     WHERE id = v_job.job_id;

                    PERFORM public.log_decision(
                      p_organization_id := v_org,
                      p_decision_category := 'outbound_call',
                      p_resource_type := 'outbound_call',
                      p_resource_id := v_job.job_id,
                      p_decision_point := 'response_processing',
                      p_decision_outcome := 'exception',
                      p_performed_by_system := 'outbound_worker',
                      p_correlation_id := v_job.correlation_id,
                      p_decision_reason := SQLERRM
                    );
                END;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'success',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := jsonb_build_object('status', v_status),
                    p_decision_reason := 'Outbound HTTP request completed successfully.'
                );
            ELSIF v_completed THEN
                PERFORM public.mark_outbound_call_failure_v2(
                  p_job_id := v_job.job_id,
                  p_status_code := v_status,
                  p_headers := COALESCE(v_result->'headers', '{}'::jsonb),
                  p_body := COALESCE(v_result->'body', '{}'::jsonb),
                  p_error := COALESCE(v_result->'body'->>'error', format('HTTP %s failure', v_status)),
                  p_performed_by_system := 'outbound_worker',
                  p_correlation_id := v_job.correlation_id
                );
            ELSE
                UPDATE public.outbound_calls
                   SET status = 'pending',
                       scheduled_at = now() + interval '30 seconds',
                       lease_expires_at = NULL,
                       context = CASE
                           WHEN v_result ? 'request_id' THEN
                               jsonb_set(
                                   COALESCE(public.outbound_calls.context, '{}'::jsonb),
                                   '{async_request_id}',
                                   to_jsonb(v_result->>'request_id'),
                                   TRUE
                               )
                           ELSE public.outbound_calls.context
                       END
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'async_pending',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := v_result,
                    p_decision_reason := 'HTTP request accepted asynchronously; awaiting polling.'
                );
            END IF;

            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;

                BEGIN
                  PERFORM public.mark_outbound_call_failure_v2(
                    p_job_id := v_job.job_id,
                    p_status_code := 0,
                    p_headers := '{}'::jsonb,
                    p_body := '{}'::jsonb,
                    p_error := format('exception: %s', SQLERRM),
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id
                  );
                EXCEPTION
                  WHEN OTHERS THEN
                    UPDATE public.outbound_calls
                       SET status = 'permanently_failed',
                           retry_count = v_job.retry_count + 1,
                           error_message = SQLERRM,
                           completed_at = now(),
                           lease_expires_at = NULL
                     WHERE id = v_job.job_id;
                END;
        END;
    END LOOP;

    PERFORM public.complete_request_context(v_context, v_error, v_items_processed);
    PERFORM public.update_cron_config('outbound_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$$;

COMMIT;

