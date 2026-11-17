-- Plan: PLAN-202603-webhook-shipment-ingestion-contract-hardening / Step: S04
-- Migration: Shipment create duplicate contract hardening
-- Purpose:
--   - Centralize shipment-create duplicate detection across workflow and API ingress.
--   - Keep duplicate criteria limited to the approved keys: tracking and client reference
--     within a client scope, plus upstream idempotency on webhook intake.
--   - Fail closed when tracking and client reference resolve to different shipments.
--   - Ensure API shipment-create reuses existing shipments consistently and does not rerun
--     follow-up side effects on duplicate creates.
-- Date: 2026-03-11

BEGIN;

CREATE OR REPLACE FUNCTION public.find_shipment_by_tracking_v1(
  p_client_id UUID,
  p_tracking_number TEXT
)
RETURNS TABLE (
  shipment_id UUID,
  tracking_number TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT s.id AS shipment_id, s.tracking_number
  FROM public.shipments s
  WHERE s.client_id = p_client_id
    AND s.tracking_upper = upper(NULLIF(btrim(p_tracking_number), ''))
  ORDER BY s.created_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.find_shipment_by_tracking_v1(UUID, TEXT)
  IS 'Find a shipment by normalized tracking_number within a client scope (case/trim-insensitive).';

CREATE OR REPLACE FUNCTION public.resolve_shipment_create_duplicate_v1(
  p_client_id UUID,
  p_tracking_number TEXT DEFAULT NULL,
  p_client_reference_number TEXT DEFAULT NULL
)
RETURNS TABLE (
  shipment_id UUID,
  tracking_number TEXT,
  operation TEXT,
  matched_on TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_tracking_shipment_id UUID;
  v_tracking_match_number TEXT;
  v_client_reference_shipment_id UUID;
  v_client_reference_match_number TEXT;
  v_tracking_input TEXT := NULLIF(btrim(p_tracking_number), '');
  v_client_reference_input TEXT := NULLIF(btrim(p_client_reference_number), '');
BEGIN
  IF p_client_id IS NULL THEN
    RETURN;
  END IF;

  IF v_tracking_input IS NOT NULL THEN
    SELECT tracking_match.shipment_id, tracking_match.tracking_number
      INTO v_tracking_shipment_id, v_tracking_match_number
      FROM public.find_shipment_by_tracking_v1(p_client_id, v_tracking_input) AS tracking_match
     LIMIT 1;
  END IF;

  IF v_client_reference_input IS NOT NULL THEN
    SELECT client_reference_match.shipment_id, client_reference_match.tracking_number
      INTO v_client_reference_shipment_id, v_client_reference_match_number
      FROM public.find_shipment_by_client_reference_v1(p_client_id, v_client_reference_input) AS client_reference_match
     LIMIT 1;
  END IF;

  IF v_tracking_shipment_id IS NOT NULL
     AND v_client_reference_shipment_id IS NOT NULL
     AND v_tracking_shipment_id <> v_client_reference_shipment_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'shipment_create_duplicate_key_mismatch',
      DETAIL = jsonb_build_object(
        'client_id', p_client_id,
        'tracking_number', v_tracking_input,
        'tracking_shipment_id', v_tracking_shipment_id,
        'client_reference_number', v_client_reference_input,
        'client_reference_shipment_id', v_client_reference_shipment_id
      )::text,
      HINT = 'tracking_number and client_reference_number must resolve to the same shipment or one key must be absent';
  END IF;

  IF v_tracking_shipment_id IS NOT NULL THEN
    shipment_id := v_tracking_shipment_id;
    tracking_number := v_tracking_match_number;
    operation := 'reused';
    matched_on := CASE
      WHEN v_client_reference_shipment_id IS NOT NULL THEN 'tracking+client_reference'
      ELSE 'tracking'
    END;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_client_reference_shipment_id IS NOT NULL THEN
    shipment_id := v_client_reference_shipment_id;
    tracking_number := COALESCE(v_client_reference_match_number, v_tracking_input);
    operation := 'reused_client_reference';
    matched_on := 'client_reference';
    RETURN NEXT;
    RETURN;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.resolve_shipment_create_duplicate_v1(UUID, TEXT, TEXT)
  IS 'Resolve shipment-create duplicates within a client scope using tracking_number and client_reference_number; raises shipment_create_duplicate_key_mismatch when the approved keys point to different shipments.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_create_v1(
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
    v_ctx_patch JSONB := COALESCE(v_ctx->'workflow'->'context_patch', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
    v_resource JSONB := COALESCE(v_payload->'resource', '{}'::jsonb);

    v_org UUID := COALESCE(
        NULLIF(v_ctx->>'organization_id', '')::UUID,
        NULLIF(v_ctx_patch->>'organization_id', '')::UUID
    );
    v_client UUID := COALESCE(
        NULLIF(v_ctx->>'client_id', '')::UUID,
        NULLIF(v_ctx_patch->>'client_id', '')::UUID
    );
    v_sender UUID := COALESCE(
        NULLIF(v_ctx->>'sender_id', '')::UUID,
        NULLIF(v_ctx_patch->>'sender_id', '')::UUID
    );
    v_planned_id UUID := COALESCE(
        NULLIF(v_ctx->>'planned_shipment_id', '')::UUID,
        NULLIF(v_ctx->>'planned_resource_id', '')::UUID,
        NULLIF(v_ctx_patch->>'planned_shipment_id', '')::UUID,
        NULLIF(v_ctx_patch->>'planned_resource_id', '')::UUID,
        NULLIF((v_ctx->'shipment'->>'id'), '')::UUID,
        NULLIF((v_ctx_patch->'shipment'->>'id'), '')::UUID
    );
    v_planned_tracking TEXT := COALESCE(
        NULLIF(v_ctx->>'planned_tracking_number', ''),
        NULLIF(v_ctx_patch->>'planned_tracking_number', ''),
        NULLIF((v_ctx->'shipment'->>'tracking_number'), ''),
        NULLIF((v_ctx_patch->'shipment'->>'tracking_number'), '')
    );
    v_service_type TEXT := COALESCE(NULLIF(v_ctx->>'service_type', ''), 'delivery');
    v_status TEXT := COALESCE(NULLIF(v_ctx->>'initial_status', ''), 'pending');
    v_metadata_source UUID := COALESCE(
        NULLIF(v_ctx->>'webhook_id', '')::UUID,
        NULLIF(v_ctx_patch->>'webhook_id', '')::UUID
    );

    v_client_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'client_reference_number', ''),
        NULLIF(v_ctx_patch->>'client_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_resource->>'client_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,client_reference_number}', '')
    );
    v_carrier_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'carrier_reference_number', ''),
        NULLIF(v_ctx_patch->>'carrier_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_resource->>'carrier_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,carrier_reference_number}', '')
    );

    v_logistics_refs JSONB;
    v_reference_map JSONB := '{}'::jsonb;
    v_refs JSONB := '{}'::jsonb;
    v_ref_meta JSONB;

    v_correlation_id UUID;
    v_row_id UUID;
    v_tracking_number TEXT;
    v_operation TEXT := 'inserted';
    v_result public.workflow_handler_response;
BEGIN
    BEGIN
      v_correlation_id := NULLIF(v_ctx->>'correlation_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_correlation_id := NULL;
    END;
    IF v_correlation_id IS NULL THEN
      BEGIN
        v_correlation_id := NULLIF(v_ctx_patch->>'correlation_id', '')::UUID;
      EXCEPTION
        WHEN others THEN
          v_correlation_id := NULL;
      END;
    END IF;

    IF v_org IS NULL OR v_client IS NULL OR v_planned_tracking IS NULL THEN
        RAISE EXCEPTION 'execute_shipment_create_v1: missing required context (org %, client %, tracking %)',
            v_org, v_client, v_planned_tracking;
    END IF;

    IF v_planned_id IS NULL THEN
        v_planned_id := gen_random_uuid();
    END IF;

    IF jsonb_typeof(v_resource->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_resource->'references';
    END IF;
    IF jsonb_typeof(v_ctx->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_ctx->'references';
    END IF;
    IF jsonb_typeof(v_ctx_patch->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_ctx_patch->'references';
    END IF;

    v_logistics_refs := NULL;
    IF jsonb_typeof(v_resource->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_resource->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_resource->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_resource->'logistics_reference_number';
    ELSIF jsonb_typeof(v_ctx->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_ctx->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_ctx->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_ctx->'logistics_reference_number';
    ELSIF jsonb_typeof(v_ctx_patch->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_ctx_patch->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_ctx_patch->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_ctx_patch->'logistics_reference_number';
    END IF;

    v_refs := jsonb_strip_nulls(
      v_reference_map || jsonb_build_object(
        'client_reference_number', NULLIF(btrim(v_client_reference), ''),
        'carrier_reference_number', NULLIF(btrim(v_carrier_reference), '')
      )
    );
    IF v_logistics_refs IS NOT NULL THEN
      v_refs := jsonb_strip_nulls(v_refs || jsonb_build_object('logistics_reference_number', v_logistics_refs));
    END IF;

    SELECT resolved.shipment_id, resolved.tracking_number, resolved.operation
      INTO v_row_id, v_tracking_number, v_operation
      FROM public.resolve_shipment_create_duplicate_v1(
        v_client,
        v_planned_tracking,
        v_client_reference
      ) AS resolved
     LIMIT 1;

    IF v_row_id IS NULL THEN
      BEGIN
        INSERT INTO public.shipments (
            id,
            organization_id,
            client_id,
            sender_id,
            service_type,
            tracking_number,
            carrier_reference_number,
            client_reference_number,
            status,
            box_count,
            metadata
        )
        VALUES (
            v_planned_id,
            v_org,
            v_client,
            v_sender,
            v_service_type,
            v_planned_tracking,
            NULLIF(btrim(v_carrier_reference), ''),
            NULLIF(btrim(v_client_reference), ''),
            v_status,
            1,
            jsonb_strip_nulls(jsonb_build_object(
                'created_by', 'workflow',
                'workflow_run_id', p_run.id,
                'source_webhook_id', v_metadata_source
            ))
        );
      EXCEPTION
        WHEN unique_violation THEN
          SELECT resolved.shipment_id, resolved.tracking_number, resolved.operation
            INTO v_row_id, v_tracking_number, v_operation
            FROM public.resolve_shipment_create_duplicate_v1(
              v_client,
              v_planned_tracking,
              v_client_reference
            ) AS resolved
           LIMIT 1;

          IF v_row_id IS NULL THEN
            RAISE;
          END IF;
      END;

      IF v_row_id IS NULL THEN
        v_row_id := v_planned_id;
        v_tracking_number := v_planned_tracking;
      END IF;
    END IF;

    IF v_operation = 'reused' THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'shipment_create',
        p_resource_type := 'shipment',
        p_resource_id := v_row_id,
        p_decision_point := 'tracking_unique',
        p_decision_outcome := 'reused_existing_shipment',
        p_performed_by_system := 'workflow_handlers.execute_shipment_create_v1',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'planned_shipment_id', v_planned_id,
          'planned_tracking_number', v_planned_tracking,
          'client_reference_number', NULLIF(btrim(v_client_reference), '')
        )),
        p_decision_reason := 'tracking_number already exists for this client',
        p_settings_resolution_id := NULL
      );
    ELSIF v_operation = 'reused_client_reference' THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'shipment_create',
        p_resource_type := 'shipment',
        p_resource_id := v_row_id,
        p_decision_point := 'client_reference_unique',
        p_decision_outcome := 'reused_existing_shipment',
        p_performed_by_system := 'workflow_handlers.execute_shipment_create_v1',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'planned_shipment_id', v_planned_id,
          'planned_tracking_number', v_planned_tracking,
          'client_reference_number', NULLIF(btrim(v_client_reference), ''),
          'existing_tracking_number', v_tracking_number
        )),
        p_decision_reason := 'client_reference_number already exists for this client',
        p_settings_resolution_id := NULL
      );
    END IF;

    UPDATE public.shipments
    SET client_reference_number = COALESCE(NULLIF(btrim(public.shipments.client_reference_number), ''), NULLIF(btrim(v_client_reference), ''), public.shipments.client_reference_number),
        carrier_reference_number = COALESCE(NULLIF(btrim(public.shipments.carrier_reference_number), ''), NULLIF(btrim(v_carrier_reference), ''), public.shipments.carrier_reference_number),
        updated_at = now()
    WHERE id = v_row_id
      AND client_id = v_client
      AND (
        ((public.shipments.client_reference_number IS NULL OR btrim(public.shipments.client_reference_number) = '') AND NULLIF(btrim(v_client_reference), '') IS NOT NULL)
        OR ((public.shipments.carrier_reference_number IS NULL OR btrim(public.shipments.carrier_reference_number) = '') AND NULLIF(btrim(v_carrier_reference), '') IS NOT NULL)
      );

    IF v_row_id IS NOT NULL AND v_refs IS NOT NULL AND v_refs <> '{}'::jsonb THEN
      v_ref_meta := jsonb_strip_nulls(jsonb_build_object(
        'source', 'workflow',
        'workflow_run_id', p_run.id,
        'workflow_run_step_id', p_step.id,
        'webhook_id', v_metadata_source
      ));

      PERFORM public.upsert_shipment_reference_numbers_v1(
        p_organization_id := v_org,
        p_client_id := v_client,
        p_shipment_id := v_row_id,
        p_reference_map := v_refs,
        p_source_type := 'workflow',
        p_source_id := NULL,
        p_metadata := v_ref_meta
      );
    END IF;

    v_result.status := 'completed';
    v_result.workflow_status := CASE
      WHEN v_operation IN ('reused', 'reused_client_reference')
           AND v_planned_id IS NOT NULL
           AND v_row_id <> v_planned_id THEN 'completed'
      ELSE NULL
    END;
    v_result.next_run_at := NULL;
    v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_row_id,
        'tracking_number', v_tracking_number,
        'operation', v_operation
    ));
    v_result.context_patch := jsonb_build_object(
        'shipment', jsonb_strip_nulls(jsonb_build_object(
            'id', v_row_id,
            'tracking_number', v_tracking_number,
            'client_reference_number', NULLIF(btrim(v_client_reference), '')
        ))
    );
    v_result.last_error := NULL;
    v_result.retry_attempt := 1;
    v_result.max_retries := 1;

    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.process_api_gateway_shipment_create_v1(
  p_job public.outbound_calls,
  p_response JSONB DEFAULT '{}'::jsonb,
  p_request public.api_gateway_requests DEFAULT NULL,
  p_route public.api_routes DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_result JSONB := jsonb_build_object('handled', FALSE, 'handler', 'api_gateway');
  v_request public.api_gateway_requests := p_request;
  v_route public.api_routes := p_route;
  v_policy JSONB;
  v_post JSONB;
  v_extract JSONB;
  v_mode TEXT;

  v_request_id UUID;
  v_org UUID;
  v_client UUID;
  v_sender UUID;
  v_source UUID;
  v_corr UUID;
  v_request_body JSONB;

  v_recipient_name TEXT;
  v_recipient_phone TEXT;
  v_client_reference TEXT;
  v_recipient_id UUID;

  v_origin JSONB;
  v_destination JSONB;
  v_origin_address_id UUID;
  v_destination_address_id UUID;

  v_provider_id UUID;
  v_provider_name TEXT;
  v_provider_shipment_id TEXT;
  v_provider_reference_id TEXT;
  v_tracking_number TEXT;
  v_carrier_reference TEXT;

  v_provider_service_type_raw TEXT;
  v_provider_service_type_norm TEXT;
  v_service_type_mapping_id UUID;
  v_provider_service_level_raw TEXT;
  v_provider_service_level_norm TEXT;
  v_service_level_mapping_id UUID;

  v_service_type TEXT;
  v_service_level TEXT;
  v_shipment_status TEXT;
  v_promised_delivery_date DATE;
  v_special_instructions TEXT;
  v_cod_amount NUMERIC;
  v_box_count INT;

  v_shipment_id UUID;
  v_operation TEXT := 'inserted';

  v_shipment_metadata JSONB;
  v_ref_meta JSONB;
  v_refs JSONB := '{}'::jsonb;

  v_label_enabled BOOLEAN;
  v_label_type TEXT;
  v_label_job_id UUID;

  v_geocode_enabled BOOLEAN;
  v_geocode_template_name TEXT;
  v_geocode_template_id UUID;
  v_geocode_run_id UUID;
BEGIN
  BEGIN
    v_request_id := COALESCE(
      p_request.id,
      NULLIF(p_job.context->>'api_gateway_request_id', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_request_id := p_request.id;
  END;

  IF v_request.id IS NULL AND v_request_id IS NOT NULL THEN
    SELECT *
      INTO v_request
      FROM public.api_gateway_requests
     WHERE id = v_request_id;
  END IF;

  IF v_request.id IS NULL THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'request_not_found');
  END IF;

  IF v_route.id IS NULL THEN
    SELECT *
      INTO v_route
      FROM public.api_routes
     WHERE id = v_request.route_id;
  END IF;

  IF v_route.id IS NULL THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'route_not_found');
  END IF;

  v_policy := COALESCE(v_route.policy, '{}'::jsonb);
  v_post := COALESCE(v_policy->'postprocess', '{}'::jsonb);

  IF COALESCE((v_post->>'enabled')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'postprocess_disabled');
  END IF;

  v_mode := COALESCE(NULLIF(v_post->>'mode', ''), '');
  IF v_mode <> 'shipment_create_v1' THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'postprocess_mode_mismatch', 'mode', v_mode);
  END IF;

  v_org := v_request.organization_id;
  v_client := v_request.client_id;
  v_sender := v_request.sender_id;
  v_source := v_request.source_id;
  v_corr := COALESCE(p_job.correlation_id, v_request.correlation_id);
  v_provider_id := p_job.target_id;
  v_request_body := COALESCE(p_job.body, v_request.request_body, '{}'::jsonb);
  v_extract := COALESCE(v_post->'extract', '{}'::jsonb);

  SELECT name INTO v_provider_name
  FROM public.providers
  WHERE id = v_provider_id;

  v_recipient_name := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'recipient_name_path');
  v_recipient_phone := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'recipient_phone_path');
  v_client_reference := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'client_reference_path');

  v_provider_shipment_id := workflow_handlers.resolve_path_text(p_response, v_extract->>'provider_shipment_id_path');
  v_provider_reference_id := workflow_handlers.resolve_path_text(p_response, v_extract->>'provider_reference_id_path');
  v_tracking_number := workflow_handlers.resolve_path_text(p_response, v_extract->>'provider_tracking_number_path');

  IF v_tracking_number IS NULL OR btrim(v_tracking_number) = '' THEN
    v_tracking_number := v_provider_shipment_id;
  END IF;

  v_carrier_reference := COALESCE(NULLIF(v_provider_reference_id, ''), NULLIF(v_provider_shipment_id, ''));

  v_shipment_status := COALESCE(NULLIF(v_post->>'shipment_status', ''), 'pending');
  v_service_type := COALESCE(NULLIF(v_post->>'service_type', ''), 'delivery');

  v_provider_service_type_raw := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'service_type_path');
  SELECT provider_value_normalized, canonical_value, mapping_id
    INTO v_provider_service_type_norm, v_service_type, v_service_type_mapping_id
    FROM public.resolve_field_mapping_enum_v1(
      'service_type',
      v_provider_name,
      'inbound',
      v_provider_service_type_raw
    );

  IF v_provider_service_type_norm IS NOT NULL AND v_provider_name IS NOT NULL THEN
    IF v_service_type IS NOT NULL
       AND public.is_active_lookup_value_v1('service_type', v_service_type, TRUE) IS FALSE THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'transformation',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request.id,
        p_decision_point := 'service_type_mapping',
        p_decision_outcome := 'unmapped',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_create_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_name', v_provider_name,
          'provider_service_type', v_provider_service_type_raw,
          'provider_service_type_normalized', v_provider_service_type_norm,
          'mapping_id', v_service_type_mapping_id,
          'canonical_service_type_candidate', v_service_type,
          'mapping_issue', 'invalid_canonical_lookup_value'
        ))
      );
      v_service_type := COALESCE(NULLIF(v_post->>'service_type', ''), 'delivery');
    ELSIF v_service_type IS NULL THEN
      v_service_type := COALESCE(NULLIF(v_post->>'service_type', ''), 'delivery');
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'transformation',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request.id,
        p_decision_point := 'service_type_mapping',
        p_decision_outcome := 'unmapped',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_create_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_name', v_provider_name,
          'provider_service_type', v_provider_service_type_raw,
          'provider_service_type_normalized', v_provider_service_type_norm
        ))
      );
    ELSE
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'transformation',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request.id,
        p_decision_point := 'service_type_mapping',
        p_decision_outcome := 'mapped',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_create_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_name', v_provider_name,
          'provider_service_type', v_provider_service_type_raw,
          'provider_service_type_normalized', v_provider_service_type_norm,
          'mapping_id', v_service_type_mapping_id,
          'canonical_service_type', v_service_type
        ))
      );
    END IF;
  END IF;

  v_provider_service_level_raw := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'service_level_path');
  SELECT provider_value_normalized, canonical_value, mapping_id
    INTO v_provider_service_level_norm, v_service_level, v_service_level_mapping_id
    FROM public.resolve_field_mapping_enum_v1(
      'service_level',
      v_provider_name,
      'inbound',
      v_provider_service_level_raw
    );

  IF v_provider_service_level_norm IS NOT NULL AND v_provider_name IS NOT NULL THEN
    IF v_service_level IS NOT NULL
       AND public.is_active_lookup_value_v1('service_level', v_service_level, TRUE) IS FALSE THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'transformation',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request.id,
        p_decision_point := 'service_level_mapping',
        p_decision_outcome := 'unmapped',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_create_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_name', v_provider_name,
          'provider_service_level', v_provider_service_level_raw,
          'provider_service_level_normalized', v_provider_service_level_norm,
          'mapping_id', v_service_level_mapping_id,
          'canonical_service_level_candidate', v_service_level,
          'mapping_issue', 'invalid_canonical_lookup_value'
        ))
      );
      v_service_level := NULL;
    ELSIF v_service_level IS NULL THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'transformation',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request.id,
        p_decision_point := 'service_level_mapping',
        p_decision_outcome := 'unmapped',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_create_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_name', v_provider_name,
          'provider_service_level', v_provider_service_level_raw,
          'provider_service_level_normalized', v_provider_service_level_norm
        ))
      );
    ELSE
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'transformation',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request.id,
        p_decision_point := 'service_level_mapping',
        p_decision_outcome := 'mapped',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_create_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_name', v_provider_name,
          'provider_service_level', v_provider_service_level_raw,
          'provider_service_level_normalized', v_provider_service_level_norm,
          'mapping_id', v_service_level_mapping_id,
          'canonical_service_level', v_service_level
        ))
      );
    END IF;
  END IF;

  v_special_instructions := NULLIF(workflow_handlers.resolve_path_text(v_request_body, v_extract->>'special_instructions_path'), '');

  BEGIN
    v_box_count := NULLIF(workflow_handlers.resolve_path_text(v_request_body, v_extract->>'box_count_path'), '')::INT;
  EXCEPTION
    WHEN others THEN
      v_box_count := NULL;
  END;
  IF v_box_count IS NULL OR v_box_count <= 0 THEN
    v_box_count := 1;
  END IF;

  BEGIN
    v_cod_amount := NULLIF(workflow_handlers.resolve_path_text(v_request_body, v_extract->>'cod_amount_path'), '')::NUMERIC;
  EXCEPTION
    WHEN others THEN
      v_cod_amount := NULL;
  END;

  BEGIN
    v_promised_delivery_date := (workflow_handlers.resolve_path_text(p_response, v_extract->>'promised_delivery_date_path'))::timestamptz::date;
  EXCEPTION
    WHEN others THEN
      BEGIN
        v_promised_delivery_date := (workflow_handlers.resolve_path_text(p_response, v_extract->>'promised_delivery_date_path'))::date;
      EXCEPTION
        WHEN others THEN
          v_promised_delivery_date := NULL;
      END;
  END;

  IF v_org IS NULL OR v_client IS NULL OR v_tracking_number IS NULL OR btrim(v_tracking_number) = '' THEN
    RETURN v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_build_object('status', 'skipped', 'reason', 'missing_scope_or_tracking')
    );
  END IF;

  IF v_recipient_phone IS NOT NULL AND btrim(v_recipient_phone) <> '' THEN
    SELECT id INTO v_recipient_id
    FROM public.recipients
    WHERE client_id = v_client
      AND phone_number = v_recipient_phone
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF v_recipient_id IS NULL THEN
    INSERT INTO public.recipients (
      organization_id,
      client_id,
      name,
      phone_number,
      preferred_language,
      created_at,
      updated_at
    ) VALUES (
      v_org,
      v_client,
      COALESCE(NULLIF(v_recipient_name, ''), 'Unknown'),
      COALESCE(NULLIF(v_recipient_phone, ''), 'unknown'),
      'en',
      now(),
      now()
    )
    RETURNING id INTO v_recipient_id;
  ELSE
    UPDATE public.recipients
    SET name = COALESCE(NULLIF(v_recipient_name, ''), name),
        updated_at = now()
    WHERE id = v_recipient_id;
  END IF;

  IF jsonb_typeof(p_job.context->'api_gateway_materialized') = 'object' THEN
    BEGIN
      v_origin_address_id := NULLIF(p_job.context #>> '{api_gateway_materialized,origin_address_id}', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_origin_address_id := NULL;
    END;

    BEGIN
      v_destination_address_id := NULLIF(p_job.context #>> '{api_gateway_materialized,destination_address_id}', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_destination_address_id := NULL;
    END;

    v_origin := jsonb_strip_nulls(jsonb_build_object(
      'address_id', v_origin_address_id
    ));
    v_destination := jsonb_strip_nulls(jsonb_build_object(
      'address_id', v_destination_address_id,
      'provided_coordinates', p_job.context #> '{api_gateway_materialized,destination_provided_coordinates}'
    ));
  END IF;

  IF v_destination_address_id IS NULL THEN
    v_origin := workflow_handlers.api_gateway_materialize_address_v1(v_org, v_client, v_request_body, v_extract, 'origin');
    v_destination := workflow_handlers.api_gateway_materialize_address_v1(v_org, v_client, v_request_body, v_extract, 'destination');

    BEGIN
      v_origin_address_id := NULLIF(v_origin->>'address_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_origin_address_id := NULL;
    END;
    BEGIN
      v_destination_address_id := NULLIF(v_destination->>'address_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_destination_address_id := NULL;
    END;
  END IF;

  v_shipment_metadata := jsonb_strip_nulls(jsonb_build_object(
    'source', jsonb_strip_nulls(jsonb_build_object(
      'type', 'api_gateway',
      'api_gateway_request_id', v_request.id,
      'route_id', v_route.id
    )),
    'provider', jsonb_strip_nulls(jsonb_build_object(
      'id', v_provider_id,
      'name', v_provider_name,
      'shipment_id', v_provider_shipment_id,
      'reference_id', v_provider_reference_id
    ))
  ));

  SELECT resolved.shipment_id, resolved.operation
    INTO v_shipment_id, v_operation
    FROM public.resolve_shipment_create_duplicate_v1(
      v_client,
      v_tracking_number,
      v_client_reference
    ) AS resolved
   LIMIT 1;

  IF v_shipment_id IS NULL THEN
    BEGIN
      INSERT INTO public.shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        service_type,
        tracking_number,
        carrier_reference_number,
        client_reference_number,
        box_count,
        promised_delivery_date,
        service_level,
        special_instructions,
        cod_amount,
        recipient_id,
        destination_address_id,
        origin_address_id,
        status,
        status_updated_at,
        metadata,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        v_org,
        v_client,
        v_sender,
        v_service_type,
        v_tracking_number,
        NULLIF(btrim(v_carrier_reference), ''),
        NULLIF(btrim(v_client_reference), ''),
        v_box_count,
        v_promised_delivery_date,
        NULLIF(btrim(v_service_level), ''),
        NULLIF(btrim(v_special_instructions), ''),
        v_cod_amount,
        v_recipient_id,
        v_destination_address_id,
        v_origin_address_id,
        v_shipment_status,
        now(),
        v_shipment_metadata,
        now(),
        now()
      )
      RETURNING id INTO v_shipment_id;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT resolved.shipment_id, resolved.operation
          INTO v_shipment_id, v_operation
          FROM public.resolve_shipment_create_duplicate_v1(
            v_client,
            v_tracking_number,
            v_client_reference
          ) AS resolved
         LIMIT 1;

        IF v_shipment_id IS NULL THEN
          RAISE;
        END IF;
    END;
  END IF;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'api_gateway shipment_create: failed to resolve shipment materialization';
  END IF;

  IF v_operation = 'reused' THEN
    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'shipment_create',
      p_resource_type := 'shipment',
      p_resource_id := v_shipment_id,
      p_decision_point := 'tracking_unique',
      p_decision_outcome := 'reused_existing_shipment',
      p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_create_v1',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'api_gateway_request_id', v_request.id,
        'route_id', v_route.id,
        'provider_id', v_provider_id,
        'provider_shipment_id', NULLIF(btrim(v_provider_shipment_id), ''),
        'provider_reference_id', NULLIF(btrim(v_provider_reference_id), ''),
        'provider_tracking_number', NULLIF(btrim(v_tracking_number), ''),
        'client_reference_number', NULLIF(btrim(v_client_reference), '')
      )),
      p_decision_reason := 'tracking_number already exists for this client',
      p_settings_resolution_id := NULL
    );
  ELSIF v_operation = 'reused_client_reference' THEN
    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'shipment_create',
      p_resource_type := 'shipment',
      p_resource_id := v_shipment_id,
      p_decision_point := 'client_reference_unique',
      p_decision_outcome := 'reused_existing_shipment',
      p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_create_v1',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'api_gateway_request_id', v_request.id,
        'route_id', v_route.id,
        'provider_id', v_provider_id,
        'provider_shipment_id', NULLIF(btrim(v_provider_shipment_id), ''),
        'provider_reference_id', NULLIF(btrim(v_provider_reference_id), ''),
        'provider_tracking_number', NULLIF(btrim(v_tracking_number), ''),
        'client_reference_number', NULLIF(btrim(v_client_reference), '')
      )),
      p_decision_reason := 'client_reference_number already exists for this client',
      p_settings_resolution_id := NULL
    );
  END IF;

  IF v_operation IN ('reused', 'reused_client_reference') THEN
    UPDATE public.shipments
    SET carrier_reference_number = COALESCE(public.shipments.carrier_reference_number, NULLIF(btrim(v_carrier_reference), '')),
        client_reference_number = COALESCE(public.shipments.client_reference_number, NULLIF(btrim(v_client_reference), '')),
        recipient_id = COALESCE(public.shipments.recipient_id, v_recipient_id),
        destination_address_id = COALESCE(public.shipments.destination_address_id, v_destination_address_id),
        origin_address_id = COALESCE(public.shipments.origin_address_id, v_origin_address_id),
        sender_id = COALESCE(public.shipments.sender_id, v_sender),
        status = COALESCE(NULLIF(public.shipments.status, ''), v_shipment_status),
        status_updated_at = now(),
        promised_delivery_date = COALESCE(public.shipments.promised_delivery_date, v_promised_delivery_date),
        service_level = COALESCE(NULLIF(public.shipments.service_level, ''), NULLIF(btrim(v_service_level), '')),
        special_instructions = COALESCE(NULLIF(public.shipments.special_instructions, ''), NULLIF(btrim(v_special_instructions), '')),
        cod_amount = COALESCE(public.shipments.cod_amount, v_cod_amount),
        box_count = CASE
          WHEN public.shipments.box_count IS NULL OR public.shipments.box_count <= 1 THEN GREATEST(COALESCE(v_box_count, 1), 1)
          ELSE public.shipments.box_count
        END,
        service_type = CASE
          WHEN public.shipments.service_type = 'delivery' AND v_service_type IS NOT NULL AND v_service_type <> 'delivery' THEN v_service_type
          ELSE public.shipments.service_type
        END,
        metadata = COALESCE(public.shipments.metadata, '{}'::jsonb) || COALESCE(v_shipment_metadata, '{}'::jsonb),
        updated_at = now()
    WHERE id = v_shipment_id
      AND client_id = v_client;
  END IF;

  v_ref_meta := jsonb_strip_nulls(jsonb_build_object(
    'source', 'api_gateway',
    'api_gateway_request_id', v_request.id,
    'route_id', v_route.id,
    'provider_id', v_provider_id,
    'provider_shipment_id', NULLIF(btrim(v_provider_shipment_id), ''),
    'provider_reference_id', NULLIF(btrim(v_provider_reference_id), ''),
    'provider_tracking_number', NULLIF(btrim(v_tracking_number), '')
  ));

  v_refs := jsonb_strip_nulls(jsonb_build_object(
    'client_reference_number', NULLIF(btrim(v_client_reference), ''),
    'carrier_reference_number', NULLIF(btrim(v_carrier_reference), ''),
    'logistics_reference_number', jsonb_build_array(
      NULLIF(btrim(v_tracking_number), ''),
      NULLIF(btrim(v_provider_shipment_id), ''),
      NULLIF(btrim(v_provider_reference_id), '')
    )
  ));

  PERFORM public.upsert_shipment_reference_numbers_v1(
    p_organization_id := v_org,
    p_client_id := v_client,
    p_shipment_id := v_shipment_id,
    p_reference_map := v_refs,
    p_source_type := 'provider',
    p_source_id := v_provider_id,
    p_metadata := v_ref_meta
  );

  IF v_operation = 'inserted' THEN
    v_geocode_enabled := COALESCE((v_post->'geocoding'->>'enabled')::BOOLEAN, FALSE);
    v_geocode_template_name := NULLIF(v_post->'geocoding'->>'workflow_template_name', '');
    IF v_geocode_enabled AND v_geocode_template_name IS NOT NULL THEN
      SELECT id INTO v_geocode_template_id
      FROM public.workflow_templates
      WHERE name = v_geocode_template_name
        AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1;

      IF v_geocode_template_id IS NOT NULL AND v_destination_address_id IS NOT NULL THEN
        v_geocode_run_id := public.start_workflow_run(
          v_geocode_template_id,
          jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org,
            'client_id', v_client,
            'sender_id', v_sender,
            'address_id', v_destination_address_id,
            'api_gateway_request_id', v_request.id,
            'shipment_id', v_shipment_id,
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
              'provided_coordinates', v_destination->'provided_coordinates'
            ))
          ))
        );
      END IF;

      IF v_geocode_template_id IS NOT NULL AND v_origin_address_id IS NOT NULL THEN
        PERFORM public.start_workflow_run(
          v_geocode_template_id,
          jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org,
            'client_id', v_client,
            'sender_id', v_sender,
            'address_id', v_origin_address_id,
            'api_gateway_request_id', v_request.id,
            'shipment_id', v_shipment_id,
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
              'provided_coordinates', v_origin->'provided_coordinates'
            ))
          ))
        );
      END IF;
    END IF;

    v_label_enabled := COALESCE((v_post->'label'->>'enabled')::BOOLEAN, FALSE);
    v_label_type := COALESCE(NULLIF(v_post->'label'->>'label_type', ''), 'shipping');
    IF v_label_enabled AND v_shipment_id IS NOT NULL THEN
      v_label_job_id := public.request_label_generation(
        v_shipment_id,
        v_label_type,
        NULL,
        'api_gateway',
        NULL,
        'primary'
      );
    END IF;
  END IF;

  RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
    'handled', TRUE,
    'postprocess', jsonb_strip_nulls(jsonb_build_object(
      'mode', v_mode,
      'operation', v_operation,
      'shipment_id', v_shipment_id,
      'recipient_id', v_recipient_id,
      'origin_address_id', v_origin_address_id,
      'destination_address_id', v_destination_address_id,
      'geocoding_workflow_run_id', v_geocode_run_id,
      'label_job_id', v_label_job_id
    ))
  ));
END;
$$;

DO $$
DECLARE
  v_def TEXT;
  v_start_marker TEXT := E'\n  ---------------------------------------------------------------------------\n  -- Mode: shipment_create_v1\n  ---------------------------------------------------------------------------';
  v_end_marker TEXT := E'\n  ---------------------------------------------------------------------------\n  -- Mode: shipment_cancel_v1\n  ---------------------------------------------------------------------------';
  v_start_pos INT;
  v_end_pos INT;
  v_replacement TEXT := E'\n  ---------------------------------------------------------------------------\n  -- Mode: shipment_create_v1\n  ---------------------------------------------------------------------------\n  IF v_mode = ''shipment_create_v1'' THEN\n    RETURN workflow_handlers.process_api_gateway_shipment_create_v1(\n      p_job,\n      COALESCE(p_response, ''{}''::jsonb),\n      v_request,\n      v_route\n    );\n  END IF;\n';
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_outbound_response_v1(public.outbound_calls, jsonb)'::regprocedure
  ) INTO v_def;

  IF v_def IS NULL OR v_def = '' THEN
    RAISE EXCEPTION 'process_api_gateway_outbound_response_v1 function definition not found';
  END IF;

  v_start_pos := strpos(v_def, v_start_marker);
  v_end_pos := strpos(v_def, v_end_marker);

  IF v_start_pos = 0 OR v_end_pos = 0 OR v_end_pos <= v_start_pos THEN
    RAISE EXCEPTION 'Failed to locate shipment_create block in process_api_gateway_outbound_response_v1';
  END IF;

  v_def := substring(v_def FROM 1 FOR v_start_pos - 1)
        || v_replacement
        || substring(v_def FROM v_end_pos);

  EXECUTE v_def;
END;
$$;

COMMIT;
