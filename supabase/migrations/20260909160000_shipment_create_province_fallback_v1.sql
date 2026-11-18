-- Preserve explicit province/region; align missing-province handling with the
-- existing canonical address handler's city fallback.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_create_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result jsonb DEFAULT '{}'::jsonb
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
    v_transformed_payload JSONB := COALESCE(v_ctx->'transformed_payload', '{}'::jsonb);
    v_materialized_payload JSONB := CASE
      WHEN jsonb_typeof(v_transformed_payload) = 'object' AND v_transformed_payload <> '{}'::jsonb
        THEN v_transformed_payload
      ELSE v_payload
    END;
    v_resource JSONB := COALESCE(v_payload->'resource', '{}'::jsonb);
    v_payload_shipment JSONB := jsonb_strip_nulls(
      COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'shipment') = 'object' THEN v_materialized_payload->'shipment' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'shipment') = 'object' THEN v_resource->'shipment' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'shipment') = 'object' THEN v_ctx_patch->'shipment' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'shipment') = 'object' THEN v_ctx->'shipment' END, '{}'::jsonb)
    );
    v_payload_recipient JSONB := jsonb_strip_nulls(
      COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'recipient') = 'object' THEN v_materialized_payload->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,recipient}') = 'object' THEN v_materialized_payload#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'recipient') = 'object' THEN v_resource->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource#>'{shipment,recipient}') = 'object' THEN v_resource#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'recipient') = 'object' THEN v_ctx_patch->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch#>'{shipment,recipient}') = 'object' THEN v_ctx_patch#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'recipient') = 'object' THEN v_ctx->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx#>'{shipment,recipient}') = 'object' THEN v_ctx#>'{shipment,recipient}' END, '{}'::jsonb)
    );
    v_payload_address JSONB := jsonb_strip_nulls(
      COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'address') = 'object' THEN v_materialized_payload->'address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'destination_address') = 'object' THEN v_materialized_payload->'destination_address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,recipient,address}') = 'object' THEN v_materialized_payload#>'{shipment,recipient,address}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'address') = 'object' THEN v_resource->'address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'destination_address') = 'object' THEN v_resource->'destination_address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'address') = 'object' THEN v_ctx_patch->'address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'destination_address') = 'object' THEN v_ctx_patch->'destination_address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'address') = 'object' THEN v_ctx->'address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'destination_address') = 'object' THEN v_ctx->'destination_address' END, '{}'::jsonb)
    );

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
    v_service_type TEXT := COALESCE(
        NULLIF(v_ctx->>'service_type', ''),
        NULLIF(v_ctx_patch->>'service_type', ''),
        NULLIF(v_payload_shipment->>'service_type', ''),
        'delivery'
    );
    v_service_level TEXT := COALESCE(
        NULLIF(v_ctx->>'service_level', ''),
        NULLIF(v_ctx_patch->>'service_level', ''),
        NULLIF(v_payload_shipment->>'service_level', '')
    );
    v_provider_service_type TEXT;
    v_provider_service_level TEXT;
    v_status TEXT := COALESCE(NULLIF(v_ctx->>'initial_status', ''), 'pending');
    v_metadata_source UUID := COALESCE(
        NULLIF(v_ctx->>'webhook_id', '')::UUID,
        NULLIF(v_ctx_patch->>'webhook_id', '')::UUID
    );
    v_requested_by UUID := COALESCE(
        NULLIF(v_ctx->>'requested_by', '')::UUID,
        NULLIF(v_ctx_patch->>'requested_by', '')::UUID
    );

    v_client_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'client_reference_number', ''),
        NULLIF(v_ctx_patch->>'client_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_payload_shipment->>'client_reference_number', ''),
        NULLIF(v_payload_shipment->>'reference_number', ''),
        NULLIF(v_payload_shipment->>'external_id', ''),
        NULLIF(v_resource->>'client_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,client_reference_number}', '')
    );
    v_carrier_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'carrier_reference_number', ''),
        NULLIF(v_ctx_patch->>'carrier_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_payload_shipment->>'carrier_reference_number', ''),
        NULLIF(v_payload_shipment->>'carrier_reference', ''),
        NULLIF(v_resource->>'carrier_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,carrier_reference_number}', '')
    );

    v_recipient_id UUID := COALESCE(
        NULLIF(v_ctx->>'recipient_id', '')::UUID,
        NULLIF(v_ctx_patch->>'recipient_id', '')::UUID,
        NULLIF(v_payload_recipient->>'id', '')::UUID
    );
    v_recipient_external_id TEXT := NULLIF(btrim(COALESCE(v_payload_recipient->>'external_id', '')), '');
    v_recipient_name TEXT := NULLIF(btrim(COALESCE(v_payload_recipient->>'name', '')), '');
    v_recipient_phone TEXT := COALESCE(
        NULLIF(btrim(COALESCE(v_payload_recipient->>'phone_number', '')), ''),
        NULLIF(btrim(COALESCE(v_payload_recipient->>'phone', '')), '')
    );
    v_recipient_phone_normalized TEXT;
    v_recipient_email TEXT := NULLIF(btrim(COALESCE(v_payload_recipient->>'email', '')), '');

    v_address_line1 TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'line1', v_payload_address->>'normalized_line1', '')), '');
    v_address_line2 TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'line2', v_payload_address->>'normalized_line2', '')), '');
    v_address_district TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'district', '')), '');
    v_address_city TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'city', '')), '');
    v_address_province TEXT := COALESCE(
        NULLIF(btrim(v_payload_address->>'province'), ''),
        NULLIF(btrim(v_payload_address->>'region'), ''),
        v_address_city
    );
    v_address_postal_code TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'postal_code', '')), '');
    v_address_country TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'country_code', v_payload_address->>'country', '')), '');
    v_address_directions TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'additional_directions', v_payload_address->>'directions', '')), '');
    v_address_lat_text TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'lat', v_payload_address->>'latitude', '')), '');
    v_address_lng_text TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'lng', v_payload_address->>'longitude', '')), '');
    v_address_lat NUMERIC;
    v_address_lng NUMERIC;
    v_address_sa_short_code TEXT;
    v_address_geocoding_policy JSONB;
    v_address_short_plugin JSONB;
    v_address_coordinates geography;
    v_destination_address_id UUID;

    v_cod_amount_text TEXT := NULLIF(btrim(COALESCE(v_payload_shipment->>'cod_amount', v_payload_shipment->>'cash_on_delivery_amount', '')), '');
    v_cod_amount NUMERIC;
    v_cod_currency TEXT := COALESCE(
      NULLIF(btrim(COALESCE(v_payload_shipment->>'cod_currency', '')), ''),
      NULLIF(btrim(COALESCE(v_payload_shipment->>'currency', '')), '')
    );

    v_logistics_refs JSONB;
    v_reference_map JSONB := '{}'::jsonb;
    v_refs JSONB := '{}'::jsonb;
    v_ref_meta JSONB;
    v_input_metadata JSONB := '{}'::jsonb;

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

    IF v_recipient_phone IS NOT NULL THEN
      v_recipient_phone_normalized := public.normalize_phone_number(v_recipient_phone);
    END IF;

    IF v_cod_amount_text IS NOT NULL THEN
      IF v_cod_amount_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        v_cod_amount := v_cod_amount_text::NUMERIC;
      ELSE
        RAISE EXCEPTION 'execute_shipment_create_v1 cod_amount must be numeric';
      END IF;
    END IF;

    IF v_address_lat_text IS NOT NULL THEN
      IF v_address_lat_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        v_address_lat := v_address_lat_text::NUMERIC;
      ELSE
        RAISE EXCEPTION 'execute_shipment_create_v1 address.lat must be numeric';
      END IF;
    END IF;
    IF v_address_lng_text IS NOT NULL THEN
      IF v_address_lng_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        v_address_lng := v_address_lng_text::NUMERIC;
      ELSE
        RAISE EXCEPTION 'execute_shipment_create_v1 address.lng must be numeric';
      END IF;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.lookup_values lv
        JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
       WHERE ld.category = 'service_type'
         AND lv.value = v_service_type
         AND COALESCE(lv.status, 'active') = 'active'
    ) THEN
      v_provider_service_type := v_service_type;
      v_service_type := 'delivery';
    END IF;

    IF v_service_level IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.lookup_values lv
           JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
          WHERE ld.category = 'service_level'
            AND lv.value = v_service_level
            AND COALESCE(lv.status, 'active') = 'active'
       ) THEN
      v_provider_service_level := v_service_level;
      IF v_provider_service_type IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM public.lookup_values lv
             JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
            WHERE ld.category = 'service_level'
              AND lv.value = v_provider_service_type
              AND COALESCE(lv.status, 'active') = 'active'
         ) THEN
        v_service_level := v_provider_service_type;
      ELSE
        v_service_level := NULL;
      END IF;
    END IF;

    IF v_provider_service_type IS NOT NULL OR v_provider_service_level IS NOT NULL THEN
      v_input_metadata := v_input_metadata || jsonb_strip_nulls(jsonb_build_object(
        'provider_service_type', v_provider_service_type,
        'provider_service_level', v_provider_service_level
      ));
    END IF;

    IF v_org IS NULL OR v_client IS NULL OR v_planned_tracking IS NULL THEN
        v_result.status := 'failed';
        v_result.last_error := format(
          'execute_shipment_create_v1: missing required context (org %s, client %s, tracking %s)',
          COALESCE(v_org::TEXT, '<NULL>'),
          COALESCE(v_client::TEXT, '<NULL>'),
          COALESCE(v_planned_tracking, '<NULL>')
        );
        v_result.operation_result := jsonb_build_object(
          'reason', 'missing_required_context_failed_webhook_inbox',
          'error', v_result.last_error,
          'webhook_id', v_metadata_source,
          'organization_id', v_org,
          'client_id', v_client,
          'planned_tracking_number', v_planned_tracking
        );
        v_result.context_patch := jsonb_build_object(
          'shipment_create_error', v_result.operation_result
        );

        IF v_metadata_source IS NOT NULL THEN
          UPDATE public.webhook_inbox wi
             SET processing_status = 'failed',
                 processed_at = COALESCE(wi.processed_at, now()),
                 error_message = v_result.last_error,
                 updated_at = now()
           WHERE wi.id = v_metadata_source
             AND wi.processing_status IS DISTINCT FROM 'succeeded';

          IF v_org IS NOT NULL THEN
            PERFORM public.log_decision(
              p_organization_id := v_org,
              p_decision_category := 'webhook_processing',
              p_resource_type := 'webhook_inbox',
              p_resource_id := v_metadata_source,
              p_decision_point := 'shipment_create_context',
              p_decision_outcome := 'failed',
              p_performed_by_system := 'workflow_handlers.execute_shipment_create_v1',
              p_correlation_id := v_correlation_id,
              p_decision_inputs := v_result.operation_result,
              p_decision_reason := v_result.last_error
            );
          END IF;
        END IF;

        RETURN v_result;
    END IF;

    IF v_planned_id IS NULL THEN
        v_planned_id := gen_random_uuid();
    END IF;

    v_address_sa_short_code := public.address_sa_short_code_from_payload_v1(v_payload_address);
    v_address_coordinates := public.address_coordinates_from_payload_v1(v_payload_address);
    IF v_address_sa_short_code IS NOT NULL THEN
      v_address_geocoding_policy := COALESCE(
        public.resolve_settings('geocoding_policy', 'client', v_client),
        public.resolve_settings('geocoding_policy', 'tenant', v_org),
        public.resolve_settings('geocoding_policy', 'global', NULL),
        '{}'::jsonb
      );
      v_address_short_plugin := workflow_handlers.geocoding_get_plugin(v_address_geocoding_policy, 'short_code');
      v_address_sa_short_code := public.geocoding_normalize_candidate_code(
        v_address_sa_short_code,
        NULLIF(v_address_short_plugin->'params'->>'code_regex', '')
      );
    END IF;

    IF v_recipient_id IS NOT NULL THEN
      PERFORM 1
        FROM public.recipients r
       WHERE r.id = v_recipient_id
         AND r.client_id = v_client
         AND r.organization_id = v_org;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_shipment_create_v1 recipient % is outside shipment client scope', v_recipient_id;
      END IF;
    END IF;

    IF v_recipient_id IS NULL AND v_recipient_external_id IS NOT NULL THEN
      SELECT r.id
        INTO v_recipient_id
        FROM public.recipients r
       WHERE r.client_id = v_client
         AND r.external_id = v_recipient_external_id
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT 1;
    END IF;

    IF v_recipient_id IS NULL AND v_recipient_phone_normalized IS NOT NULL THEN
      SELECT r.id
        INTO v_recipient_id
        FROM public.recipients r
       WHERE r.client_id = v_client
         AND r.phone_number_normalized = v_recipient_phone_normalized
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT 1;
    END IF;

    IF v_recipient_id IS NULL AND v_recipient_name IS NOT NULL AND v_recipient_phone IS NOT NULL THEN
      INSERT INTO public.recipients (
        organization_id,
        client_id,
        external_id,
        name,
        phone_number,
        phone_validation_status,
        email
      )
      VALUES (
        v_org,
        v_client,
        v_recipient_external_id,
        v_recipient_name,
        v_recipient_phone,
        'pending',
        v_recipient_email
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_recipient_id;

      IF v_recipient_id IS NULL AND v_recipient_phone_normalized IS NOT NULL THEN
        SELECT r.id
          INTO v_recipient_id
          FROM public.recipients r
         WHERE r.client_id = v_client
           AND r.phone_number_normalized = v_recipient_phone_normalized
         ORDER BY r.created_at ASC, r.id ASC
         LIMIT 1;
      END IF;
    END IF;

    IF v_address_line1 IS NOT NULL
       OR v_address_city IS NOT NULL
       OR v_address_district IS NOT NULL
       OR v_address_postal_code IS NOT NULL THEN
      INSERT INTO public.addresses (
        organization_id,
        client_id,
        raw_input,
        sa_short_code,
        normalized_line1,
        normalized_line2,
        line1,
        line2,
        district,
        city,
        province,
        postal_code,
        country,
        additional_directions,
        validation_status,
        is_pii,
        coordinates
      )
      VALUES (
        v_org,
        v_client,
        NULLIF(btrim(concat_ws(', ', v_address_line1, v_address_line2, v_address_district, v_address_city, v_address_province, v_address_country)), ''),
        v_address_sa_short_code,
        v_address_line1,
        v_address_line2,
        v_address_line1,
        v_address_line2,
        v_address_district,
        v_address_city,
        v_address_province,
        v_address_postal_code,
        COALESCE(v_address_country, 'SA'),
        v_address_directions,
        'pending',
        TRUE,
        COALESCE(
          v_address_coordinates,
          CASE
            WHEN v_address_lat IS NOT NULL AND v_address_lng IS NOT NULL
              THEN ST_SetSRID(ST_MakePoint(v_address_lng, v_address_lat), 4326)::geography
            ELSE NULL
          END
        )
      )
      RETURNING id INTO v_destination_address_id;
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
    IF jsonb_typeof(v_payload_shipment->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_payload_shipment->'references';
    END IF;
    IF jsonb_typeof(v_resource->'metadata') = 'object' THEN
      v_input_metadata := v_input_metadata || v_resource->'metadata';
    END IF;
    IF jsonb_typeof(v_ctx->'metadata') = 'object' THEN
      v_input_metadata := v_input_metadata || v_ctx->'metadata';
    END IF;
    IF jsonb_typeof(v_ctx_patch->'metadata') = 'object' THEN
      v_input_metadata := v_input_metadata || v_ctx_patch->'metadata';
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
            service_level,
            tracking_number,
            carrier_reference_number,
            client_reference_number,
            recipient_id,
            destination_address_id,
            cod_amount,
            cod_currency,
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
            v_service_level,
            v_planned_tracking,
            NULLIF(btrim(v_carrier_reference), ''),
            NULLIF(btrim(v_client_reference), ''),
            v_recipient_id,
            v_destination_address_id,
            v_cod_amount,
            COALESCE(v_cod_currency, 'SAR'),
            v_status,
            1,
            jsonb_strip_nulls(
              v_input_metadata ||
              jsonb_build_object(
                'created_by', 'workflow',
                'workflow_run_id', p_run.id,
                'source_webhook_id', v_metadata_source,
                'requested_by', v_requested_by,
                'correlation_id', v_correlation_id,
                'provider_payload', jsonb_strip_nulls(jsonb_build_object(
                  'shipment', NULLIF(v_payload_shipment, '{}'::jsonb),
                  'recipient_external_id', v_recipient_external_id,
                  'destination_address_id', v_destination_address_id
                ))
              )
            )
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

    UPDATE public.shipments
       SET recipient_id = COALESCE(public.shipments.recipient_id, v_recipient_id),
           destination_address_id = COALESCE(public.shipments.destination_address_id, v_destination_address_id),
           cod_amount = COALESCE(public.shipments.cod_amount, v_cod_amount),
           cod_currency = COALESCE(NULLIF(public.shipments.cod_currency, ''), v_cod_currency, 'SAR'),
           service_level = COALESCE(NULLIF(public.shipments.service_level, ''), v_service_level),
           metadata = jsonb_strip_nulls(
             COALESCE(public.shipments.metadata, '{}'::jsonb)
             || v_input_metadata
             || jsonb_build_object(
               'provider_payload', jsonb_strip_nulls(jsonb_build_object(
                 'shipment', NULLIF(v_payload_shipment, '{}'::jsonb),
                 'recipient_external_id', v_recipient_external_id,
                 'recipient_id', v_recipient_id,
                 'destination_address_id', v_destination_address_id,
                 'workflow_run_id', p_run.id,
                 'webhook_id', v_metadata_source,
                 'correlation_id', v_correlation_id
               ))
             )
           ),
           updated_at = now()
     WHERE id = v_row_id
       AND client_id = v_client;

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
        'webhook_id', v_metadata_source,
        'requested_by', v_requested_by,
        'correlation_id', v_correlation_id
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

    IF v_metadata_source IS NOT NULL THEN
      UPDATE public.webhook_inbox wi
         SET processing_status = 'succeeded',
             processed_at = COALESCE(wi.processed_at, now()),
             error_message = NULL
       WHERE wi.id = v_metadata_source
         AND wi.processing_status IS DISTINCT FROM 'failed';
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
        'operation', v_operation,
        'recipient_id', v_recipient_id,
        'destination_address_id', v_destination_address_id,
        'cod_amount', v_cod_amount,
        'cod_currency', v_cod_currency
    ));
    v_result.context_patch := jsonb_build_object(
        'shipment', jsonb_strip_nulls(jsonb_build_object(
            'id', v_row_id,
            'tracking_number', v_tracking_number,
            'client_reference_number', NULLIF(btrim(v_client_reference), '')
        )),
        'recipient_id', v_recipient_id,
        'destination_address_id', v_destination_address_id
    );
    v_result.last_error := NULL;
    v_result.retry_attempt := 1;
    v_result.max_retries := 1;

    RETURN v_result;
END;
$function$;

COMMIT;
