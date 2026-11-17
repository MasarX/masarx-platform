-- Plan: PLAN-202601-lex-mkt-live-pitch-demo / Step: S05
-- Migration: API gateway short code extraction + Logestechs path patch
-- Purpose:
--   - Capture short national address from API gateway payloads into addresses.sa_short_code.
--   - Preserve normalized short code in raw_input for auditing + geocoding plugins.
--   - Extend Logestechs V2 mirror extract config with short code paths.
-- Date: 2026-01-04

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.api_gateway_materialize_address_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_request_body JSONB,
  p_extract JSONB,
  p_kind TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_kind TEXT := COALESCE(NULLIF(lower(p_kind), ''), '');
  v_extract JSONB := COALESCE(p_extract, '{}'::jsonb);
  v_body JSONB := COALESCE(p_request_body, '{}'::jsonb);

  v_line1 TEXT;
  v_line2 TEXT;
  v_city TEXT;
  v_province TEXT;
  v_district TEXT;
  v_country TEXT;
  v_postal TEXT;
  v_lat NUMERIC;
  v_lng NUMERIC;
  v_short_code TEXT;
  v_code_regex TEXT;
  v_policy JSONB;
  v_short_plugin JSONB;

  v_raw_source JSONB;
  v_raw JSONB;
  v_address_id UUID;
  v_key TEXT;
BEGIN
  IF p_organization_id IS NULL OR p_client_id IS NULL THEN
    RETURN jsonb_build_object('created', FALSE, 'reason', 'scope_missing');
  END IF;

  IF v_kind NOT IN ('origin', 'destination') THEN
    RETURN jsonb_build_object('created', FALSE, 'reason', 'invalid_kind');
  END IF;

  v_key := v_kind || '_line1_path';
  v_line1 := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_line2_path';
  v_line2 := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_city_path';
  v_city := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_province_path';
  v_province := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_district_path';
  v_district := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_country_path';
  v_country := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_postal_path';
  v_postal := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_short_code_path';
  v_short_code := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);

  v_key := v_kind || '_lat_path';
  BEGIN
    v_lat := NULLIF(workflow_handlers.resolve_path_text(v_body, v_extract->>v_key), '')::NUMERIC;
  EXCEPTION
    WHEN others THEN
      v_lat := NULL;
  END;

  v_key := v_kind || '_lng_path';
  BEGIN
    v_lng := NULLIF(workflow_handlers.resolve_path_text(v_body, v_extract->>v_key), '')::NUMERIC;
  EXCEPTION
    WHEN others THEN
      v_lng := NULL;
  END;

  v_key := v_kind || '_raw_path';
  v_raw_source := public.jsonb_resolve_path(v_body, v_extract->>v_key);
  IF jsonb_typeof(v_raw_source) NOT IN ('object', 'array') THEN
    v_raw_source := NULL;
  END IF;

  v_country := COALESCE(NULLIF(v_country, ''), 'SA');
  v_city := COALESCE(NULLIF(v_city, ''), 'unknown');
  v_province := COALESCE(NULLIF(v_province, ''), 'unknown');
  v_line1 := NULLIF(v_line1, '');
  v_line2 := NULLIF(v_line2, '');
  v_district := NULLIF(v_district, '');
  v_postal := NULLIF(v_postal, '');
  v_short_code := NULLIF(v_short_code, '');

  IF v_short_code IS NOT NULL THEN
    v_policy := public.resolve_settings('geocoding_policy', 'client', p_client_id);
    v_short_plugin := workflow_handlers.geocoding_get_plugin(COALESCE(v_policy, '{}'::jsonb), 'short_code');
    v_code_regex := COALESCE(NULLIF(v_short_plugin->'params'->>'code_regex', ''), '^[A-Z]{4}[0-9]{4}$');
    v_short_code := public.geocoding_normalize_candidate_code(v_short_code, v_code_regex);
  END IF;

  v_raw := jsonb_strip_nulls(jsonb_build_object(
    'kind', v_kind,
    'source_address', v_raw_source,
    'line1', v_line1,
    'line2', v_line2,
    'short_code', v_short_code,
    'sa_short_code', v_short_code,
    'district', v_district,
    'city', v_city,
    'province', v_province,
    'country', v_country,
    'postal_code', v_postal,
    'provided_coordinates', CASE
      WHEN v_lat IS NOT NULL AND v_lng IS NOT NULL
           AND v_lat BETWEEN -90 AND 90
           AND v_lng BETWEEN -180 AND 180 THEN jsonb_build_object('latitude', v_lat, 'longitude', v_lng)
      ELSE NULL
    END
  ));

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
  ) VALUES (
    gen_random_uuid(),
    p_organization_id,
    p_client_id,
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
  RETURNING id INTO v_address_id;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'created', TRUE,
    'address_id', v_address_id,
    'provided_coordinates', v_raw->'provided_coordinates'
  ));
END;
$$;

DO $do$
DECLARE
  v_pack_id UUID;
BEGIN
  SELECT id INTO v_pack_id
  FROM public.api_route_packs
  WHERE name = 'logestechs_v2_mirror'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_pack_id IS NULL THEN
    RAISE NOTICE 'logestechs_v2_mirror pack missing; skipping short code extract patch';
    RETURN;
  END IF;

  UPDATE public.api_routes r
  SET policy = public.jsonb_deep_merge(
        COALESCE(r.policy, '{}'::jsonb),
        jsonb_build_object(
          'postprocess', jsonb_build_object(
            'extract', jsonb_build_object(
              'origin_short_code_path', 'originAddress.nationalAddress',
              'destination_short_code_path', 'destinationAddress.nationalAddress'
            )
          )
        )
      ),
      updated_at = now()
  WHERE r.pack_id = v_pack_id
    AND upper(r.method) = 'POST'
    AND r.path_template = '/api/ship/request/by-email'
    AND r.scope_type = 'global'
    AND r.enabled = TRUE;
END;
$do$;

COMMIT;
