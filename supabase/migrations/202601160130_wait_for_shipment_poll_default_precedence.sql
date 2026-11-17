-- Migration: wait_for_shipment prefers workflow_defaults.poll_seconds over min
-- Purpose:
--   - Ensure default polling cadence follows poll_seconds when metadata absent.
--   - Preserve min/max bounds for clamping without overriding the default.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-16
BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_wait_for_shipment_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
SECURITY DEFINER
LANGUAGE plpgsql
AS $function$
DECLARE
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_request_id TEXT;
  v_poll_seconds INT := NULL;
  v_poll_default INT := NULL;
  v_poll_min INT := NULL;
  v_poll_max INT := NULL;
  v_max_wait_seconds INT := COALESCE(NULLIF(v_metadata->>'max_wait_seconds', '')::INT, 900);
  v_elapsed_seconds INT := 0;
  v_shipment RECORD;
  v_policy_row RECORD;
  v_defaults JSONB;
  v_response public.workflow_handler_response;
  v_now TIMESTAMPTZ := now();
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_context(
      'workflow_defaults',
      COALESCE(p_run.context, '{}'::jsonb)
    )
   LIMIT 1;
  v_defaults := v_policy_row.value;
  IF v_defaults IS NULL THEN
    v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
  END IF;

  BEGIN
    v_poll_seconds := NULLIF(v_metadata->>'poll_interval_seconds', '')::INT;
  EXCEPTION
    WHEN others THEN
      v_poll_seconds := NULL;
  END;
  BEGIN
    v_poll_default := NULLIF(v_defaults->>'poll_seconds', '')::INT;
  EXCEPTION
    WHEN others THEN
      v_poll_default := NULL;
  END;
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

  IF v_poll_seconds IS NULL THEN
    v_poll_seconds := COALESCE(v_poll_default, v_poll_min, 30);
  END IF;
  v_poll_min := COALESCE(v_poll_min, v_poll_seconds);
  v_poll_max := COALESCE(v_poll_max, v_poll_seconds);
  v_poll_seconds := LEAST(GREATEST(v_poll_seconds, v_poll_min), v_poll_max);

  v_request_id := COALESCE(
    NULLIF(v_context->'api_gateway'->>'api_gateway_request_id', ''),
    NULLIF(v_context->>'api_gateway_request_id', ''),
    NULLIF(p_operation_result->>'api_gateway_request_id', '')
  );

  IF v_request_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'shipment_found', FALSE,
      'reason', 'api_gateway_request_id_missing'
    );
    RETURN v_response;
  END IF;

  IF p_step.operation_started_at IS NOT NULL THEN
    v_elapsed_seconds := GREATEST(0, (extract(epoch FROM (v_now - p_step.operation_started_at)))::INT);
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.destination_address_id
  INTO v_shipment
  FROM public.shipments s
  WHERE s.metadata #>> '{source,api_gateway_request_id}' = v_request_id
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'shipment_found', TRUE,
      'shipment_id', v_shipment.id,
      'api_gateway_request_id', v_request_id
    );
    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_shipment.id,
      'organization_id', v_shipment.organization_id,
      'client_id', v_shipment.client_id,
      'sender_id', v_shipment.sender_id,
      'address_id', v_shipment.destination_address_id,
      'shipment', jsonb_strip_nulls(jsonb_build_object(
        'id', v_shipment.id,
        'destination_address_id', v_shipment.destination_address_id
      ))
    ));
    RETURN v_response;
  END IF;

  IF v_elapsed_seconds >= v_max_wait_seconds THEN
    v_response.status := 'failed';
    v_response.workflow_status := 'failed';
    v_response.last_error := 'shipment_wait_timeout';
    v_response.operation_result := jsonb_build_object(
      'shipment_found', FALSE,
      'reason', 'timeout',
      'max_wait_seconds', v_max_wait_seconds,
      'api_gateway_request_id', v_request_id
    );
    RETURN v_response;
  END IF;

  v_response.status := 'pending';
  v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
  v_response.next_run_at := v_now + make_interval(secs => v_poll_seconds);
  v_response.operation_result := jsonb_build_object(
    'shipment_found', FALSE,
    'next_poll_seconds', v_poll_seconds,
    'api_gateway_request_id', v_request_id
  );
  RETURN v_response;
END;
$function$;

COMMIT;
