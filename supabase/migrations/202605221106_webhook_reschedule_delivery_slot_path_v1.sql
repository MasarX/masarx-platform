-- Purpose:
--   Allow workflow-backed webhook reschedules to resolve the provider-native
--   delivery.slot_date payload path while preserving the existing top-level
--   Console/UI reschedule contract.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605221106_webhook_reschedule_delivery_slot_path_v1'));
SET LOCAL lock_timeout = '30s';
SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.resolve_reschedule_slot_date_v1(
  p_context JSONB,
  p_payload JSONB DEFAULT NULL
)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_payload JSONB := COALESCE(p_payload, workflow_handlers.resolve_input_payload_v1(v_context), '{}'::jsonb);
  v_raw TEXT := NULL;
BEGIN
  v_raw := COALESCE(
    NULLIF(v_context->>'slot_date', ''),
    NULLIF(v_context#>>'{delivery,slot_date}', ''),
    NULLIF(v_context#>>'{reschedule,slot_date}', ''),
    NULLIF(v_context#>>'{transformed_payload,slot_date}', ''),
    NULLIF(v_context#>>'{transformed_payload,delivery,slot_date}', ''),
    NULLIF(v_context#>>'{transformed_payload,reschedule,slot_date}', ''),
    NULLIF(v_context#>>'{payload,slot_date}', ''),
    NULLIF(v_context#>>'{payload,delivery,slot_date}', ''),
    NULLIF(v_context#>>'{payload,reschedule,slot_date}', ''),
    NULLIF(v_payload->>'slot_date', ''),
    NULLIF(v_payload#>>'{delivery,slot_date}', ''),
    NULLIF(v_payload#>>'{reschedule,slot_date}', '')
  );

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_raw::DATE;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.resolve_reschedule_slot_date_v1(JSONB, JSONB)
  IS 'Resolve shipment reschedule slot_date from Console/UI top-level payloads and provider webhook delivery.slot_date payloads.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_reschedule_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := workflow_handlers.resolve_input_payload_v1(v_ctx);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_allowed_statuses JSONB := COALESCE(
    v_policy#>'{reschedule,allowed_statuses}',
    v_policy#>'{address,allowed_statuses}',
    '[]'::jsonb
  );
  v_slot_date DATE := NULL;
  v_reserve_result JSONB := '{}'::jsonb;
  v_action_id UUID := NULL;
  v_performed_by_system TEXT := COALESCE(
    NULLIF(v_ctx->>'performed_by_system', ''),
    'workflow_handlers.execute_shipment_reschedule_v1'
  );
BEGIN
  SELECT *
    INTO v_target
    FROM workflow_handlers.resolve_shipment_target_v1(v_ctx)
   LIMIT 1;

  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF NOT workflow_handlers.shipment_status_allowed_v1(v_target.status, v_allowed_statuses) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_status_not_allowed';
    v_result.operation_result := jsonb_build_object(
      'error',
      'shipment_status_not_allowed',
      'status',
      v_target.status
    );
    RETURN v_result;
  END IF;

  v_slot_date := workflow_handlers.resolve_reschedule_slot_date_v1(v_ctx, v_payload);

  IF v_slot_date IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'slot_date_required';
    v_result.operation_result := jsonb_build_object('error', 'slot_date_required');
    RETURN v_result;
  END IF;

  v_reserve_result := public.reserve_delivery_slot_v1(
    jsonb_build_object(
      'shipment_id',
      v_target.shipment_id,
      'client_id',
      v_target.client_id,
      'slot_date',
      v_slot_date,
      'performed_by_system',
      v_performed_by_system
    )
  );

  IF COALESCE((v_reserve_result->>'reserved')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    v_result.status := 'failed';
    v_result.last_error := COALESCE(v_reserve_result->>'reason', 'reschedule_failed');
    v_result.operation_result := v_reserve_result;
    RETURN v_result;
  END IF;

  BEGIN
    v_action_id := NULLIF(v_reserve_result->>'action_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_action_id := NULL;
  END;

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.context_patch := jsonb_build_object(
    'shipment',
    jsonb_build_object(
      'id',
      v_target.shipment_id,
      'tracking_number',
      v_target.tracking_number
    )
  );
  v_result.operation_result := jsonb_strip_nulls(
    jsonb_build_object(
      'shipment_id',
      v_target.shipment_id,
      'shipment_action_id',
      v_action_id,
      'slot_date',
      v_slot_date,
      'operation',
      CASE
        WHEN COALESCE((v_reserve_result->>'updated')::BOOLEAN, FALSE) THEN 'rescheduled'
        ELSE 'reschedule_no_change'
      END,
      'reserve_result',
      v_reserve_result
    )
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION workflow_handlers.resolve_reschedule_slot_date_v1(JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION workflow_handlers.resolve_reschedule_slot_date_v1(JSONB, JSONB) TO service_role;

REVOKE ALL ON FUNCTION workflow_handlers.execute_shipment_reschedule_v1(public.workflow_run_steps, public.workflow_runs, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_shipment_reschedule_v1(public.workflow_run_steps, public.workflow_runs, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_delete_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := workflow_handlers.resolve_input_payload_v1(v_ctx);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_allowed_statuses JSONB := COALESCE(v_policy#>'{delete,allowed_statuses}', '[]'::jsonb);
  v_target_status TEXT := COALESCE(NULLIF(v_policy#>>'{delete,target_status}', ''), 'cancelled');
  v_window_hours INT := COALESCE(NULLIF(v_policy#>>'{delete,window_hours}', '')::INT, 24);
  v_delete_mode TEXT := lower(COALESCE(NULLIF(v_policy#>>'{delete,mode}', ''), 'soft_cancel'));
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_cancel_reason TEXT := NULLIF(btrim(COALESCE(
    NULLIF(v_ctx->>'cancel_reason', ''),
    NULLIF(v_ctx->>'reason', ''),
    NULLIF(v_ctx#>>'{shipment,cancel_reason}', ''),
    NULLIF(v_ctx#>>'{shipment,reason}', ''),
    NULLIF(v_ctx#>>'{cancellation,reason}', ''),
    NULLIF(v_ctx#>>'{transformed_payload,cancel_reason}', ''),
    NULLIF(v_ctx#>>'{transformed_payload,reason}', ''),
    NULLIF(v_ctx#>>'{transformed_payload,shipment,cancel_reason}', ''),
    NULLIF(v_ctx#>>'{transformed_payload,shipment,reason}', ''),
    NULLIF(v_ctx#>>'{payload,cancel_reason}', ''),
    NULLIF(v_ctx#>>'{payload,reason}', ''),
    NULLIF(v_ctx#>>'{payload,shipment,cancel_reason}', ''),
    NULLIF(v_ctx#>>'{payload,shipment,reason}', ''),
    NULLIF(v_payload->>'cancel_reason', ''),
    NULLIF(v_payload->>'reason', ''),
    NULLIF(v_payload#>>'{shipment,cancel_reason}', ''),
    NULLIF(v_payload#>>'{shipment,reason}', '')
  )), '');
BEGIN
  IF v_delete_mode <> 'soft_cancel' THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_delete_mode_not_supported';
    v_result.operation_result := jsonb_build_object('error', 'shipment_delete_mode_not_supported', 'mode', v_delete_mode);
    RETURN v_result;
  END IF;

  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF NOT workflow_handlers.shipment_status_allowed_v1(v_target.status, v_allowed_statuses) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_status_not_allowed';
    v_result.operation_result := jsonb_build_object('error', 'shipment_status_not_allowed', 'status', v_target.status);
    RETURN v_result;
  END IF;

  IF v_window_hours > 0 AND v_target.created_at < now() - make_interval(hours => v_window_hours) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_delete_window_expired';
    v_result.operation_result := jsonb_build_object('error', 'shipment_delete_window_expired', 'window_hours', v_window_hours);
    RETURN v_result;
  END IF;

  UPDATE public.shipments
     SET status = v_target_status,
         status_updated_at = now(),
         updated_at = now(),
         metadata = public.deep_merge_jsonb(
           COALESCE(metadata, '{}'::jsonb),
           jsonb_strip_nulls(jsonb_build_object(
             'deleted_by_workflow', TRUE,
             'delete_operation', 'soft_cancel',
             'cancel_reason', v_cancel_reason
           ))
         )
   WHERE id = v_target.shipment_id;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    'delete',
    'administrative',
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key', v_event_id,
      'target_status', v_target_status,
      'cancel_reason', v_cancel_reason
    )),
    v_cancel_reason,
    v_target_status,
    'workflow_handlers.execute_shipment_delete_v1',
    NULL,
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.context_patch := jsonb_build_object(
    'shipment',
    jsonb_strip_nulls(jsonb_build_object(
      'id', v_target.shipment_id,
      'tracking_number', v_target.tracking_number,
      'cancel_reason', v_cancel_reason
    ))
  );
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'shipment_action_id', v_action_id,
    'status', v_target_status,
    'operation', 'soft_cancel',
    'cancel_reason', v_cancel_reason
  ));
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION workflow_handlers.execute_shipment_delete_v1(public.workflow_run_steps, public.workflow_runs, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_shipment_delete_v1(public.workflow_run_steps, public.workflow_runs, JSONB) TO service_role;

CREATE OR REPLACE VIEW public.v_webhook_inbox_directory
  WITH (security_invoker = true)
  AS
WITH inbox_projection AS (
  SELECT
    wi.*,
    wr.workflow_status AS entry_workflow_status,
    wr.completed_at AS entry_completed_at,
    wr.context AS entry_context,
    followup_wr.id AS followup_workflow_run_id,
    followup_wr.workflow_status AS followup_workflow_status,
    followup_wr.completed_at AS followup_completed_at,
    followup_wr.last_error AS followup_last_error,
    followup_wr.context AS followup_context
  FROM public.webhook_inbox wi
  LEFT JOIN public.workflow_runs wr ON wr.id = wi.workflow_run_id
  LEFT JOIN public.workflow_runs followup_wr
    ON followup_wr.id::TEXT = NULLIF(wr.context->>'followup_workflow_run_id', '')
)
SELECT
  wi.id,
  wi.organization_id,
  wi.webhook_source_id,
  wi.provider_type,
  wi.external_id,
  wi.event_type,
  CASE
    WHEN wi.processing_status IN ('pending', 'processing', 'in_progress', 'processed')
     AND wi.followup_workflow_status = 'failed'
      THEN 'failed'
    WHEN wi.processing_status IN ('pending', 'processing', 'in_progress', 'processed')
     AND COALESCE(wi.followup_workflow_status, wi.entry_workflow_status) = 'completed'
     AND shp.id IS NOT NULL
      THEN 'succeeded'
    ELSE wi.processing_status
  END AS processing_status,
  wi.correlation_id,
  wi.idempotency_key,
  wi.workflow_run_id,
  wi.lease_expires_at,
  wi.created_at,
  COALESCE(
    wi.processed_at,
    CASE
      WHEN wi.processing_status IN ('pending', 'processing', 'in_progress', 'processed')
       AND wi.followup_workflow_status = 'failed'
        THEN COALESCE(wi.followup_completed_at, wi.entry_completed_at)
      WHEN wi.processing_status IN ('pending', 'processing', 'in_progress', 'processed')
       AND COALESCE(wi.followup_workflow_status, wi.entry_workflow_status) = 'completed'
       AND shp.id IS NOT NULL
        THEN COALESCE(wi.followup_completed_at, wi.entry_completed_at)
      ELSE NULL
    END
  ) AS processed_at,
  COALESCE(
    wi.error_message,
    CASE
      WHEN wi.processing_status IN ('pending', 'processing', 'in_progress', 'processed')
       AND wi.followup_workflow_status = 'failed'
        THEN wi.followup_last_error::TEXT
      ELSE NULL
    END
  ) AS error_message,
  wi.raw_payload,
  wi.transformed_payload,
  wi.ack_mode,
  wi.ack_status_code,
  wi.ack_outcome,
  wi.ack_reason,
  wi.ack_body,
  wi.ack_validation,
  wi.entry_workflow_status AS workflow_run_status,
  COALESCE(wi.ack_validation#>>'{intent,canonical}', wi.event_type) AS canonical_intent,
  shp.id AS shipment_id,
  shp.tracking_number,
  shp.status AS shipment_status,
  length(wi.raw_payload::text) AS payload_size,
  ws.name              AS source_label,
  ws.source_identifier AS source_identifier,
  ws.provider_type     AS provider_type_label,
  COALESCE(replay_agg.replay_count, 0) AS replay_count,
  COALESCE(replay_agg.force_status_count, 0) AS force_status_count,
  replay_agg.last_replay_at,
  replay_agg.last_replay_action,
  replay_agg.last_replay_actor,
  (
    CASE
      WHEN wi.processing_status IN ('pending', 'processing', 'in_progress', 'processed')
       AND wi.followup_workflow_status = 'failed'
        THEN 'failed'
      WHEN wi.processing_status IN ('pending', 'processing', 'in_progress', 'processed')
       AND COALESCE(wi.followup_workflow_status, wi.entry_workflow_status) = 'completed'
       AND shp.id IS NOT NULL
        THEN 'succeeded'
      ELSE wi.processing_status
    END
  ) IN ('succeeded', 'failed', 'dead_letter', 'processed') AS is_terminal,
  (
    CASE
      WHEN wi.processing_status IN ('pending', 'processing', 'in_progress', 'processed')
       AND wi.followup_workflow_status = 'failed'
        THEN 'failed'
      WHEN wi.processing_status IN ('pending', 'processing', 'in_progress', 'processed')
       AND COALESCE(wi.followup_workflow_status, wi.entry_workflow_status) = 'completed'
       AND shp.id IS NOT NULL
        THEN 'succeeded'
      ELSE wi.processing_status
    END
  ) IN ('pending', 'processing', 'failed', 'dead_letter', 'in_progress') AS is_actionable,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - wi.created_at)))::BIGINT AS age_seconds,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - wi.created_at)) / 3600.0))::BIGINT AS age_hours,
  ws.mapping_config_id,
  mc.mapping_key AS mapping_label,
  mc.mapping_config->>'target' AS mapping_target,
  mc.mapping_version AS mapping_version,
  CASE
    WHEN jsonb_typeof(mc.mapping_config->'rules') = 'array'
      THEN jsonb_array_length(mc.mapping_config->'rules')
    ELSE 0
  END AS mapping_rules_count,
  response_latest.response_outcome,
  response_latest.response_reason,
  response_latest.response_mode,
  response_latest.http_status_code AS response_status_code,
  wi.followup_workflow_run_id,
  wi.followup_workflow_status,
  wi.followup_last_error
FROM inbox_projection wi
LEFT JOIN public.webhook_sources ws ON ws.id = wi.webhook_source_id
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN public.webhook_response_latest response_latest ON response_latest.webhook_inbox_id = wi.id
LEFT JOIN LATERAL (
  SELECT s.id, s.tracking_number, s.status, s.created_at
    FROM public.shipments s
   WHERE s.organization_id = wi.organization_id
     AND (
       s.metadata->>'source_webhook_id' = wi.id::TEXT
       OR s.metadata#>>'{provider_payload,webhook_id}' = wi.id::TEXT
       OR (wi.workflow_run_id IS NOT NULL AND s.metadata->>'workflow_run_id' = wi.workflow_run_id::TEXT)
       OR (wi.workflow_run_id IS NOT NULL AND s.metadata#>>'{provider_payload,workflow_run_id}' = wi.workflow_run_id::TEXT)
       OR (wi.followup_workflow_run_id IS NOT NULL AND s.metadata->>'workflow_run_id' = wi.followup_workflow_run_id::TEXT)
       OR (wi.followup_workflow_run_id IS NOT NULL AND s.metadata#>>'{provider_payload,workflow_run_id}' = wi.followup_workflow_run_id::TEXT)
       OR (wi.followup_context#>>'{shipment,id}' IS NOT NULL AND s.id::TEXT = wi.followup_context#>>'{shipment,id}')
       OR (
         NULLIF(
           COALESCE(
             wi.followup_context#>>'{shipment,tracking_number}',
             wi.followup_context#>>'{transformed_payload,shipment,tracking_number}',
             wi.followup_context#>>'{payload,shipment,tracking_number}',
             wi.transformed_payload#>>'{shipment,tracking_number}',
             wi.raw_payload#>>'{shipment,tracking_number}'
           ),
           ''
         ) IS NOT NULL
         AND s.tracking_number = NULLIF(
           COALESCE(
             wi.followup_context#>>'{shipment,tracking_number}',
             wi.followup_context#>>'{transformed_payload,shipment,tracking_number}',
             wi.followup_context#>>'{payload,shipment,tracking_number}',
             wi.transformed_payload#>>'{shipment,tracking_number}',
             wi.raw_payload#>>'{shipment,tracking_number}'
           ),
           ''
         )
       )
     )
   ORDER BY
     (s.metadata->>'source_webhook_id' = wi.id::TEXT) DESC,
     (s.metadata#>>'{provider_payload,webhook_id}' = wi.id::TEXT) DESC,
     (wi.followup_context#>>'{shipment,id}' IS NOT NULL AND s.id::TEXT = wi.followup_context#>>'{shipment,id}') DESC,
     s.created_at DESC
   LIMIT 1
) shp ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE wir.action = 'replay') AS replay_count,
    COUNT(*) FILTER (WHERE wir.action = 'force_status') AS force_status_count,
    MAX(wir.created_at) AS last_replay_at,
    (
      SELECT wir2.action
        FROM public.webhook_inbox_replays wir2
       WHERE wir2.webhook_inbox_id = wi.id
       ORDER BY wir2.created_at DESC
       LIMIT 1
    ) AS last_replay_action,
    (
      SELECT u.full_name
        FROM public.webhook_inbox_replays wir3
        LEFT JOIN public.users u ON u.id = wir3.changed_by
       WHERE wir3.webhook_inbox_id = wi.id
       ORDER BY wir3.created_at DESC
       LIMIT 1
    ) AS last_replay_actor
    FROM public.webhook_inbox_replays wir
   WHERE wir.webhook_inbox_id = wi.id
) replay_agg ON TRUE;

COMMENT ON VIEW public.v_webhook_inbox_directory IS
  'FE-friendly projection of webhook_inbox with source labels, mapping evidence, replay counters, workflow/idempotency readback, HTTP response outcome readback, raw/transformed payloads, ack validation, and shipment linkage from source_webhook_id, workflow lineage, or completed mutation follow-up context. Accepted-async shipment rows project as terminal only after backend workflow completion plus canonical shipment readback.';

REVOKE ALL ON public.v_webhook_inbox_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_inbox_directory FROM anon;
GRANT SELECT ON public.v_webhook_inbox_directory TO authenticated;
GRANT SELECT ON public.v_webhook_inbox_directory TO service_role;

COMMIT;
