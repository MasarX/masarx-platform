-- Migration: Outbound WhatsApp opt-out enforcement (queue-time)
-- Purpose:
--   - Persist opt-out and block future WhatsApp sends consistently (not just stop a workflow).
--   - Enforce at the unified outbound worker so all comms_whatsapp outbound_calls respect recipient_preferences.
-- Date: 2025-12-14

BEGIN;

-- Add a canonical "skipped" job status for policy-driven suppression (e.g., opted-out).
INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default
)
SELECT
    ld.id,
    'skipped',
    'Skipped',
    'Job suppressed by policy (e.g., recipient opted out or compliance gating).',
    15,
    FALSE
FROM public.lookup_definitions ld
WHERE ld.category = 'job_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.should_skip_outbound_call_for_opt_out(
  p_call_type TEXT,
  p_shipment_id UUID,
  p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_call_type TEXT := COALESCE(p_call_type, '');
  v_allow_opted_out_send BOOLEAN := FALSE;
  v_recipient_id UUID := NULL;
  v_opted_out BOOLEAN := FALSE;
BEGIN
  IF v_call_type <> 'comms_whatsapp' THEN
    RETURN jsonb_build_object('skip', FALSE);
  END IF;

  v_allow_opted_out_send := COALESCE(NULLIF(p_context->>'allow_opted_out_send', '')::BOOLEAN, FALSE);
  IF v_allow_opted_out_send THEN
    RETURN jsonb_build_object('skip', FALSE, 'reason', 'allow_opted_out_send');
  END IF;

  BEGIN
    v_recipient_id := NULLIF(p_context->>'recipient_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_recipient_id := NULL;
  END;

  IF v_recipient_id IS NULL AND p_shipment_id IS NOT NULL THEN
    SELECT recipient_id
      INTO v_recipient_id
      FROM public.shipments
     WHERE id = p_shipment_id;
  END IF;

  IF v_recipient_id IS NULL THEN
    RETURN jsonb_build_object('skip', FALSE, 'reason', 'recipient_unresolved');
  END IF;

  SELECT opted_out
    INTO v_opted_out
    FROM public.recipient_preferences
   WHERE recipient_id = v_recipient_id
     AND channel = 'whatsapp'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;

  v_opted_out := COALESCE(v_opted_out, FALSE);
  IF v_opted_out THEN
    RETURN jsonb_build_object(
      'skip', TRUE,
      'reason', 'recipient_opted_out',
      'recipient_id', v_recipient_id,
      'channel', 'whatsapp'
    );
  END IF;

  RETURN jsonb_build_object(
    'skip', FALSE,
    'recipient_id', v_recipient_id,
    'channel', 'whatsapp'
  );
END;
$$;

COMMENT ON FUNCTION public.should_skip_outbound_call_for_opt_out(TEXT, UUID, JSONB)
  IS 'Return {"skip":true} when a comms_whatsapp outbound_call must be suppressed due to recipient opt-out (unless allow_opted_out_send=true).';

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

            v_optout := public.should_skip_outbound_call_for_opt_out(v_job.call_type, v_job.shipment_id, COALESCE(v_job.context, '{}'::jsonb));
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
                       lease_expires_at = NULL,
                       context = jsonb_set(
                           COALESCE(public.outbound_calls.context, '{}'::jsonb),
                           '{edge_dispatch}',
                           v_result->'edge_dispatch',
                           TRUE
                       ),
                       scheduled_at = now()
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
            ELSIF v_completed AND v_status BETWEEN 200 AND 299 THEN
                UPDATE public.outbound_calls
                   SET status = 'completed',
                       response_status_code = v_status,
                       response_body = v_result->'body',
                       response_headers = v_result->'headers',
                       latency_ms = (v_result->>'latency_ms')::INT,
                       completed_at = now(),
                       error_message = NULL
                 WHERE id = v_job.job_id;

                PERFORM public.orchestrate_api_response_processing(v_job.job_id);

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
                UPDATE public.outbound_calls
                   SET status = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN 'permanently_failed' ELSE 'failed' END,
                       retry_count = v_job.retry_count + 1,
                       response_status_code = v_status,
                       response_body = v_result->'body',
                       response_headers = v_result->'headers',
                       error_message = COALESCE(v_result->'body'->>'error', format('HTTP %s failure', v_status)),
                       completed_at = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN now() ELSE NULL END
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'error',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := jsonb_build_object('status', v_status),
                    p_decision_reason := format('Outbound HTTP request failed with status %s', v_status)
                );
            ELSE
                UPDATE public.outbound_calls
                   SET status = 'pending',
                       scheduled_at = now() + interval '30 seconds',
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
                UPDATE public.outbound_calls
                   SET status = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN 'permanently_failed' ELSE 'failed' END,
                       retry_count = v_job.retry_count + 1,
                       error_message = SQLERRM,
                       completed_at = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN now() ELSE NULL END
                 WHERE id = v_job.job_id;

                IF v_org IS NOT NULL THEN
                    PERFORM public.log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'exception',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_reason := SQLERRM
                    );
                END IF;
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

