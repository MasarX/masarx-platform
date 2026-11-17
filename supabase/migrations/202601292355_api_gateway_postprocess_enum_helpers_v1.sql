-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: API gateway postprocess uses enum mapping helpers v1
-- Date: 2026-01-29
-- Purpose:
--   - Preserve existing postprocess behavior (including reuse of workflow-materialized address IDs).
--   - Eliminate duplicated provider enum normalization logic by using shared helpers.
--   - Validate mapped canonical values against lookup taxonomy (service_type/service_level).

BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.process_api_gateway_outbound_response_v1(
  p_job public.outbound_calls,
  p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_result JSONB := jsonb_build_object('handled', FALSE, 'handler', 'api_gateway');

  v_request_id UUID;
  v_request public.api_gateway_requests%ROWTYPE;
  v_route public.api_routes%ROWTYPE;
  v_policy JSONB;
  v_post JSONB;
  v_mode TEXT;
  v_extract JSONB;

  v_org UUID;
  v_client UUID;
  v_sender UUID;
  v_source UUID;
  v_corr UUID;
  v_request_body JSONB;
  v_path_params JSONB;

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
  v_operation TEXT := 'upserted';

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

  -- Cancel: client webhook forwarding (ladder-resolved)
  v_policy_row RECORD;
  v_client_webhook_policy JSONB;
  v_settings_resolution_id UUID;
  v_forward_allowed BOOLEAN;
  v_forward_reason TEXT;
  v_filter_mode TEXT;
  v_filter_statuses JSONB;
  v_filter_has BOOLEAN;
  v_url TEXT;
  v_headers JSONB;
  v_method TEXT;
  v_auth JSONB;
  v_payload_mapping_id UUID;
  v_payload JSONB;
  v_outbound_id UUID;
  v_ship_id_param TEXT;
  v_cancel_key TEXT;
  v_current_status TEXT;
BEGIN
  BEGIN
    v_request_id := NULLIF(p_job.context->>'api_gateway_request_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_request_id := NULL;
  END;

  IF v_request_id IS NULL THEN
    RETURN v_result;
  END IF;

  SELECT * INTO v_request
  FROM public.api_gateway_requests
  WHERE id = v_request_id;

  IF NOT FOUND THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'request_not_found');
  END IF;

  SELECT * INTO v_route
  FROM public.api_routes
  WHERE id = v_request.route_id;

  IF NOT FOUND THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'route_not_found');
  END IF;

  v_policy := COALESCE(v_route.policy, '{}'::jsonb);
  v_post := COALESCE(v_policy->'postprocess', '{}'::jsonb);

  IF COALESCE((v_post->>'enabled')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'postprocess_disabled');
  END IF;

  v_mode := COALESCE(NULLIF(v_post->>'mode', ''), '');

  v_org := v_request.organization_id;
  v_client := v_request.client_id;
  v_sender := v_request.sender_id;
  v_source := v_request.source_id;
  v_corr := COALESCE(p_job.correlation_id, v_request.correlation_id);
  v_provider_id := p_job.target_id;
  v_request_body := COALESCE(p_job.body, v_request.request_body, '{}'::jsonb);
  v_extract := COALESCE(v_post->'extract', '{}'::jsonb);
  v_path_params := COALESCE(p_job.context->'api_gateway_path_params', '{}'::jsonb);

  SELECT name INTO v_provider_name
  FROM public.providers
  WHERE id = v_provider_id;

  ---------------------------------------------------------------------------
  -- Mode: shipment_create_v1
  ---------------------------------------------------------------------------
  IF v_mode = 'shipment_create_v1' THEN
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

    -- Map provider shipmentType -> canonical service_type via SSOT field_mappings + helpers.
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
        -- Misconfigured mapping: canonical value must be in the lookup taxonomy.
        PERFORM public.log_decision(
          p_organization_id := v_org,
          p_decision_category := 'transformation',
          p_resource_type := 'api_gateway_request',
          p_resource_id := v_request_id,
          p_decision_point := 'service_type_mapping',
          p_decision_outcome := 'unmapped',
          p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
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
          p_resource_id := v_request_id,
          p_decision_point := 'service_type_mapping',
          p_decision_outcome := 'unmapped',
          p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
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
          p_resource_id := v_request_id,
          p_decision_point := 'service_type_mapping',
          p_decision_outcome := 'mapped',
          p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
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

    -- Map provider serviceType -> canonical service_level via SSOT field_mappings + helpers.
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
          p_resource_id := v_request_id,
          p_decision_point := 'service_level_mapping',
          p_decision_outcome := 'unmapped',
          p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
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
          p_resource_id := v_request_id,
          p_decision_point := 'service_level_mapping',
          p_decision_outcome := 'unmapped',
          p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
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
          p_resource_id := v_request_id,
          p_decision_point := 'service_level_mapping',
          p_decision_outcome := 'mapped',
          p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
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

    -- Upsert recipient by (client_id, phone_number) best-effort.
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

    -- Reuse pre-materialized address IDs (when the upstream call was dispatched via workflow gating).
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

    -- Fallback: legacy path materializes addresses from request payload.
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
        'api_gateway_request_id', v_request_id,
        'route_id', v_route.id
      )),
      'provider', jsonb_strip_nulls(jsonb_build_object(
        'id', v_provider_id,
        'name', v_provider_name,
        'shipment_id', v_provider_shipment_id,
        'reference_id', v_provider_reference_id
      ))
    ));

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
      ON CONFLICT (client_id, tracking_upper) WHERE tracking_number IS NOT NULL DO UPDATE
      SET carrier_reference_number = COALESCE(EXCLUDED.carrier_reference_number, public.shipments.carrier_reference_number),
          client_reference_number = COALESCE(EXCLUDED.client_reference_number, public.shipments.client_reference_number),
          recipient_id = COALESCE(EXCLUDED.recipient_id, public.shipments.recipient_id),
          destination_address_id = COALESCE(EXCLUDED.destination_address_id, public.shipments.destination_address_id),
          origin_address_id = COALESCE(EXCLUDED.origin_address_id, public.shipments.origin_address_id),
          sender_id = COALESCE(EXCLUDED.sender_id, public.shipments.sender_id),
          status = COALESCE(NULLIF(public.shipments.status, ''), EXCLUDED.status),
          status_updated_at = now(),
          promised_delivery_date = COALESCE(public.shipments.promised_delivery_date, EXCLUDED.promised_delivery_date),
          service_level = COALESCE(NULLIF(public.shipments.service_level, ''), EXCLUDED.service_level),
          special_instructions = COALESCE(NULLIF(public.shipments.special_instructions, ''), EXCLUDED.special_instructions),
          cod_amount = COALESCE(public.shipments.cod_amount, EXCLUDED.cod_amount),
          box_count = CASE
            WHEN public.shipments.box_count IS NULL OR public.shipments.box_count <= 1 THEN GREATEST(COALESCE(EXCLUDED.box_count, 1), 1)
            ELSE public.shipments.box_count
          END,
          service_type = CASE
            WHEN public.shipments.service_type = 'delivery' AND EXCLUDED.service_type IS NOT NULL AND EXCLUDED.service_type <> 'delivery' THEN EXCLUDED.service_type
            ELSE public.shipments.service_type
          END,
          metadata = COALESCE(public.shipments.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
          updated_at = now()
      RETURNING id INTO v_shipment_id;
    EXCEPTION
      WHEN unique_violation THEN
        -- Likely conflict on (client_id, client_reference_upper): reuse existing shipment.
        IF NULLIF(btrim(v_client_reference), '') IS NULL THEN
          RAISE;
        END IF;

        SELECT shipment_id INTO v_shipment_id
        FROM public.find_shipment_by_client_reference_v1(v_client, v_client_reference)
        LIMIT 1;

        IF v_shipment_id IS NULL THEN
          RAISE;
        END IF;

        v_operation := 'reused_client_reference';

        PERFORM public.log_decision(
          p_organization_id := v_org,
          p_decision_category := 'shipment_create',
          p_resource_type := 'shipment',
          p_resource_id := v_shipment_id,
          p_decision_point := 'client_reference_unique',
          p_decision_outcome := 'reused_existing_shipment',
          p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
          p_correlation_id := v_corr,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'api_gateway_request_id', v_request_id,
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

        -- Best-effort: apply missing fields without overwriting tracking_number.
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
    END;

    -- Canonical references (SSOT): store client + carrier refs and all logistics identifiers.
    v_ref_meta := jsonb_strip_nulls(jsonb_build_object(
      'source', 'api_gateway',
      'api_gateway_request_id', v_request_id,
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

    -- Optional: start geocoding workflows for the destination (and origin if present) based on policy.
    IF v_operation <> 'reused_client_reference' THEN
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
              'api_gateway_request_id', v_request_id,
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
              'api_gateway_request_id', v_request_id,
              'shipment_id', v_shipment_id,
              'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'provided_coordinates', v_origin->'provided_coordinates'
              ))
            ))
          );
        END IF;
      END IF;

      -- Optional: enqueue label generation.
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
        'shipment_id', v_shipment_id,
        'recipient_id', v_recipient_id,
        'origin_address_id', v_origin_address_id,
        'destination_address_id', v_destination_address_id,
        'geocoding_workflow_run_id', v_geocode_run_id,
        'label_job_id', v_label_job_id
      ))
    ));
  END IF;

  ---------------------------------------------------------------------------
  -- Mode: shipment_cancel_v1
  ---------------------------------------------------------------------------
  IF v_mode = 'shipment_cancel_v1' THEN
    v_shipment_status := COALESCE(NULLIF(v_post->>'shipment_status', ''), 'cancelled');
    v_ship_id_param := COALESCE(NULLIF(v_post->>'shipment_id_param', ''), 'shipmentId');
    v_cancel_key := NULLIF(btrim(v_path_params->>v_ship_id_param), '');

    IF v_org IS NULL OR v_client IS NULL OR v_cancel_key IS NULL THEN
      RETURN v_result || jsonb_build_object(
        'handled', TRUE,
        'postprocess', jsonb_build_object('mode', v_mode, 'status', 'skipped', 'reason', 'missing_scope_or_shipment_id')
      );
    END IF;

    -- Only apply internal cancellation when the upstream provider call succeeded.
    IF p_job.status IS DISTINCT FROM 'completed'
       OR p_job.response_status_code IS NULL
       OR p_job.response_status_code < 200
       OR p_job.response_status_code > 299 THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'api_gateway_postprocess',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request_id,
        p_decision_point := 'shipment_cancel_upstream',
        p_decision_outcome := 'skipped',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'shipment_id_value', v_cancel_key,
          'upstream_job_status', p_job.status,
          'upstream_response_status_code', p_job.response_status_code
        ))
      );

      RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
        'handled', TRUE,
        'postprocess', jsonb_strip_nulls(jsonb_build_object(
          'mode', v_mode,
          'status', 'skipped',
          'reason', 'upstream_not_successful',
          'upstream_job_status', p_job.status,
          'upstream_response_status_code', p_job.response_status_code
        ))
      ));
    END IF;

    -- Lookup shipment by (1) tracking_number (barcode) or (2) SSOT logistics_reference_number.
    SELECT id INTO v_shipment_id
    FROM public.shipments
    WHERE client_id = v_client
      AND tracking_upper = upper(v_cancel_key)
    LIMIT 1;

    IF v_shipment_id IS NULL THEN
      SELECT shipment_id INTO v_shipment_id
      FROM public.shipment_reference_numbers
      WHERE client_id = v_client
        AND reference_type = 'logistics_reference_number'
        AND reference_value_upper = upper(v_cancel_key)
      ORDER BY updated_at DESC
      LIMIT 1;
    END IF;

    IF v_shipment_id IS NULL THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'api_gateway_postprocess',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request_id,
        p_decision_point := 'shipment_cancel_lookup',
        p_decision_outcome := 'shipment_not_found',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'client_id', v_client,
          'shipment_id_value', v_cancel_key
        ))
      );

      RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
        'handled', TRUE,
        'postprocess', jsonb_build_object('mode', v_mode, 'status', 'skipped', 'reason', 'shipment_not_found')
      ));
    END IF;

    SELECT status
      INTO v_current_status
      FROM public.shipments
     WHERE id = v_shipment_id
       AND client_id = v_client
     LIMIT 1;

    IF v_current_status IS NOT DISTINCT FROM v_shipment_status THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'api_gateway_postprocess',
        p_resource_type := 'shipment',
        p_resource_id := v_shipment_id,
        p_decision_point := 'shipment_cancel_update',
        p_decision_outcome := 'noop',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'canonical_status', v_shipment_status,
          'shipment_id_value', v_cancel_key
        )),
        p_decision_reason := 'already_in_target_status'
      );

      RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
        'handled', TRUE,
        'postprocess', jsonb_strip_nulls(jsonb_build_object(
          'mode', v_mode,
          'shipment_id', v_shipment_id,
          'status', 'noop',
          'reason', 'already_cancelled'
        ))
      ));
    END IF;

    UPDATE public.shipments
    SET status = v_shipment_status,
        status_updated_at = now(),
        updated_at = now(),
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
          'cancellation', jsonb_build_object(
            'source', 'api_gateway',
            'api_gateway_request_id', v_request_id,
            'route_id', v_route.id,
            'provider_id', v_provider_id,
            'provider_name', v_provider_name,
            'provider_shipment_id', v_cancel_key,
            'cancelled_at', now()
          )
        ))
    WHERE id = v_shipment_id
      AND client_id = v_client;

    INSERT INTO public.shipment_actions (
      shipment_id,
      organization_id,
      client_id,
      action_type,
      action_category,
      canonical_status,
      performed_by_system,
      action_data,
      timestamp
    ) VALUES (
      v_shipment_id,
      v_org,
      v_client,
      'status_change',
      'operational',
      v_shipment_status,
      'workflow_handlers.process_api_gateway_outbound_response_v1',
      jsonb_strip_nulls(jsonb_build_object(
        'api_gateway_request_id', v_request_id,
        'route_id', v_route.id,
        'provider_id', v_provider_id,
        'provider_name', v_provider_name,
        'provider_shipment_id', v_cancel_key,
        'path_params', v_path_params,
        'response', COALESCE(p_response, '{}'::jsonb)
      )),
      now()
    );

    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'api_gateway_postprocess',
      p_resource_type := 'shipment',
      p_resource_id := v_shipment_id,
      p_decision_point := 'shipment_cancel_update',
      p_decision_outcome := 'updated',
      p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'canonical_status', v_shipment_status,
        'shipment_id_value', v_cancel_key
      ))
    );

    -- Optional: forward to client webhook (same policy ladder + filters as webhook mirror).
    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row_from_context(
        'client_webhook_policy',
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org,
          'client_id', v_client,
          'sender_id', v_sender,
          'webhook_source_id', v_source
        ))
      )
     LIMIT 1;

    v_client_webhook_policy := COALESCE(v_policy_row.value, '{}'::jsonb);

    IF v_policy_row.settings_id IS NOT NULL THEN
      v_settings_resolution_id := public.log_settings_resolution(
        p_organization_id := v_org,
        p_category := 'client_webhook_policy',
        p_winning_scope_type := v_policy_row.scope_type,
        p_winning_scope_id := v_policy_row.scope_id,
        p_winning_settings_id := v_policy_row.settings_id,
        p_winning_settings_version_id := v_policy_row.settings_version_id,
        p_winning_version := COALESCE(v_policy_row.version, 1),
        p_scope_path := v_policy_row.scope_path,
        p_inputs := jsonb_strip_nulls(jsonb_build_object(
          'api_gateway_request_id', v_request_id,
          'shipment_id', v_shipment_id,
          'canonical_status', v_shipment_status,
          'client_id', v_client,
          'sender_id', v_sender,
          'webhook_source_id', v_source
        )),
        p_merge_notes := NULL
      );
    END IF;

    v_forward_allowed := COALESCE(NULLIF(v_client_webhook_policy->>'enabled', '')::BOOLEAN, FALSE);
    v_url := NULLIF(v_client_webhook_policy->>'url', '');
    IF v_forward_allowed AND v_url IS NULL THEN
      v_forward_allowed := FALSE;
      v_forward_reason := 'missing_url';
    END IF;

    v_filter_mode := COALESCE(NULLIF(v_client_webhook_policy#>>'{filter,mode}', ''), 'all');
    v_filter_statuses := COALESCE(v_client_webhook_policy#>'{filter,statuses}', '[]'::jsonb);

    IF v_forward_allowed THEN
      IF v_filter_mode = 'none' THEN
        v_forward_allowed := FALSE;
        v_forward_reason := 'filter_none';
      ELSIF v_filter_mode = 'allowlist' THEN
        SELECT EXISTS(
          SELECT 1
            FROM jsonb_array_elements_text(v_filter_statuses) AS s(val)
           WHERE lower(s.val) = lower(v_shipment_status)
        ) INTO v_filter_has;
        v_forward_allowed := v_filter_has;
        IF NOT v_filter_has THEN
          v_forward_reason := 'filter_allowlist_miss';
        END IF;
      ELSIF v_filter_mode = 'blocklist' THEN
        SELECT EXISTS(
          SELECT 1
            FROM jsonb_array_elements_text(v_filter_statuses) AS s(val)
           WHERE lower(s.val) = lower(v_shipment_status)
        ) INTO v_filter_has;
        v_forward_allowed := NOT v_filter_has;
        IF v_filter_has THEN
          v_forward_reason := 'filter_blocked';
        END IF;
      ELSIF v_filter_mode <> 'all' THEN
        v_forward_allowed := FALSE;
        v_forward_reason := 'filter_unknown';
      END IF;
    END IF;

    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'api_gateway_postprocess',
      p_resource_type := 'shipment',
      p_resource_id := v_shipment_id,
      p_decision_point := 'client_webhook_filter',
      p_decision_outcome := CASE WHEN v_forward_allowed THEN 'forward' ELSE 'skip' END,
      p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'canonical_status', v_shipment_status,
        'filter_mode', v_filter_mode,
        'filter_statuses', v_filter_statuses,
        'policy_enabled', COALESCE(NULLIF(v_client_webhook_policy->>'enabled', '')::BOOLEAN, FALSE),
        'url', v_url
      )),
      p_decision_reason := v_forward_reason,
      p_settings_resolution_id := v_settings_resolution_id
    );

    IF v_forward_allowed THEN
      v_payload := jsonb_strip_nulls(jsonb_build_object(
        'time', floor(extract(epoch FROM now()) * 1000)::bigint,
        'newStatus', 'CANCELLED',
        'status', 'CANCELLED',
        'barcode', v_cancel_key,
        'packageId', v_cancel_key,
        'api_gateway_request_id', v_request_id,
        'shipment_id', v_shipment_id
      ));

      v_payload_mapping_id := NULLIF(v_client_webhook_policy#>>'{payload,mapping_config_id}', '')::UUID;
      IF v_payload_mapping_id IS NOT NULL THEN
        v_payload := public.apply_mapping_config(v_payload, v_payload_mapping_id);
      END IF;

      v_headers := COALESCE(v_client_webhook_policy->'headers', '{}'::jsonb);
      IF jsonb_typeof(v_headers) <> 'object' THEN
        v_headers := '{}'::jsonb;
      END IF;
      IF NOT (v_headers ? 'content-type') THEN
        v_headers := v_headers || jsonb_build_object('content-type', 'application/json');
      END IF;

      v_method := upper(COALESCE(NULLIF(v_client_webhook_policy->>'method', ''), 'POST'));
      v_auth := v_client_webhook_policy->'auth';
      IF jsonb_typeof(v_auth) <> 'object' THEN
        v_auth := NULL;
      END IF;

      INSERT INTO public.outbound_calls (
        call_type,
        target_type,
        target_id,
        method,
        url,
        headers,
        body,
        correlation_id,
        shipment_id,
        context
      ) VALUES (
        'client_webhook',
        'client',
        v_client,
        v_method,
        v_url,
        v_headers,
        COALESCE(v_payload, '{}'::jsonb),
        v_corr,
        v_shipment_id,
        jsonb_strip_nulls(jsonb_build_object(
          'source', 'api_gateway_cancel_postprocess',
          'api_gateway_request_id', v_request_id,
          'webhook_source_id', v_source,
          'client_id', v_client,
          'sender_id', v_sender,
          'shipment_id', v_shipment_id,
          'canonical_status', v_shipment_status,
          'provider_status', 'CANCELLED',
          'auth', v_auth
        ))
      )
      RETURNING id INTO v_outbound_id;

      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'api_gateway_postprocess',
        p_resource_type := 'outbound_call',
        p_resource_id := v_outbound_id,
        p_decision_point := 'client_webhook_enqueue',
        p_decision_outcome := 'enqueued',
        p_performed_by_system := 'workflow_handlers.process_api_gateway_outbound_response_v1',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'shipment_id', v_shipment_id,
          'canonical_status', v_shipment_status,
          'method', v_method,
          'url', v_url
        )),
        p_settings_resolution_id := v_settings_resolution_id
      );
    END IF;

    RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_strip_nulls(jsonb_build_object(
        'mode', v_mode,
        'shipment_id', v_shipment_id,
        'status', 'cancelled',
        'client_webhook_outbound_call_id', v_outbound_id
      ))
    ));
  END IF;

  RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'unsupported_mode', 'mode', v_mode);
END;
$$;

COMMIT;
