-- Plan: PLAN-202601-demo-speed-here-failfast / Step: S04
-- Migration: Restore edge dispatch handling in run_outbound_worker
-- Date: 2026-01-11
BEGIN;

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
                    p_decision_reason := 'Edge dispatch required for outbound HTTP execution.'
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
