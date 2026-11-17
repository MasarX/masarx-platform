-- Migration: Preserve Saudi short national address in webhook address intake
-- Purpose: Webhook/API payload address intake must persist submitted Saudi short
--          codes alongside provided coordinates so geocoding/reverse geocoding
--          readback can prove the canonical backend address truth. Mapping
--          extraction also accepts JSONPath-style "$." prefixes used by
--          operator-configured external intake mappings.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.resolve_path_text(
    p_payload JSONB,
    p_paths TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
    v_token TEXT;
    v_normalized_token TEXT;
    v_candidate JSONB;
BEGIN
    IF p_payload IS NULL OR p_paths IS NULL OR btrim(p_paths) = '' THEN
        RETURN NULL;
    END IF;

    FOREACH v_token IN ARRAY string_to_array(p_paths, '|') LOOP
        v_token := btrim(v_token);
        IF v_token = '' THEN
            CONTINUE;
        END IF;

        v_normalized_token := regexp_replace(v_token, '^\$\.?', '');
        IF v_normalized_token = '' THEN
            v_candidate := p_payload;
        ELSE
            v_candidate := jsonb_resolve_path(p_payload, v_normalized_token);
        END IF;

        IF v_candidate IS NOT NULL AND v_candidate::TEXT <> 'null' THEN
            IF jsonb_typeof(v_candidate) IN ('string', 'number', 'boolean') THEN
                RETURN v_candidate #>> '{}';
            ELSE
                RETURN v_candidate::TEXT;
            END IF;
        END IF;
    END LOOP;

    RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.resolve_path_text(JSONB, TEXT)
    IS 'Resolve first non-null value from pipe-delimited dot paths or JSONPath-style $. paths against a payload and return scalar text.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_address_intake_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
    v_step_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_response public.workflow_handler_response;
    v_webhook_id UUID := NULLIF(v_ctx->>'webhook_id', '')::UUID;
    v_address_id UUID := NULLIF(v_ctx->>'address_id', '')::UUID;
    v_mapping_id UUID := COALESCE(
        NULLIF(v_step_metadata->>'mapping_config_id', '')::UUID,
        NULLIF(v_ctx->>'mapping_config_id', '')::UUID
    );
    v_webhook RECORD;
    v_source RECORD;
    v_payload JSONB := '{}'::jsonb;
    v_raw_payload JSONB := '{}'::jsonb;
    v_transformed_payload JSONB := '{}'::jsonb;
    v_mapping JSONB;
    v_address_map JSONB;
    v_line1 TEXT;
    v_line2 TEXT;
    v_city TEXT;
    v_city_raw TEXT;
    v_district TEXT;
    v_province TEXT;
    v_province_raw TEXT;
    v_country TEXT;
    v_postal TEXT;
    v_lat NUMERIC;
    v_lng NUMERIC;
    v_short_code TEXT;
    v_code_regex TEXT;
    v_policy JSONB;
    v_short_plugin JSONB;
    v_raw JSONB;
    v_inserted_id UUID;
    v_org UUID;
    v_client UUID;
    v_sender UUID;
    v_provided_coords JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', FALSE);

    IF v_address_id IS NOT NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'address_present');
        RETURN v_response;
    END IF;

    IF v_webhook_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('created', FALSE, 'reason', 'webhook_missing');
        RETURN v_response;
    END IF;

    SELECT
        wi.raw_payload,
        wi.transformed_payload,
        wi.webhook_source_id
    INTO v_webhook
    FROM public.webhook_inbox wi
    WHERE wi.id = v_webhook_id;

    IF NOT FOUND THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('created', FALSE, 'reason', 'webhook_not_found');
        RETURN v_response;
    END IF;

    v_raw_payload := COALESCE(v_webhook.raw_payload, '{}'::jsonb);
    v_transformed_payload := COALESCE(v_webhook.transformed_payload, '{}'::jsonb);
    v_payload := CASE
      WHEN v_raw_payload <> '{}'::jsonb THEN v_raw_payload
      ELSE v_transformed_payload
    END;

    SELECT
        ws.organization_id,
        ws.sender_id,
        ws.mapping_config_id,
        s.client_id
    INTO v_source
    FROM public.webhook_sources ws
    LEFT JOIN public.senders s ON s.id = ws.sender_id
    WHERE ws.id = v_webhook.webhook_source_id;

    v_org := COALESCE(
        v_source.organization_id,
        NULLIF(v_ctx->>'organization_id', '')::UUID
    );
    v_client := COALESCE(
        v_source.client_id,
        NULLIF(v_ctx->>'client_id', '')::UUID
    );
    v_sender := COALESCE(
        v_source.sender_id,
        NULLIF(v_ctx->>'sender_id', '')::UUID
    );

    IF v_mapping_id IS NULL THEN
        v_mapping_id := v_source.mapping_config_id;
    END IF;

    IF v_mapping_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('created', FALSE, 'reason', 'mapping_missing');
        RETURN v_response;
    END IF;

    SELECT mapping_config
      INTO v_mapping
      FROM public.mapping_configs
     WHERE id = v_mapping_id
       AND mapping_type = 'webhook_inbound';

    IF NOT FOUND THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'created', FALSE,
            'reason', 'mapping_not_found',
            'mapping_config_id', v_mapping_id
        );
        RETURN v_response;
    END IF;

    v_address_map := COALESCE(v_mapping->'transforms'->'address', '{}'::jsonb);

    v_line1 := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line1'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'line1')
    );
    v_line2 := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line2'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'line2')
    );
    v_city := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'city'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'city')
    );
    v_district := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'district'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'district')
    );
    v_province := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'province'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'province')
    );
    v_country := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'country'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'country')
    );
    v_postal := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'postal_code'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'postal_code')
    );
    v_lat := NULLIF(COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lat'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'lat')
    ), '')::NUMERIC;
    v_lng := NULLIF(COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lng'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'lng')
    ), '')::NUMERIC;
    v_short_code := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'sa_short_code'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'sa_short_code'),
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'short_code'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'short_code'),
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'short_national_address'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'short_national_address')
    );

    v_country := COALESCE(NULLIF(v_country, ''), 'SA');

    v_city_raw := NULLIF(v_city, '');
    v_province_raw := NULLIF(v_province, '');
    v_city := COALESCE(v_city_raw, '');
    v_province := COALESCE(v_province_raw, '');

    v_line1 := NULLIF(v_line1, '');
    v_line2 := NULLIF(v_line2, '');
    v_district := NULLIF(v_district, '');
    v_postal := NULLIF(v_postal, '');
    v_short_code := NULLIF(v_short_code, '');

    IF v_org IS NULL OR v_client IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'created', FALSE,
            'reason', 'scope_missing',
            'organization_id', v_org,
            'client_id', v_client
        );
        RETURN v_response;
    END IF;

    IF v_short_code IS NOT NULL THEN
        v_policy := public.resolve_settings('geocoding_policy', 'client', v_client);
        v_short_plugin := workflow_handlers.geocoding_get_plugin(COALESCE(v_policy, '{}'::jsonb), 'short_code');
        v_code_regex := COALESCE(NULLIF(v_short_plugin->'params'->>'code_regex', ''), '^[A-Z]{4}[0-9]{4}$');
        v_short_code := public.geocoding_normalize_candidate_code(v_short_code, v_code_regex);
    END IF;

    v_raw := jsonb_strip_nulls(jsonb_build_object(
        'line1', v_line1,
        'line2', v_line2,
        'short_code', v_short_code,
        'sa_short_code', v_short_code,
        'district', v_district,
        'city', v_city_raw,
        'province', v_province_raw,
        'country', v_country,
        'postal_code', v_postal,
        'lat', v_lat,
        'lng', v_lng
    ));

    IF v_lat IS NOT NULL AND v_lng IS NOT NULL
       AND v_lat BETWEEN -90 AND 90
       AND v_lng BETWEEN -180 AND 180 THEN
        v_provided_coords := jsonb_build_object(
            'latitude', v_lat,
            'longitude', v_lng
        );
    END IF;

    INSERT INTO public.addresses (
        id,
        organization_id,
        client_id,
        raw_input,
        sa_short_code,
        normalized_line1,
        normalized_line2,
        district,
        city,
        province,
        postal_code,
        country,
        line1,
        line2,
        validation_status,
        created_at,
        updated_at
    )
    VALUES (
        gen_random_uuid(),
        v_org,
        v_client,
        COALESCE(v_raw, '{}'::jsonb)::TEXT,
        v_short_code,
        v_line1,
        v_line2,
        v_district,
        v_city,
        v_province,
        v_postal,
        v_country,
        v_line1,
        v_line2,
        'pending',
        now(),
        now()
    )
    RETURNING id INTO v_inserted_id;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'created', TRUE,
        'address_id', v_inserted_id,
        'mapping_config_id', v_mapping_id,
        'source_id', v_webhook.webhook_source_id
    ));
    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
        'address_id', v_inserted_id,
        'organization_id', v_org,
        'client_id', v_client,
        'sender_id', v_sender,
        'address_input', v_raw,
        'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'short_code', v_short_code,
            'provided_coordinates', v_provided_coords
        ))
    ));

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_address_intake_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Creates address records from webhook payloads and surfaces Saudi short code plus provided coordinates for geocoding workflows.';

COMMIT;
