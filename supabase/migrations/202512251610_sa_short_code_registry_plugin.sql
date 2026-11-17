-- Migration: Saudi short-code registry plugin + workflow step + policy seed
-- Purpose:
--   - Add workflow handler that resolves Saudi short national address short codes (ABCD1234)
--     via the system-wide SSOT cache table (public.address_code_registry).
--   - Insert the step into workflow_geocoding_standard (before provider dispatch).
--   - Enable the plugin via geocoding_policy.matching_plugins (row-driven).
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow/row-driven - ZERO HARD CODING - SSOT - RLS enforced.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Handler: geo_short_code_registry (reads address_code_registry; short-circuits)
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

    IF v_candidate IS NOT NULL THEN
        v_code := upper(regexp_replace(trim(v_candidate), '[^A-Za-z0-9]', '', 'g'));
        IF v_code = '' THEN
            v_code := NULL;
        ELSIF v_code_regex IS NOT NULL AND v_code !~ v_code_regex THEN
            v_code := NULL;
        END IF;
    END IF;

    v_country_code := upper(COALESCE(NULLIF(v_address.country, ''), NULLIF(v_raw->>'country', ''), 'SA'));
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
  IS 'Resolve Saudi short national address short codes via SSOT address_code_registry (workflow/policy-driven), short-circuiting provider dispatch on hits.';

INSERT INTO public.operation_handlers AS oh (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    notes,
    doc_url
)
VALUES (
    'geo_short_code_registry',
    'workflow_handlers',
    'execute_geo_short_code_registry_v1',
    '(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Short-code registry lookup (Saudi short national address) using public.address_code_registry SSOT cache.',
    NULL
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- 2) Insert step into workflow_geocoding_standard (before provider dispatch)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_template_id UUID;
    v_step_id UUID := '99990000-0000-0000-0000-000000410011'::UUID;
    v_dispatch_seq INT := NULL;
    v_exists BOOLEAN := FALSE;
BEGIN
    SELECT id INTO v_template_id
    FROM public.workflow_templates
    WHERE name = 'workflow_geocoding_standard'
    LIMIT 1;

    IF v_template_id IS NULL THEN
        RAISE NOTICE 'workflow_geocoding_standard not found; skipping short_code_registry step insert';
        RETURN;
    END IF;

    SELECT TRUE INTO v_exists
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'short_code_lookup'
    LIMIT 1;

    IF NOT v_exists THEN
        SELECT sequence_order
        INTO v_dispatch_seq
        FROM public.workflow_template_steps
        WHERE workflow_template_id = v_template_id
          AND operation_name = 'dispatch_provider'
        ORDER BY sequence_order
        LIMIT 1;

        v_dispatch_seq := COALESCE(v_dispatch_seq, 999);

        -- Insert before dispatch_provider (shift steps at/after dispatch_provider by +1).
        UPDATE public.workflow_template_steps
        SET sequence_order = sequence_order + 1
        WHERE workflow_template_id = v_template_id
          AND sequence_order >= v_dispatch_seq;

        INSERT INTO public.workflow_template_steps (
            id,
            workflow_template_id,
            sequence_order,
            operation_name,
            operation_settings_category,
            transition_condition,
            handler_key,
            handler_version,
            metadata,
            manual_action_required,
            enabled
        )
        SELECT
            v_step_id,
            v_template_id,
            v_dispatch_seq,
            'short_code_lookup',
            'geocoding',
            'always',
            'geo_short_code_registry',
            'v1',
            jsonb_build_object('decision_log_event', 'geocoding.short_code_lookup'),
            FALSE,
            TRUE
        ON CONFLICT (id) DO UPDATE
        SET sequence_order = EXCLUDED.sequence_order,
            metadata = EXCLUDED.metadata,
            updated_at = now();
    END IF;

    -- Recompute steps_checksum for audit parity
    WITH ordered_steps AS (
        SELECT
            sequence_order,
            jsonb_build_object(
                'sequence_order', sequence_order,
                'operation_name', operation_name,
                'handler_key', handler_key,
                'handler_version', handler_version,
                'metadata', COALESCE(metadata, '{}'::jsonb)
            ) AS payload
        FROM public.workflow_template_steps
        WHERE workflow_template_id = v_template_id
        ORDER BY sequence_order
    ),
    hashed AS (
        SELECT md5(coalesce(jsonb_agg(payload ORDER BY sequence_order)::text, '')) AS checksum
        FROM ordered_steps
    )
    UPDATE public.workflow_templates wt
    SET steps_checksum = hashed.checksum,
        updated_at = now()
    FROM hashed
    WHERE wt.id = v_template_id;
END
$$;

-- ---------------------------------------------------------------------------
-- 3) Enable plugin in global geocoding_policy.matching_plugins (row-driven)
-- ---------------------------------------------------------------------------
WITH base AS (
  SELECT
    sv.id AS settings_version_id,
    sv.value AS policy,
    s.id AS settings_id
  FROM public.settings_versions sv
  JOIN public.settings s ON s.settings_version_id = sv.id
  WHERE sv.category = 'geocoding_policy'
    AND sv.scope_type = 'global'
  ORDER BY sv.version DESC
  LIMIT 1
),
patched AS (
  SELECT
    settings_version_id,
    settings_id,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(policy->'matching_plugins', '[]'::jsonb)) elem
        WHERE lower(elem->>'name') = 'short_code'
      ) THEN policy
      ELSE jsonb_set(
        policy,
        '{matching_plugins}',
        COALESCE(policy->'matching_plugins', '[]'::jsonb) || jsonb_build_array(
          jsonb_build_object(
            'name', 'short_code',
            'enabled', true,
            'params', jsonb_build_object(
              'code_type', 'sa_short_code',
              'country', 'SA',
              'code_regex', '^[A-Z]{4}[0-9]{4}$',
              'hydrate_address', true,
              'confidence', 0.99
            )
          )
        ),
        true
      )
    END AS patched_policy
  FROM base
)
UPDATE public.settings_versions sv
SET value = p.patched_policy,
    change_reason = COALESCE(sv.change_reason, '') || ' + add short_code plugin'
FROM patched p
WHERE sv.id = p.settings_version_id
  AND sv.value IS DISTINCT FROM p.patched_policy;

WITH latest AS (
  SELECT
    s.id AS settings_id,
    sv.value AS policy
  FROM public.settings_versions sv
  JOIN public.settings s ON s.settings_version_id = sv.id
  WHERE sv.category = 'geocoding_policy'
    AND sv.scope_type = 'global'
  ORDER BY sv.version DESC
  LIMIT 1
)
UPDATE public.settings s
SET cached_value = latest.policy,
    last_updated = now()
FROM latest
WHERE s.id = latest.settings_id;

COMMIT;
