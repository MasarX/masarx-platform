-- Migration: Geocoding provider templates and helpers
-- Purpose: Install HERE/Google operation templates and response mappings for dynamic geocoding dispatch.
-- Alignment: SIMPLE / SCALABLE / DYNAMIC - templates + mappings drive provider behaviour (zero hard coding).

BEGIN;

DROP FUNCTION IF EXISTS public.urlencode(TEXT);

CREATE OR REPLACE FUNCTION public.urlencode(p_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_bytes BYTEA;
    v_len INT;
    v_pos INT;
    v_char INT;
    v_result TEXT := '';
    v_hex TEXT;
BEGIN
    IF p_value IS NULL THEN
        RETURN NULL;
    END IF;

    v_bytes := convert_to(p_value, 'UTF8');
    v_len := length(v_bytes);

    FOR v_pos IN 0 .. v_len - 1 LOOP
        v_char := get_byte(v_bytes, v_pos);
        IF (v_char BETWEEN 48 AND 57)
           OR (v_char BETWEEN 65 AND 90)
           OR (v_char BETWEEN 97 AND 122)
           OR v_char IN (45, 95, 46, 126) THEN
            v_result := v_result || chr(v_char);
        ELSE
            v_hex := upper(lpad(to_hex(v_char), 2, '0'));
            v_result := v_result || '%' || v_hex;
        END IF;
    END LOOP;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.urlencode(TEXT)
    IS 'Percent-encode UTF-8 text for query strings (RFC 3986 safe characters preserved).';

DO $$
DECLARE
    v_here_provider RECORD;
BEGIN
    SELECT id, COALESCE(metadata->>'base_url', 'https://geocode.search.hereapi.com/v1') AS base_url
    INTO v_here_provider
    FROM providers
    WHERE name = 'here_geocoding'
    LIMIT 1;

    IF v_here_provider.id IS NULL THEN
        RAISE NOTICE 'Skipping HERE provider template seed because here_geocoding provider is not present.';
        RETURN;
    END IF;

    INSERT INTO mapping_configs (
        id,
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
    )
    VALUES (
        '99990000-0000-0000-0000-000000240001'::uuid,
        'provider_response',
        'geocoding::here_forward::v1',
        jsonb_build_object(
            'field_mappings', jsonb_build_object(
                'latitude', '$.items[0].position.lat',
                'longitude', '$.items[0].position.lng',
                'formatted_address', '$.items[0].title',
                'confidence_score', '$.items[0].scoring.relevance',
                'address_components', '$.items[0].address',
                'raw_items', '$.items'
            )
        ),
        1,
        'HERE Geocode API v1 response mapping (primary provider)'
    )
    ON CONFLICT (id) DO UPDATE
    SET mapping_config = EXCLUDED.mapping_config,
        mapping_version = EXCLUDED.mapping_version,
        notes = EXCLUDED.notes,
        updated_at = now();

    INSERT INTO operation_templates (
        id,
        provider_id,
        operation_name,
        method,
        url_template,
        headers_template,
        body_template,
        request_mappings,
        mapping_config_id,
        timeout_seconds,
        idempotency_key_template,
        handler_key,
        handler_version
    )
    SELECT
        '99990000-0000-0000-0000-000000250001'::uuid,
        v_here_provider.id,
        'geocoding_here_forward_v1',
        'GET',
        v_here_provider.base_url || '/geocode',
        jsonb_build_object('accept', 'application/json'),
        '{}'::jsonb,
        '{}'::jsonb,
        '99990000-0000-0000-0000-000000240001'::uuid,
        15,
        NULL,
        'outbound_http',
        'v1'
    ON CONFLICT (provider_id, operation_name) DO UPDATE
    SET url_template = EXCLUDED.url_template,
        headers_template = EXCLUDED.headers_template,
        body_template = EXCLUDED.body_template,
        request_mappings = EXCLUDED.request_mappings,
        mapping_config_id = EXCLUDED.mapping_config_id,
        timeout_seconds = EXCLUDED.timeout_seconds,
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        updated_at = now();
END;
$$;

DO $$
DECLARE
    v_google_provider RECORD;
BEGIN
    SELECT id, COALESCE(metadata->>'base_url', 'https://maps.googleapis.com/maps/api/geocode') AS base_url
    INTO v_google_provider
    FROM providers
    WHERE name = 'google_maps'
    LIMIT 1;

    IF v_google_provider.id IS NULL THEN
        RAISE NOTICE 'Skipping Google Maps provider template seed because google_maps provider is not present.';
        RETURN;
    END IF;

    INSERT INTO mapping_configs (
        id,
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
    )
    VALUES (
        '99990000-0000-0000-0000-000000240002'::uuid,
        'provider_response',
        'geocoding::google_forward::v1',
        jsonb_build_object(
            'field_mappings', jsonb_build_object(
                'latitude', '$.results[0].geometry.location.lat',
                'longitude', '$.results[0].geometry.location.lng',
                'formatted_address', '$.results[0].formatted_address',
                'place_id', '$.results[0].place_id',
                'geometry', '$.results[0].geometry'
            )
        ),
        1,
        'Google Maps Geocode API response mapping (fallback provider)'
    )
    ON CONFLICT (id) DO UPDATE
    SET mapping_config = EXCLUDED.mapping_config,
        mapping_version = EXCLUDED.mapping_version,
        notes = EXCLUDED.notes,
        updated_at = now();

    INSERT INTO operation_templates (
        id,
        provider_id,
        operation_name,
        method,
        url_template,
        headers_template,
        body_template,
        request_mappings,
        mapping_config_id,
        timeout_seconds,
        idempotency_key_template,
        handler_key,
        handler_version
    )
    SELECT
        '99990000-0000-0000-0000-000000250002'::uuid,
        v_google_provider.id,
        'geocoding_google_forward_v1',
        'GET',
        v_google_provider.base_url || '/json',
        jsonb_build_object('accept', 'application/json'),
        '{}'::jsonb,
        '{}'::jsonb,
        '99990000-0000-0000-0000-000000240002'::uuid,
        15,
        NULL,
        'outbound_http',
        'v1'
    ON CONFLICT (provider_id, operation_name) DO UPDATE
    SET url_template = EXCLUDED.url_template,
        headers_template = EXCLUDED.headers_template,
        body_template = EXCLUDED.body_template,
        request_mappings = EXCLUDED.request_mappings,
        mapping_config_id = EXCLUDED.mapping_config_id,
        timeout_seconds = EXCLUDED.timeout_seconds,
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        updated_at = now();
END;
$$;

COMMIT;
