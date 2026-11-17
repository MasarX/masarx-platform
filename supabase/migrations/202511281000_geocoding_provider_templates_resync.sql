-- Migration: Geocoding provider templates resync
-- Purpose:
--   Ensure HERE and Google geocoding operation templates are present
--   after providers have been seeded. This fixes the case where
--   202511011140_geocoding_provider_templates.sql ran before providers
--   existed and therefore skipped HERE template creation.
-- Alignment: SIMPLE / SCALABLE / DYNAMIC

BEGIN;

DO $$
DECLARE
  v_here_provider RECORD;
BEGIN
  SELECT
    id,
    COALESCE(metadata->>'base_url', 'https://geocode.search.hereapi.com/v1') AS base_url
  INTO v_here_provider
  FROM providers
  WHERE name = 'here_geocoding'
  LIMIT 1;

  IF v_here_provider.id IS NULL THEN
    RAISE NOTICE 'geocoding_provider_templates_resync: here_geocoding provider not present, skipping HERE template seed.';
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
  SELECT
    id,
    COALESCE(metadata->>'base_url', 'https://maps.googleapis.com/maps/api/geocode') AS base_url
  INTO v_google_provider
  FROM providers
  WHERE name = 'google_maps'
  LIMIT 1;

  IF v_google_provider.id IS NULL THEN
    RAISE NOTICE 'geocoding_provider_templates_resync: google_maps provider not present, skipping Google template seed.';
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

-- Ensure operation templates carry canonical metadata for policy-driven routing.
UPDATE operation_templates
SET metadata = jsonb_strip_nulls(
        COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'operation_role', 'geocoding_forward',
            'url_query_mapping',
                CASE operation_name
                    WHEN 'geocoding_here_forward_v1' THEN jsonb_build_array(
                        jsonb_build_object('param', 'q', 'value_path', '$.address.text'),
                        jsonb_build_object('param', 'lang', 'value_path', '$.address.lang'),
                        jsonb_build_object('param', 'limit', 'value_path', '$.address.limit'),
                        jsonb_build_object('param', 'apiKey', 'value_path', '$.provider.api_key')
                    )
                    WHEN 'geocoding_google_forward_v1' THEN jsonb_build_array(
                        jsonb_build_object('param', 'address', 'value_path', '$.address.text'),
                        jsonb_build_object('param', 'language', 'value_path', '$.address.lang'),
                        jsonb_build_object('param', 'key', 'value_path', '$.provider.api_key')
                    )
                    ELSE NULL
                END
        )
    )
WHERE operation_name IN ('geocoding_here_forward_v1', 'geocoding_google_forward_v1');

COMMIT;
