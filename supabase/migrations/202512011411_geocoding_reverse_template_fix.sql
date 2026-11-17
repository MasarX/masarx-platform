-- Migration: Geocoding reverse template fix (HERE)
-- Purpose: Insert missing mapping_config and operation_template for HERE reverse geocode after prior skip.

BEGIN;

DO $$
DECLARE
    v_provider_id UUID;
    v_mapping_id UUID;
    v_exists BOOLEAN;
BEGIN
    SELECT id INTO v_provider_id FROM providers WHERE name = 'here_geocoding' LIMIT 1;
    IF v_provider_id IS NULL THEN
        RAISE NOTICE 'here_geocoding provider missing; skipping reverse template fix';
        RETURN;
    END IF;

    SELECT TRUE INTO v_exists FROM mapping_configs WHERE mapping_key = 'here_geocoding::reverse_v1' LIMIT 1;
    IF NOT v_exists THEN
        INSERT INTO mapping_configs (
            id,
            mapping_type,
            mapping_key,
            mapping_config,
            mapping_version,
            notes,
            created_at,
            updated_at
        )
        VALUES (
            gen_random_uuid(),
            'provider_response',
            'here_geocoding::reverse_v1',
            '{}'::jsonb,
            1,
            'HERE reverse geocode response mapping (passthrough)',
            now(),
            now()
        );
    END IF;

    SELECT id INTO v_mapping_id FROM mapping_configs WHERE mapping_key = 'here_geocoding::reverse_v1' LIMIT 1;

    IF v_mapping_id IS NULL THEN
        RAISE NOTICE 'mapping_config still missing for here_geocoding::reverse_v1; aborting template insert';
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM operation_templates
        WHERE provider_id = v_provider_id
          AND operation_name = 'geocoding_here_reverse_v1'
    ) THEN
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
            metadata,
            created_at,
            updated_at
        )
        VALUES (
            gen_random_uuid(),
            v_provider_id,
            'geocoding_here_reverse_v1',
            'GET',
            'https://revgeocode.search.hereapi.com/v1/revgeocode',
            jsonb_build_object('accept', 'application/json'),
            NULL,
            NULL,
            v_mapping_id,
            jsonb_build_object(
                'operation_role', 'geocoding_reverse',
                'url_query_mapping', jsonb_build_array(
                    jsonb_build_object('param', 'at', 'value_path', '$.coordinates'),
                    jsonb_build_object('param', 'lang', 'value_path', '$.address.lang'),
                    jsonb_build_object('param', 'limit', 'value_path', '$.address.limit'),
                    jsonb_build_object('param', 'apiKey', 'value_path', '$.provider.api_key')
                )
            ),
            now(),
            now()
        );
    END IF;
END
$$;

COMMIT;
