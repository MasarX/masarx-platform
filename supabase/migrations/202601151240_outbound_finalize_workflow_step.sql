-- Migration: finalize outbound workflow steps on completion
-- Purpose:
--   - Mark outbound workflow steps completed/failed when outbound_calls complete.
--   - Optionally inline-kick the workflow after outbound completion (row-driven).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.finalize_outbound_workflow_step_v1(
  p_job_id UUID,
  p_performed_by_system TEXT DEFAULT 'outbound_worker'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_call public.outbound_calls%ROWTYPE;
  v_step public.workflow_run_steps%ROWTYPE;
  v_run public.workflow_runs%ROWTYPE;
  v_now TIMESTAMPTZ := now();
  v_step_status TEXT;
  v_duration_ms INT;
  v_operation_result JSONB;
  v_decision_id UUID;
  v_policy_ctx JSONB;
  v_policy_row RECORD;
  v_defaults JSONB;
  v_inline_kick BOOLEAN := FALSE;
  v_inline_org UUID;
  v_inline_error TEXT;
  v_decision_payload JSONB;
BEGIN
  IF to_regclass('public.outbound_calls') IS NULL
     OR to_regclass('public.workflow_run_steps') IS NULL THEN
    RETURN;
  END IF;

  SELECT *
    INTO v_call
    FROM public.outbound_calls
   WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_outbound_workflow_step_v1: outbound_call % not found', p_job_id;
  END IF;

  IF v_call.workflow_run_step_id IS NULL THEN
    RETURN;
  END IF;

  SELECT *
    INTO v_step
    FROM public.workflow_run_steps
   WHERE id = v_call.workflow_run_step_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_step.step_status IN ('completed', 'failed', 'skipped')
     AND v_step.operation_completed_at IS NOT NULL THEN
    RETURN;
  END IF;

  IF v_call.status = 'completed' THEN
    v_step_status := 'completed';
  ELSIF v_call.status = 'permanently_failed' THEN
    v_step_status := 'failed';
  ELSIF v_call.status = 'skipped' THEN
    v_step_status := 'skipped';
  ELSE
    RETURN;
  END IF;

  v_duration_ms := GREATEST(
    0,
    (EXTRACT(EPOCH FROM (v_now - COALESCE(v_step.operation_started_at, v_now))) * 1000)::INT
  );

  v_operation_result := jsonb_strip_nulls(jsonb_build_object(
    'outbound_call_id', v_call.id,
    'status', v_call.status,
    'response_status_code', v_call.response_status_code,
    'response_headers', v_call.response_headers,
    'response_body', v_call.response_body,
    'latency_ms', v_call.latency_ms,
    'error_message', v_call.error_message
  ));

  UPDATE public.workflow_run_steps
     SET step_status = v_step_status,
         operation_completed_at = COALESCE(operation_completed_at, v_now),
         duration_ms = COALESCE(duration_ms, v_duration_ms),
         operation_result = COALESCE(v_step.operation_result, '{}'::jsonb) || v_operation_result,
         last_error = CASE
           WHEN v_step_status = 'failed' THEN COALESCE(v_call.error_message, 'outbound_call_failed')
           ELSE NULL
         END,
         updated_at = v_now
   WHERE id = v_step.id;

  IF v_step_status = 'failed' THEN
    UPDATE public.workflow_runs
       SET workflow_status = 'failed',
           failure_reason = COALESCE(v_call.error_message, 'outbound_call_failed'),
           last_error = jsonb_build_object('error', COALESCE(v_call.error_message, 'outbound_call_failed')),
           updated_at = v_now
     WHERE id = v_step.workflow_run_id;
  END IF;

  v_decision_payload := jsonb_strip_nulls(jsonb_build_object(
    'status', v_step_status,
    'decision_point', 'outbound_completion',
    'decision_reason', CASE
      WHEN v_step_status = 'failed' THEN COALESCE(v_call.error_message, 'outbound_call_failed')
      ELSE 'outbound_call_completed'
    END,
    'outbound_call_id', v_call.id,
    'response_status_code', v_call.response_status_code,
    'latency_ms', v_call.latency_ms,
    'performed_by_system', p_performed_by_system
  ));

  BEGIN
    v_decision_id := public.record_workflow_decision(v_step.workflow_run_id, v_step.id, v_decision_payload);
  EXCEPTION
    WHEN OTHERS THEN
      v_decision_id := NULL;
  END;

  IF v_decision_id IS NOT NULL THEN
    UPDATE public.workflow_run_steps
       SET decision_log_id = COALESCE(decision_log_id, v_decision_id),
           updated_at = v_now
     WHERE id = v_step.id;
  END IF;

  SELECT *
    INTO v_run
    FROM public.workflow_runs
   WHERE id = v_step.workflow_run_id;

  v_policy_ctx := COALESCE(v_run.context, '{}'::jsonb);

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
   LIMIT 1;

  v_defaults := v_policy_row.value;
  IF v_defaults IS NULL THEN
    v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
  END IF;

  IF v_defaults IS NOT NULL THEN
    BEGIN
      v_inline_kick := NULLIF(v_defaults->>'inline_kick_on_outbound_complete', '')::BOOLEAN;
    EXCEPTION
      WHEN OTHERS THEN
        v_inline_kick := NULL;
    END;
  END IF;

  IF v_inline_kick IS NULL THEN
    v_inline_kick := FALSE;
  END IF;

  v_inline_org := public.resolve_workflow_context_org_id(v_policy_ctx, v_run.workflow_template_id);

  IF v_inline_kick
     AND v_inline_org IS NOT NULL
     AND COALESCE(NULLIF(current_setting('masarx.workflow_engine', true), ''), '0') <> '1' THEN
    BEGIN
      PERFORM public.progress_workflow_run(v_step.workflow_run_id);
      v_decision_payload := jsonb_build_object(
        'status', 'inline_kick_success',
        'decision_point', 'workflow_inline_kick_outbound',
        'decision_reason', 'Inline kick executed after outbound completion',
        'workflow_run_step_id', v_step.id
      );
      BEGIN
        PERFORM public.record_workflow_decision(v_step.workflow_run_id, v_step.id, v_decision_payload);
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
    EXCEPTION
      WHEN OTHERS THEN
        v_inline_error := SQLERRM;
        v_decision_payload := jsonb_build_object(
          'status', 'inline_kick_failed',
          'decision_point', 'workflow_inline_kick_outbound',
          'decision_reason', v_inline_error,
          'workflow_run_step_id', v_step.id
        );
        BEGIN
          PERFORM public.record_workflow_decision(v_step.workflow_run_id, v_step.id, v_decision_payload);
        EXCEPTION
          WHEN OTHERS THEN
            NULL;
        END;
    END;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_outbound_call_success(
    p_job_id UUID,
    p_status_code INT,
    p_headers JSONB,
    p_body JSONB,
    p_latency_ms INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_org UUID;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    UPDATE public.outbound_calls
    SET status = 'completed',
        response_status_code = p_status_code,
        response_headers = COALESCE(p_headers, '{}'::jsonb),
        response_body = COALESCE(p_body, '{}'::jsonb),
        latency_ms = p_latency_ms,
        completed_at = now(),
        error_message = NULL,
        lease_expires_at = NULL,
        context = CASE
            WHEN context ? 'edge_dispatch' THEN context - 'edge_dispatch'
            ELSE context
        END
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Outbound call % not found', p_job_id;
    END IF;

    PERFORM public.orchestrate_api_response_processing(p_job_id);

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := 'success',
        p_performed_by_system := 'api_caller_edge',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('status', p_status_code),
        p_decision_reason := 'Outbound HTTP request completed via edge function.'
    );

    BEGIN
      PERFORM public.finalize_outbound_workflow_step_v1(p_job_id, 'api_caller_edge');
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
END;
$$;

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
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_new_status TEXT;
    v_org UUID;
    v_next_retry_count INT;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    SELECT *
    INTO v_job
    FROM public.outbound_calls
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Outbound call % not found', p_job_id;
    END IF;

    v_next_retry_count := v_job.retry_count + 1;
    IF v_next_retry_count >= v_job.max_retries THEN
        v_new_status := 'permanently_failed';
    ELSE
        v_new_status := 'failed';
    END IF;

    UPDATE public.outbound_calls
    SET status = v_new_status,
        retry_count = v_next_retry_count,
        response_status_code = p_status_code,
        response_headers = COALESCE(p_headers, '{}'::jsonb),
        response_body = COALESCE(p_body, '{}'::jsonb),
        error_message = p_error,
        completed_at = CASE WHEN v_new_status = 'permanently_failed' THEN now()
          ELSE NULL
        END,
        lease_expires_at = NULL,
        context = CASE
            WHEN context ? 'edge_dispatch' THEN context - 'edge_dispatch'
            ELSE context
        END
    WHERE id = p_job_id;

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := v_new_status,
        p_performed_by_system := 'api_caller_edge',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('status', p_status_code, 'error', p_error),
        p_decision_reason := 'Outbound HTTP request failed via edge function.'
    );

    BEGIN
      PERFORM public.finalize_outbound_workflow_step_v1(p_job_id, 'api_caller_edge');
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
END;
$$;

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
    v_policy_row RECORD;
    v_policy_ctx JSONB;
    v_defaults JSONB;
    v_poll_seconds INT := NULL;
    v_poll_min INT := NULL;
    v_poll_max INT := NULL;
    v_settings_resolution_id UUID := NULL;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_settings_version_id UUID;
    v_policy_version INT;
    v_scope_path JSONB;
BEGIN
    SELECT * INTO v_throttle FROM public.check_throttle('outbound_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := public.create_request_context('outbound_worker');

    FOR v_job IN SELECT oc.workflow_run_step_id, cpj.* FROM public.claim_pending_jobs(v_throttle.batch_size) cpj JOIN public.outbound_calls oc ON oc.id = cpj.job_id
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

            v_policy_ctx := NULL;
            v_policy_row := NULL;
            v_defaults := NULL;
            v_poll_seconds := NULL;
            v_poll_min := NULL;
            v_poll_max := NULL;
            v_settings_resolution_id := NULL;
            v_scope_path := NULL;

            IF v_job.workflow_run_step_id IS NOT NULL THEN
                SELECT r.context
                  INTO v_policy_ctx
                  FROM public.workflow_run_steps s
                  JOIN public.workflow_runs r ON r.id = s.workflow_run_id
                 WHERE s.id = v_job.workflow_run_step_id;
            END IF;

            v_policy_ctx := jsonb_strip_nulls(
              COALESCE(v_policy_ctx, v_job.context, '{}'::jsonb) || jsonb_build_object('organization_id', v_org)
            );

            SELECT *
              INTO v_policy_row
              FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
             LIMIT 1;

            IF NOT FOUND OR v_policy_row.value IS NULL THEN
                SELECT *
                  INTO v_policy_row
                  FROM public.resolve_settings_row('workflow_defaults', 'global', NULL)
                 LIMIT 1;
            END IF;

            v_defaults := v_policy_row.value;
            IF v_defaults IS NULL THEN
                RAISE EXCEPTION 'workflow_defaults_missing';
            END IF;

            v_policy_scope_type := v_policy_row.scope_type;
            v_policy_scope_id := v_policy_row.scope_id;
            v_policy_settings_id := v_policy_row.settings_id;
            v_policy_settings_version_id := v_policy_row.settings_version_id;
            v_policy_version := v_policy_row.version;
            v_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb);

            v_settings_resolution_id := public.log_settings_resolution(
                p_organization_id := v_org,
                p_category := 'workflow_defaults',
                p_winning_scope_type := v_policy_scope_type,
                p_winning_scope_id := v_policy_scope_id,
                p_winning_settings_id := v_policy_settings_id,
                p_winning_settings_version_id := v_policy_settings_version_id,
                p_winning_version := v_policy_version,
                p_scope_path := v_scope_path,
                p_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'job_id', v_job.job_id,
                    'call_type', v_job.call_type,
                    'target_type', v_job.target_type,
                    'target_id', v_job.target_id
                )),
                p_merge_notes := jsonb_build_object('source', 'run_outbound_worker')
            );

            BEGIN
                v_poll_seconds := NULLIF(v_defaults->>'outbound_poll_seconds', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_seconds := NULL;
            END;
            IF v_poll_seconds IS NULL THEN
                BEGIN
                    v_poll_seconds := NULLIF(v_defaults->>'poll_seconds', '')::INT;
                EXCEPTION
                    WHEN others THEN
                        v_poll_seconds := NULL;
                END;
            END IF;
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

            v_optout := public.should_skip_outbound_call_for_opt_out(
              v_job.call_type,
              v_job.shipment_id,
              COALESCE(v_job.context, '{}'::jsonb)
            );
            IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
                UPDATE public.outbound_calls
                   SET status = 'skipped',
                       completed_at = now(),
                       lease_expires_at = NULL,
                       error_message = COALESCE(v_optout->>'reason', 'skipped')
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
                    p_decision_reason := v_optout->>'reason',
                    p_settings_resolution_id := v_settings_resolution_id
                );

                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

            IF v_job.status = 'pending_edge' THEN
                PERFORM public.mark_outbound_call_in_progress(v_job.job_id);
                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

            IF v_job.context ? 'async_request_id' THEN
                v_async_request_id := NULLIF(v_job.context->>'async_request_id', '')::BIGINT;
            ELSE
                v_async_request_id := NULL;
            END IF;

            IF v_async_request_id IS NOT NULL THEN
                v_poll := public.check_async_response(v_async_request_id);
                v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
                v_status := COALESCE((v_poll->>'status')::INT, 0);

                IF NOT v_completed THEN
                    UPDATE public.outbound_calls
                       SET status = 'pending',
                           scheduled_at = now() + make_interval(secs => v_poll_seconds),
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
                          'poll', v_poll,
                          'poll_seconds', v_poll_seconds
                        ),
                        p_decision_reason := 'Awaiting async HTTP response (polling pg_net).',
                        p_settings_resolution_id := v_settings_resolution_id
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

                    BEGIN
                      PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                    EXCEPTION
                      WHEN OTHERS THEN
                        NULL;
                    END;
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

                    BEGIN
                      PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                    EXCEPTION
                      WHEN OTHERS THEN
                        NULL;
                    END;
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

            IF v_result ? 'edge_dispatch' THEN
                UPDATE public.outbound_calls
                   SET status = 'pending_edge',
                       scheduled_at = now(),
                       lease_expires_at = NULL,
                       context = jsonb_set(
                           (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id'),
                           '{edge_dispatch}',
                           v_result->'edge_dispatch',
                           TRUE
                       )
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
                    p_decision_inputs := v_result->'edge_dispatch',
                    p_decision_reason := 'Edge dispatch required for outbound HTTP execution.',
                    p_settings_resolution_id := v_settings_resolution_id
                );

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

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
                    p_decision_inputs := jsonb_build_object(
                      'status', v_status,
                      'async_request_id', v_async_request_id
                    ),
                    p_decision_reason := 'Outbound HTTP request completed successfully.'
                );

                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;
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

                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;
            ELSE
                UPDATE public.outbound_calls
                   SET status = 'pending',
                       scheduled_at = now() + make_interval(secs => v_poll_seconds),
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
                    p_decision_inputs := COALESCE(v_result, '{}'::jsonb) || jsonb_build_object('poll_seconds', v_poll_seconds),
                    p_decision_reason := 'HTTP request accepted asynchronously; awaiting polling.',
                    p_settings_resolution_id := v_settings_resolution_id
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

                  BEGIN
                    PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                  EXCEPTION
                    WHEN OTHERS THEN
                      NULL;
                  END;
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
