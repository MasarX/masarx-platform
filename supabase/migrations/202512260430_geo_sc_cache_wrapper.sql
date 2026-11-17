-- Migration: Geocode cache wrapper - remove hardcoded country default for registry normalization
-- Purpose:
--   - When normalizing short-code registry keys to ISO2, derive the ISO2 country from:
--       1) addresses.country (preferred), else
--       2) matching_plugins.short_code.params.country (policy gate)
--     instead of hardcoding 'SA'.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow-driven - ZERO HARD CODING.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geocode_cache_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_response workflow_handler_response;
    v_registry_id UUID := NULL;
    v_fixed_id UUID := NULL;
    v_ctx RECORD;
    v_country_iso2 TEXT := NULL;
    v_row RECORD;
    v_policy JSONB := '{}'::jsonb;
    v_short_plugin JSONB := NULL;
    v_short_params JSONB := '{}'::jsonb;
    v_code_type TEXT := 'sa_short_code';
    v_registry_ttl INT := 0;
    v_registry_ttl_raw TEXT := NULL;
    v_registry_expires_at TIMESTAMPTZ := NULL;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

    v_response := workflow_handlers.execute_geocode_cache_v1_base(
        p_step,
        p_run,
        p_operation_result
    );

    v_registry_id := NULLIF(v_response.operation_result->>'short_code_registry_id', '')::uuid;
    IF v_registry_id IS NULL THEN
        RETURN v_response;
    END IF;

    v_policy := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_short_plugin := workflow_handlers.geocoding_get_plugin(v_policy, 'short_code');
    v_short_params := COALESCE(v_short_plugin->'params', '{}'::jsonb);
    v_code_type := COALESCE(NULLIF(v_short_params->>'code_type', ''), v_code_type);

    v_registry_ttl_raw := NULLIF(v_short_params->>'registry_ttl_minutes', '');
    BEGIN
        v_registry_ttl := COALESCE(v_registry_ttl_raw::INT, 0);
    EXCEPTION
        WHEN OTHERS THEN
            v_registry_ttl := 0;
    END;

    v_registry_ttl := GREATEST(v_registry_ttl, 0);
    v_registry_expires_at := CASE
        WHEN v_registry_ttl > 0 THEN now() + make_interval(mins => v_registry_ttl)
        ELSE NULL
    END;

    -- Use the address country as the canonical key for registry scoping (ISO2).
    SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);
    IF v_ctx.address_id IS NULL OR v_ctx.client_id IS NULL THEN
        RETURN v_response;
    END IF;

    SELECT upper(COALESCE(NULLIF(a.country, ''), NULLIF(v_short_params->>'country', ''))) AS country_code
    INTO v_country_iso2
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id
      AND a.client_id = v_ctx.client_id
    LIMIT 1;

    IF v_country_iso2 IS NULL OR length(v_country_iso2) <> 2 THEN
        RETURN v_response;
    END IF;

    SELECT
      r.country_code,
      r.code_type,
      r.code_value,
      r.coordinates,
      r.formatted_address,
      r.street,
      r.house_number,
      r.district,
      r.city,
      r.province,
      r.postal_code,
      r.provider_name,
      r.confidence_score,
      r.accuracy_type,
      r.provider_parsed,
      r.expires_at
    INTO v_row
    FROM public.address_code_registry r
    WHERE r.id = v_registry_id
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN v_response;
    END IF;

    -- Guard: only mutate short-code registry rows (policy-driven code_type).
    IF lower(COALESCE(NULLIF(v_row.code_type, ''), '')) <> lower(v_code_type) THEN
        RETURN v_response;
    END IF;

    IF upper(COALESCE(NULLIF(v_row.country_code, ''), '')) = v_country_iso2
       AND v_row.expires_at IS NOT DISTINCT FROM v_registry_expires_at THEN
        RETURN v_response;
    END IF;

    -- If country is already ISO2, only enforce registry TTL.
    IF upper(COALESCE(NULLIF(v_row.country_code, ''), '')) = v_country_iso2 THEN
        UPDATE public.address_code_registry
        SET expires_at = v_registry_expires_at,
            updated_at = now()
        WHERE id = v_registry_id;
        RETURN v_response;
    END IF;

    -- Country mismatch: upsert/de-duplicate the registry row to ISO2 and enforce TTL.
    INSERT INTO public.address_code_registry (
      country_code,
      code_type,
      code_value,
      coordinates,
      formatted_address,
      street,
      house_number,
      district,
      city,
      province,
      postal_code,
      provider_name,
      confidence_score,
      accuracy_type,
      provider_parsed,
      resolved_at,
      expires_at,
      created_at,
      updated_at
    )
    VALUES (
      v_country_iso2,
      v_row.code_type,
      v_row.code_value,
      v_row.coordinates,
      v_row.formatted_address,
      v_row.street,
      v_row.house_number,
      v_row.district,
      v_row.city,
      v_row.province,
      v_row.postal_code,
      v_row.provider_name,
      v_row.confidence_score,
      v_row.accuracy_type,
      COALESCE(v_row.provider_parsed, '{}'::jsonb),
      now(),
      v_registry_expires_at,
      now(),
      now()
    )
    ON CONFLICT (country_code, code_type, code_value) DO UPDATE
    SET
      coordinates = EXCLUDED.coordinates,
      formatted_address = COALESCE(EXCLUDED.formatted_address, address_code_registry.formatted_address),
      street = COALESCE(EXCLUDED.street, address_code_registry.street),
      house_number = COALESCE(EXCLUDED.house_number, address_code_registry.house_number),
      district = COALESCE(EXCLUDED.district, address_code_registry.district),
      city = COALESCE(EXCLUDED.city, address_code_registry.city),
      province = COALESCE(EXCLUDED.province, address_code_registry.province),
      postal_code = COALESCE(EXCLUDED.postal_code, address_code_registry.postal_code),
      provider_name = COALESCE(EXCLUDED.provider_name, address_code_registry.provider_name),
      confidence_score = COALESCE(EXCLUDED.confidence_score, address_code_registry.confidence_score),
      accuracy_type = COALESCE(EXCLUDED.accuracy_type, address_code_registry.accuracy_type),
      provider_parsed = COALESCE(EXCLUDED.provider_parsed, address_code_registry.provider_parsed),
      resolved_at = now(),
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
    RETURNING id INTO v_fixed_id;

    IF v_fixed_id IS NOT NULL AND v_fixed_id <> v_registry_id THEN
      DELETE FROM public.address_code_registry WHERE id = v_registry_id;
      v_response.operation_result := jsonb_set(
        COALESCE(v_response.operation_result, '{}'::jsonb),
        '{short_code_registry_id}',
        to_jsonb(v_fixed_id::text),
        TRUE
      );
    END IF;

    RETURN v_response;
END;
$$;

ALTER FUNCTION workflow_handlers.execute_geocode_cache_v1(workflow_run_steps, workflow_runs, jsonb)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geocode_cache_v1(workflow_run_steps, workflow_runs, JSONB)
  IS 'Geocoding cache read/write handler (policy-driven TTL, logging) with SSOT short-code registry upsert normalized to ISO2 country keys and registry TTL enforced via policy (registry_ttl_minutes, safe-parse) and without hardcoded country defaults.';

COMMIT;

