-- Migration: Apply HERE reverse geocoding template and mapping (idempotent)

BEGIN;

DO $$
DECLARE
    v_provider_id UUID;
    v_mapping_id UUID;
    v_template_id UUID;
BEGIN
    SELECT id INTO v_provider_id FROM providers WHERE name = 'here_geocoding' LIMIT 1;
    IF v_provider_id IS NULL THEN
        RAISE NOTICE 'here_geocoding provider missing; skipping apply';
        RETURN;
    END IF;

    SELECT id INTO v_mapping_id FROM mapping_configs WHERE mapping_key = 'here_geocoding::reverse_v1' LIMIT 1;
    IF v_mapping_id IS NULL THEN
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
        )
        RETURNING id INTO v_mapping_id;
    END IF;

    IF v_mapping_id IS NULL THEN
        RAISE NOTICE 'mapping_config unavailable for here_geocoding::reverse_v1; aborting template apply';
        RETURN;
    END IF;

    SELECT id INTO v_template_id
    FROM operation_templates
    WHERE provider_id = v_provider_id
      AND operation_name = 'geocoding_here_reverse_v1'
    LIMIT 1;

    IF v_template_id IS NULL THEN
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
            handler_key,
            handler_version,
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
            'outbound_http',
            'v1',
            now(),
            now()
        );
    ELSE
        UPDATE operation_templates
        SET url_template = 'https://revgeocode.search.hereapi.com/v1/revgeocode',
            headers_template = jsonb_build_object('accept', 'application/json'),
            mapping_config_id = v_mapping_id,
            metadata = jsonb_build_object(
                'operation_role', 'geocoding_reverse',
                'url_query_mapping', jsonb_build_array(
                    jsonb_build_object('param', 'at', 'value_path', '$.coordinates'),
                    jsonb_build_object('param', 'lang', 'value_path', '$.address.lang'),
                    jsonb_build_object('param', 'limit', 'value_path', '$.address.limit'),
                    jsonb_build_object('param', 'apiKey', 'value_path', '$.provider.api_key')
                )
            ),
            handler_key = 'outbound_http',
            handler_version = 'v1',
            updated_at = now()
        WHERE id = v_template_id;
    END IF;
END
$$;

COMMIT;
