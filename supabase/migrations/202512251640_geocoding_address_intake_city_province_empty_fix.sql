-- Migration: Geocoding webhook intake - avoid 'unknown' poisoning for short-code-only inputs
-- Purpose:
--   When city/province are absent, store empty strings in NOT NULL columns (addresses.city/province)
--   and avoid writing sentinel values like 'unknown' into raw_input, so local lookup and provider
--   dispatch are not polluted for short-code-only addresses (e.g., ABCD1234).
-- Alignment: SIMPLE - DYNAMIC - ZERO HARD CODING - workflow-driven.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_address_intake_v1(
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

    v_payload := COALESCE(v_webhook.transformed_payload, v_webhook.raw_payload, '{}'::jsonb);

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

    v_line1 := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line1');
    v_line2 := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line2');
    v_city := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'city');
    v_district := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'district');
    v_province := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'province');
    v_country := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'country');
    v_postal := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'postal_code');
    v_lat := (workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lat'))::NUMERIC;
    v_lng := (workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lng'))::NUMERIC;

    v_country := COALESCE(NULLIF(v_country, ''), 'SA');

    -- Avoid 'unknown' sentinels: keep raw_input clean and store empty strings in NOT NULL columns.
    v_city_raw := NULLIF(v_city, '');
    v_province_raw := NULLIF(v_province, '');
    v_city := COALESCE(v_city_raw, '');
    v_province := COALESCE(v_province_raw, '');

    v_line1 := NULLIF(v_line1, '');
    v_line2 := NULLIF(v_line2, '');
    v_district := NULLIF(v_district, '');
    v_postal := NULLIF(v_postal, '');

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

    v_raw := jsonb_strip_nulls(jsonb_build_object(
        'line1', v_line1,
        'line2', v_line2,
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
        'geocoding', jsonb_build_object(
            'provided_coordinates', v_provided_coords
        )
    ));

    RETURN v_response;
END;
$function$;

COMMIT;

