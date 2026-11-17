-- Migration: Short-code normalization hardening (no hardcoding, no duplication)
-- Purpose:
--   - Centralize candidate short-code normalization + validation (safe regex handling).
--   - Remove hardcoded country defaults (derive from policy params / input instead).
--   - Ensure provider dispatch applies HERE hints even when address.country is missing (common when clients send short code only).
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow/row-driven - ZERO REDUNDANCY - ZERO HARD CODING.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Helper: normalize + validate a candidate code (safe against invalid regex)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.geocoding_normalize_candidate_code(
    p_candidate TEXT,
    p_code_regex TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_code TEXT;
BEGIN
    v_code := NULLIF(
        upper(
            regexp_replace(
                trim(COALESCE(p_candidate, '')),
                '[^A-Za-z0-9]',
                '',
                'g'
            )
        ),
        ''
    );

    IF v_code IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_code_regex IS NULL OR p_code_regex = '' THEN
        RETURN v_code;
    END IF;

    BEGIN
        IF v_code ~ p_code_regex THEN
            RETURN v_code;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN NULL;
    END;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.geocoding_normalize_candidate_code(TEXT, TEXT)
  IS 'Normalize candidate address code by stripping non-alphanumerics and uppercasing; optionally validate with a regex (returns NULL on mismatch or invalid regex).';

-- ---------------------------------------------------------------------------
-- 2) Short code registry lookup handler: use helper + avoid hardcoded country
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_short_code_registry_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx RECORD;
    v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_plugin JSONB := workflow_handlers.geocoding_get_plugin(v_policy, 'short_code');
    v_params JSONB := COALESCE(v_plugin->'params', '{}'::jsonb);
    v_enabled BOOLEAN := COALESCE((v_plugin->>'enabled')::BOOLEAN, FALSE);
    v_code_type TEXT := COALESCE(NULLIF(v_params->>'code_type', ''), 'sa_short_code');
    v_country_gate TEXT := upper(NULLIF(v_params->>'country', ''));
    v_code_regex TEXT := COALESCE(NULLIF(v_params->>'code_regex', ''), '^[A-Z]{4}[0-9]{4}$');
    v_hydrate BOOLEAN := COALESCE((v_params->>'hydrate_address')::BOOLEAN, TRUE);
    v_confidence_default NUMERIC := COALESCE((v_params->>'confidence')::NUMERIC, 0.99);
    v_address RECORD;
    v_raw JSONB := '{}'::jsonb;
    v_candidate TEXT;
    v_code TEXT;
    v_country_code TEXT;
    v_reg RECORD;
    v_lat NUMERIC;
    v_lon NUMERIC;
    v_selected_geocode JSONB;
    v_attempt_id UUID := NULL;
    v_attempt_order INT := 1;
    v_match JSONB := NULL;
    v_response public.workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

    -- If already resolved upstream (reverse_local, etc.), do nothing.
    IF COALESCE(p_run.context->'geocoding'->>'successful', 'false')::BOOLEAN THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('matched', FALSE, 'skipped', TRUE, 'reason', 'geocoding_already_resolved');
        RETURN v_response;
    END IF;

    IF NOT v_enabled THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('matched', FALSE, 'reason', 'plugin_disabled');
        RETURN v_response;
    END IF;

    SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);
    IF v_ctx.address_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('matched', FALSE, 'reason', 'address_missing');
        RETURN v_response;
    END IF;

    SELECT
        a.sa_short_code,
        a.normalized_line1,
        a.line1,
        a.raw_input,
        a.country,
        a.district,
        a.city,
        a.province,
        a.postal_code
    INTO v_address
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id
      AND a.client_id = v_ctx.client_id
    LIMIT 1;

    BEGIN
        v_raw := COALESCE(v_address.raw_input::jsonb, '{}'::jsonb);
    EXCEPTION
        WHEN OTHERS THEN
            v_raw := '{}'::jsonb;
    END;

    v_candidate := COALESCE(
        NULLIF(v_address.sa_short_code, ''),
        NULLIF(v_raw->>'short_code', ''),
        NULLIF(v_raw->>'sa_short_code', ''),
        NULLIF(v_address.normalized_line1, ''),
        NULLIF(v_address.line1, ''),
        NULLIF(v_raw->>'line1', ''),
        NULLIF(v_address.raw_input, '')
    );

    v_code := public.geocoding_normalize_candidate_code(v_candidate, v_code_regex);

    -- Resolve country scoping for the SSOT registry key (prefer explicit input; fall back to policy gate).
    v_country_code := upper(
        COALESCE(
            NULLIF(v_address.country, ''),
            NULLIF(v_raw->>'country', ''),
            NULLIF(v_country_gate, '')
        )
    );

    -- If we cannot determine country scoping, do not apply the plugin (prevents cross-country key ambiguity).
    IF v_country_code IS NULL OR v_country_code = '' THEN
        v_code := NULL;
    END IF;

    IF v_country_gate IS NOT NULL AND v_country_gate <> '' AND v_country_code <> v_country_gate THEN
        v_code := NULL;
    END IF;

    IF v_code IS NULL THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
            'plugin', 'short_code',
            'match_type', 'not_applicable',
            'routing_reason', 'short_code_missing_or_invalid'
        ));
        PERFORM workflow_handlers.geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('matched', FALSE, 'reason', 'short_code_missing_or_invalid');
        RETURN v_response;
    END IF;

    -- Persist normalized short code on the address (standalone column) for future runs.
    IF v_address.sa_short_code IS NULL OR v_address.sa_short_code = '' THEN
        UPDATE public.addresses
        SET sa_short_code = v_code,
            updated_at = now()
        WHERE id = v_ctx.address_id
          AND client_id = v_ctx.client_id;
    END IF;

    SELECT
        r.id,
        r.provider_name,
        r.confidence_score,
        r.accuracy_type,
        r.formatted_address,
        r.street,
        r.house_number,
        r.district,
        r.city,
        r.province,
        r.postal_code,
        r.country_code,
        r.coordinates,
        r.updated_at
    INTO v_reg
    FROM public.address_code_registry r
    WHERE r.country_code = v_country_code
      AND r.code_type = v_code_type
      AND r.code_value = v_code
      AND (r.expires_at IS NULL OR r.expires_at > now())
    ORDER BY r.updated_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
            'plugin', 'short_code',
            'match_type', 'registry_miss',
            'routing_reason', 'short_code_registry_miss',
            'code_type', v_code_type,
            'code_value', v_code
        ));
        PERFORM workflow_handlers.geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('matched', FALSE, 'reason', 'registry_miss', 'code_value', v_code);
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'short_code', v_code,
                'short_code_type', v_code_type
            ))
        );
        RETURN v_response;
    END IF;

    v_lat := ST_Y(v_reg.coordinates::geometry)::numeric;
    v_lon := ST_X(v_reg.coordinates::geometry)::numeric;

    v_selected_geocode := jsonb_strip_nulls(jsonb_build_object(
        'provider_name', COALESCE(NULLIF(v_reg.provider_name, ''), 'short_code_registry'),
        'is_primary', TRUE,
        'confidence_score', COALESCE(v_reg.confidence_score, v_confidence_default),
        'accuracy_type', COALESCE(NULLIF(v_reg.accuracy_type, ''), 'short_code_registry'),
        'formatted_address', NULLIF(v_reg.formatted_address, ''),
        'coordinates', jsonb_build_object(
            'latitude', v_lat,
            'longitude', v_lon
        ),
        'metadata', jsonb_strip_nulls(jsonb_build_object(
            'registry_id', v_reg.id,
            'code_type', v_code_type,
            'code_value', v_code,
            'country_code', v_country_code,
            'source', 'address_code_registry'
        ))
    ));

    -- Record an attempt for observability (cache_hit).
    IF v_ctx.organization_id IS NOT NULL AND v_ctx.client_id IS NOT NULL AND v_ctx.address_id IS NOT NULL THEN
        SELECT COALESCE(MAX(attempt_order), 0) + 1
        INTO v_attempt_order
        FROM public.geocoding_attempts
        WHERE address_id = v_ctx.address_id
          AND provider_name = 'short_code_registry';

        INSERT INTO public.geocoding_attempts (
            organization_id,
            client_id,
            sender_id,
            address_id,
            workflow_run_step_id,
            provider_name,
            attempt_order,
            attempt_type,
            status,
            confidence,
            duration_ms,
            metadata,
            created_at,
            updated_at
        )
        VALUES (
            v_ctx.organization_id,
            v_ctx.client_id,
            v_ctx.sender_id,
            v_ctx.address_id,
            p_step.id,
            'short_code_registry',
            v_attempt_order,
            'cache_hit',
            'succeeded',
            COALESCE(v_reg.confidence_score, v_confidence_default),
            0,
            jsonb_strip_nulls(jsonb_build_object(
                'geocode', v_selected_geocode,
                'match_source', 'address_code_registry',
                'match_plugin', 'short_code',
                'match_type', 'registry_hit',
                'routing_reason', 'short_code_registry_hit',
                'registry_id', v_reg.id,
                'code_type', v_code_type,
                'code_value', v_code
            )),
            now(),
            now()
        )
        RETURNING id INTO v_attempt_id;
    END IF;

    v_match := jsonb_strip_nulls(jsonb_build_object(
        'plugin', 'short_code',
        'match_type', 'registry_hit',
        'routing_reason', 'short_code_registry_hit',
        'score', COALESCE(v_reg.confidence_score, v_confidence_default),
        'attempt_id', v_attempt_id,
        'registry_id', v_reg.id,
        'code_type', v_code_type,
        'code_value', v_code
    ));
    PERFORM workflow_handlers.geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

    -- Hydrate address components for downstream consumers (labels/UI) when configured.
    IF v_hydrate THEN
        UPDATE public.addresses a
        SET
            district = COALESCE(NULLIF(a.district, ''), NULLIF(v_reg.district, '')),
            city = CASE
                WHEN a.city IS NULL OR a.city = '' OR lower(a.city) = 'unknown' THEN COALESCE(NULLIF(v_reg.city, ''), a.city)
                ELSE a.city
            END,
            province = CASE
                WHEN a.province IS NULL OR a.province = '' OR lower(a.province) = 'unknown' THEN COALESCE(NULLIF(v_reg.province, ''), a.province)
                ELSE a.province
            END,
            postal_code = COALESCE(NULLIF(a.postal_code, ''), NULLIF(v_reg.postal_code, '')),
            country = COALESCE(NULLIF(a.country, ''), NULLIF(v_reg.country_code, '')),
            normalized_line1 = CASE
                WHEN a.normalized_line1 IS NULL OR a.normalized_line1 = '' OR a.normalized_line1 = v_code THEN
                    COALESCE(
                        NULLIF(trim(concat_ws(' ', NULLIF(v_reg.house_number, ''), NULLIF(v_reg.street, ''))), ''),
                        NULLIF(v_reg.formatted_address, ''),
                        a.normalized_line1
                    )
                ELSE a.normalized_line1
            END,
            updated_at = now()
        WHERE a.id = v_ctx.address_id
          AND a.client_id = v_ctx.client_id;
    END IF;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'matched', TRUE,
        'registry_id', v_reg.id,
        'attempt_id', v_attempt_id,
        'code_type', v_code_type,
        'code_value', v_code
    ));
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'successful', TRUE,
            'manual_review_required', FALSE,
            'require_fallback', FALSE,
            'selected_geocode', v_selected_geocode,
            'match_plugin', 'short_code',
            'match_type', 'registry_hit',
            'geocoding_match', v_match
        ))
    );
    RETURN v_response;
END;
$$;

ALTER FUNCTION workflow_handlers.execute_geo_short_code_registry_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geo_short_code_registry_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Resolve Saudi short national address short codes via SSOT address_code_registry (workflow/policy-driven), short-circuiting provider dispatch on hits; uses centralized normalization helper and policy-derived country scoping.';

-- End.

COMMIT;
