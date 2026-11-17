-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S04
-- Migration: Geo AI address component extraction (OpenAI) + workflow step
-- Purpose:
--   - Add an optional, row-driven AI extraction step to derive district/city/country (ISO2)
--     from messy address lines when no short national address is present.
--   - Seed OpenAI provider + operation template per-organization (no hardcoded org IDs).
--   - Route outbound responses via operation_templates.metadata.operation_role='geo_ai_extract'
--     and update addresses + workflow context (SSOT).
--   - Improve short-code candidate normalization to support extraction from messy address lines.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING
-- Date: 2026-01-03

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 0) Schema: geocoding_policy v3 (address_normalization.ai_extract)
-------------------------------------------------------------------------------

WITH base AS (
  SELECT schema, description, examples
  FROM public.schema_registry
  WHERE category = 'geocoding_policy'
    AND is_active = TRUE
  ORDER BY version DESC
  LIMIT 1
),
patched AS (
  SELECT
    jsonb_set(
      base.schema,
      '{properties,address_normalization,properties,ai_extract}',
      jsonb_build_object(
        'type', 'object',
        'additionalProperties', FALSE,
        'required', jsonb_build_array('enabled'),
        'properties', jsonb_build_object(
          'enabled', jsonb_build_object('type', 'boolean'),
          'operation_template_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
          'provider_name', jsonb_build_object('type', 'string', 'minLength', 1),
          'operation_name', jsonb_build_object('type', 'string', 'minLength', 1),
          'fallback_country', jsonb_build_object('type', 'string', 'minLength', 2, 'maxLength', 2),
          'write_fields', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object(
              'type', 'string',
              'enum', jsonb_build_array('district', 'city', 'country')
            )
          ),
          'overwrite_existing', jsonb_build_object('type', 'boolean')
        )
      ),
      TRUE
    ) AS schema,
    base.description,
    base.examples
  FROM base
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'geocoding_policy',
  3,
  patched.schema,
  COALESCE(patched.description, 'geocoding_policy schema') || ' (v3: address_normalization.ai_extract)',
  patched.examples,
  TRUE
FROM patched
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

UPDATE public.schema_registry
SET is_active = CASE WHEN version = 3 THEN TRUE ELSE FALSE END
WHERE category = 'geocoding_policy';

-------------------------------------------------------------------------------
-- 1) Short-code candidate normalization: allow substring extraction
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.geocoding_normalize_candidate_code(
    p_candidate TEXT,
    p_code_regex TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_raw TEXT;
    v_norm TEXT;
    v_search_regex TEXT;
    v_match TEXT;
BEGIN
    v_raw := NULLIF(trim(COALESCE(p_candidate, '')), '');
    IF v_raw IS NULL THEN
        RETURN NULL;
    END IF;

    -- Normalize by stripping non-alphanumerics and uppercasing.
    v_norm := NULLIF(
        upper(
            regexp_replace(
                v_raw,
                '[^A-Za-z0-9]',
                '',
                'g'
            )
        ),
        ''
    );

    IF v_norm IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_code_regex IS NULL OR p_code_regex = '' THEN
        RETURN v_norm;
    END IF;

    -- First: strict validation against the supplied regex.
    BEGIN
        IF v_norm ~ p_code_regex THEN
            RETURN v_norm;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN NULL;
    END;

    -- Second: attempt substring extraction by removing anchors (when present).
    v_search_regex := p_code_regex;
    IF left(v_search_regex, 1) = '^' THEN
        v_search_regex := substr(v_search_regex, 2);
    END IF;
    IF right(v_search_regex, 1) = '$' THEN
        v_search_regex := left(v_search_regex, length(v_search_regex) - 1);
    END IF;

    v_search_regex := NULLIF(v_search_regex, '');
    IF v_search_regex IS NULL THEN
        RETURN NULL;
    END IF;

    BEGIN
        v_match := NULLIF((regexp_match(v_norm, v_search_regex))[1], '');
    EXCEPTION
        WHEN OTHERS THEN
            v_match := NULL;
    END;

    IF v_match IS NULL THEN
        RETURN NULL;
    END IF;

    BEGIN
        IF v_match ~ p_code_regex THEN
            RETURN v_match;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN NULL;
    END;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.geocoding_normalize_candidate_code(TEXT, TEXT)
  IS 'Normalize candidate address code by stripping non-alphanumerics and uppercasing; validates by regex and can extract a matching substring when anchors are present (returns NULL on mismatch or invalid regex).';

-------------------------------------------------------------------------------
-- 2) Mapping config: OpenAI chat completions JSON content
-------------------------------------------------------------------------------

INSERT INTO public.mapping_configs (
    id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes
)
VALUES (
    '99990000-0000-0000-0000-000000240010'::uuid,
    'provider_response',
    'geo_ai::openai_address_extract::v1',
    jsonb_build_object(
        'field_mappings', jsonb_build_object(
            'content', '$.choices[0].message.content',
            'model', '$.model',
            'usage_total_tokens', '$.usage.total_tokens',
            'usage_prompt_tokens', '$.usage.prompt_tokens',
            'usage_completion_tokens', '$.usage.completion_tokens'
        )
    ),
    1,
    'OpenAI chat.completions response mapping for address extraction (content JSON string).'
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    mapping_version = EXCLUDED.mapping_version,
    notes = EXCLUDED.notes,
    updated_at = now();

-------------------------------------------------------------------------------
-- 3) Provider seed: OpenAI provider per organization (no hardcoded org IDs)
-------------------------------------------------------------------------------

INSERT INTO public.providers (
    id,
    organization_id,
    name,
    provider_type,
    enabled,
    priority_rank,
    health_status,
    metadata,
    created_at,
    updated_at
)
SELECT
    gen_random_uuid(),
    o.id,
    'openai',
    'ai',
    TRUE,
    50,
    'unknown',
    jsonb_build_object(
        'base_url', 'https://api.openai.com/v1',
        'description', 'OpenAI API (Geo AI address extraction)'
    ),
    now(),
    now()
FROM public.organizations o
WHERE NOT EXISTS (
    SELECT 1
    FROM public.providers p
    WHERE p.organization_id = o.id
      AND p.name = 'openai'
);

-------------------------------------------------------------------------------
-- 4) Operation template seed: Geo AI extract via OpenAI chat.completions
-------------------------------------------------------------------------------

INSERT INTO public.operation_templates AS ot (
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
    handler_version,
    metadata,
    call_type
)
SELECT
    p.id,
    'geo_ai_extract_address_v1',
    'POST',
    COALESCE(NULLIF(p.metadata->>'base_url', ''), 'https://api.openai.com/v1') || '/chat/completions',
    jsonb_build_object(
        'content-type', 'application/json',
        'accept', 'application/json'
    ),
    jsonb_build_object(
        'model', 'gpt-4o-mini',
        'temperature', 0,
        'response_format', jsonb_build_object('type', 'json_object'),
        'messages', jsonb_build_array(
            jsonb_build_object(
                'role', 'system',
                'content',
                'Extract address components from messy input. Return ONLY a JSON object with keys: country_iso2 (ISO2, uppercase), city, district. Use null when unknown. Never set district equal to city.'
            ),
            jsonb_build_object('role', 'user', 'content', '')
        )
    ),
    jsonb_build_object(
        'body',
        jsonb_build_object(
            'messages.1.content', '$.step.user_prompt'
        )
    ),
    '99990000-0000-0000-0000-000000240010'::uuid,
    20,
    NULL,
    'outbound_http',
    'v1',
    jsonb_build_object(
        'operation_role', 'geo_ai_extract',
        'response_content_path', '$.choices[0].message.content',
        'auth', jsonb_build_object(
            'mode', 'bearer_token_header',
            'auth_type', 'api_key',
            'header', 'authorization',
            'scheme', 'Bearer',
            'credential_key', 'api_key'
        )
    ),
    'provider_api'
FROM public.providers p
WHERE p.name = 'openai'
ON CONFLICT (provider_id, operation_name) DO UPDATE
SET method = EXCLUDED.method,
    url_template = EXCLUDED.url_template,
    headers_template = EXCLUDED.headers_template,
    body_template = EXCLUDED.body_template,
    request_mappings = EXCLUDED.request_mappings,
    mapping_config_id = EXCLUDED.mapping_config_id,
    timeout_seconds = EXCLUDED.timeout_seconds,
    idempotency_key_template = EXCLUDED.idempotency_key_template,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    metadata = EXCLUDED.metadata,
    call_type = EXCLUDED.call_type,
    updated_at = now();

-------------------------------------------------------------------------------
-- 5) Workflow handler: geo_ai_extract (enqueue outbound call; policy-driven)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_ai_extract_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_response public.workflow_handler_response;
    v_ctx RECORD;
    v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_ai JSONB := COALESCE(v_policy->'address_normalization'->'ai_extract', '{}'::jsonb);

    v_enabled BOOLEAN := COALESCE((v_ai->>'enabled')::BOOLEAN, FALSE);
    v_provider_name TEXT := COALESCE(NULLIF(v_ai->>'provider_name', ''), 'openai');
    v_operation_name TEXT := COALESCE(NULLIF(v_ai->>'operation_name', ''), 'geo_ai_extract_address_v1');
    v_operation_template_id UUID := NULL;
    v_fallback_country TEXT := upper(NULLIF(v_ai->>'fallback_country', ''));    

    v_write_fields JSONB := COALESCE(v_ai->'write_fields', '[]'::jsonb);        
    v_overwrite BOOLEAN := COALESCE((v_ai->>'overwrite_existing')::BOOLEAN, FALSE);

    v_has_short_code BOOLEAN := FALSE;
    v_address RECORD;
    v_need BOOLEAN := FALSE;
    v_user_prompt TEXT;
    v_provider_id UUID;
    v_provider_org_id UUID;
    v_template public.operation_templates%ROWTYPE;
    v_step_record public.workflow_run_steps%ROWTYPE;

    v_city_missing BOOLEAN := FALSE;
    v_district_missing BOOLEAN := FALSE;
    v_country_missing BOOLEAN := FALSE;

    v_short_code TEXT := NULLIF(p_run.context->'geocoding'->>'short_code', '');
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', FALSE);

    IF COALESCE(p_run.context->'geocoding'->>'successful', 'false')::BOOLEAN THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'geocoding_already_resolved');
        RETURN v_response;
    END IF;

    IF NOT v_enabled THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'ai_extract_disabled');
        RETURN v_response;
    END IF;

    SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);
    IF v_ctx.address_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'address_missing');
        RETURN v_response;
    END IF;

    SELECT
        NULLIF(a.sa_short_code, '') AS sa_short_code,
        NULLIF(a.normalized_line1, '') AS normalized_line1,
        NULLIF(a.normalized_line2, '') AS normalized_line2,
        NULLIF(a.line1, '') AS line1,
        NULLIF(a.line2, '') AS line2,
        NULLIF(a.district, '') AS district,
        NULLIF(a.city, '') AS city,
        NULLIF(a.country, '') AS country,
        a.raw_input
    INTO v_address
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id
      AND a.client_id = v_ctx.client_id
    LIMIT 1;

    v_has_short_code := (
        v_short_code IS NOT NULL
        OR v_address.sa_short_code IS NOT NULL
    );

    IF v_has_short_code THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'short_code_present');
        RETURN v_response;
    END IF;

    v_city_missing := (v_address.city IS NULL OR lower(v_address.city) = 'unknown');
    v_district_missing := (v_address.district IS NULL OR lower(v_address.district) = 'unknown');
    v_country_missing := (v_address.country IS NULL OR length(v_address.country) <> 2);

    IF v_overwrite THEN
        v_need := TRUE;
    ELSE
        -- Only run when at least one configured field is missing.
        IF jsonb_typeof(v_write_fields) <> 'array' THEN
            v_need := v_city_missing OR v_district_missing OR v_country_missing;
        ELSE
            v_need := (
                (v_city_missing AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_write_fields) e WHERE e = 'city')) OR
                (v_district_missing AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_write_fields) e WHERE e = 'district')) OR
                (v_country_missing AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_write_fields) e WHERE e = 'country'))
            );
        END IF;
    END IF;

    IF NOT v_need THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'fields_already_present');
        RETURN v_response;
    END IF;

    -- Resolve operation template (policy-driven; operation_template_id preferred).
    BEGIN
        v_operation_template_id := NULLIF(v_ai->>'operation_template_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_operation_template_id := NULL;
    END;

    IF v_operation_template_id IS NOT NULL THEN
        SELECT *
        INTO v_template
        FROM public.operation_templates
        WHERE id = v_operation_template_id
        LIMIT 1;

        IF v_template.id IS NULL THEN
            v_response.status := 'completed';
            v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'operation_template_missing', 'operation_template_id', v_operation_template_id);
            RETURN v_response;
        END IF;

        SELECT p.organization_id
        INTO v_provider_org_id
        FROM public.providers p
        WHERE p.id = v_template.provider_id
        LIMIT 1;

        IF v_provider_org_id IS DISTINCT FROM v_ctx.organization_id THEN
            v_response.status := 'completed';
            v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'operation_template_scope_mismatch', 'operation_template_id', v_template.id);
            RETURN v_response;
        END IF;

        IF COALESCE(v_template.metadata->>'operation_role', '') <> 'geo_ai_extract' THEN
            v_response.status := 'completed';
            v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'operation_template_wrong_role', 'operation_template_id', v_template.id);
            RETURN v_response;
        END IF;
    ELSE
        SELECT id
        INTO v_provider_id
        FROM public.providers
        WHERE organization_id = v_ctx.organization_id
          AND name = v_provider_name
        ORDER BY created_at DESC
        LIMIT 1;

        IF v_provider_id IS NULL THEN
            v_response.status := 'completed';
            v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'provider_missing', 'provider_name', v_provider_name);
            RETURN v_response;
        END IF;

        SELECT *
        INTO v_template
        FROM public.operation_templates
        WHERE provider_id = v_provider_id
          AND operation_name = v_operation_name
        ORDER BY updated_at DESC
        LIMIT 1;

        IF v_template.id IS NULL THEN
            v_response.status := 'completed';
            v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'operation_template_missing', 'operation_name', v_operation_name);
            RETURN v_response;
        END IF;
    END IF;

    IF v_fallback_country IS NULL OR length(v_fallback_country) <> 2 THEN
        v_fallback_country := 'SA';
    END IF;

    v_user_prompt := trim(concat_ws(
        E'\n',
        format('address_line: %s', COALESCE(
            NULLIF(trim(concat_ws(' ', v_address.normalized_line1, v_address.normalized_line2)), ''),
            NULLIF(trim(concat_ws(' ', v_address.line1, v_address.line2)), ''),
            ''
        )),
        format('city_hint: %s', COALESCE(v_address.city, '')),
        format('district_hint: %s', COALESCE(v_address.district, '')),
        format('country_hint_iso2: %s', COALESCE(NULLIF(upper(v_address.country), ''), v_fallback_country)),
        format('fallback_country_iso2: %s', v_fallback_country)
    ));

    v_step_record := p_step;
    v_step_record.metadata := jsonb_strip_nulls(
        COALESCE(p_step.metadata, '{}'::jsonb) ||
        jsonb_build_object(
            'operation_template_id', v_template.id::TEXT,
            'user_prompt', v_user_prompt,
            'decision_log_event', COALESCE(p_step.metadata->>'decision_log_event', 'geocoding.ai_extract_address')
        )
    );

    UPDATE public.workflow_run_steps
    SET metadata = v_step_record.metadata,
        updated_at = now()
    WHERE id = p_step.id;

    RETURN workflow_handlers.execute_outbound_http_v1(v_step_record, p_run, p_operation_result);
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_geo_ai_extract_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Geo AI address component extraction step (row-driven via geocoding_policy.address_normalization.ai_extract); enqueues outbound HTTP call when enabled and no short code is present.';

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
    'geo_ai_extract',
    'workflow_handlers',
    'execute_geo_ai_extract_v1',
    '(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Geo AI address component extraction (district/city/country) via operation_templates + outbound_http.',
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

-------------------------------------------------------------------------------
-- 6) Outbound response handler: geo_ai_extract (updates addresses + run.context)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.process_geo_ai_extract_outbound_response_v1(
    p_job public.outbound_calls,
    p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_result JSONB := jsonb_build_object('handled', FALSE);
    v_template_id UUID;
    v_template public.operation_templates%ROWTYPE;
    v_step public.workflow_run_steps%ROWTYPE;
    v_run public.workflow_runs%ROWTYPE;
    v_ctx RECORD;

    v_policy JSONB;
    v_ai JSONB;
    v_overwrite BOOLEAN := FALSE;
    v_write_fields JSONB := '[]'::jsonb;
    v_fallback_country TEXT := NULL;

    v_content_path TEXT;
    v_content_jsonb JSONB;
    v_content_text TEXT;
    v_payload JSONB;

    v_country TEXT;
    v_city TEXT;
    v_district TEXT;

    v_city_norm TEXT;
    v_district_norm TEXT;

    v_updated BOOLEAN := FALSE;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', FALSE);

    BEGIN
        v_template_id := NULLIF(p_job.context->>'operation_template_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_template_id := NULL;
    END;

    IF v_template_id IS NULL THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_template
    FROM public.operation_templates
    WHERE id = v_template_id
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    IF COALESCE(v_template.metadata->>'operation_role', '') <> 'geo_ai_extract' THEN
        RETURN v_result;
    END IF;

    IF p_job.workflow_run_step_id IS NULL THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_step
    FROM public.workflow_run_steps
    WHERE id = p_job.workflow_run_step_id
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_run
    FROM public.workflow_runs
    WHERE id = v_step.workflow_run_id
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_ctx FROM public.geocoding_extract_context(v_run);
    IF v_ctx.address_id IS NULL OR v_ctx.client_id IS NULL OR v_ctx.organization_id IS NULL THEN
        RETURN v_result;
    END IF;

    v_policy := workflow_handlers.geocoding_resolve_policy_for_run(v_run);
    v_ai := COALESCE(v_policy->'address_normalization'->'ai_extract', '{}'::jsonb);
    v_overwrite := COALESCE((v_ai->>'overwrite_existing')::BOOLEAN, FALSE);
    v_write_fields := COALESCE(v_ai->'write_fields', '[]'::jsonb);
    v_fallback_country := upper(NULLIF(v_ai->>'fallback_country', ''));
    IF v_fallback_country IS NULL OR length(v_fallback_country) <> 2 THEN
        v_fallback_country := 'SA';
    END IF;

    v_content_path := COALESCE(NULLIF(v_template.metadata->>'response_content_path', ''), '$.choices[0].message.content');
    v_content_jsonb := public.safe_jsonpath_query_first(p_response, v_content_path);

    IF v_content_jsonb IS NULL OR jsonb_typeof(v_content_jsonb) <> 'string' THEN
        UPDATE public.workflow_runs
        SET context = jsonb_set(
                COALESCE(context, '{}'::jsonb),
                '{geocoding,ai_extract}',
                jsonb_strip_nulls(jsonb_build_object(
                    'status', 'failed',
                    'reason', 'content_missing',
                    'operation_template_id', v_template.id,
                    'outbound_call_id', p_job.id,
                    'response_status_code', p_job.response_status_code,
                    'provider_id', p_job.target_id
                )),
                TRUE
            ),
            updated_at = now()
        WHERE id = v_run.id;

        RETURN jsonb_build_object('handled', TRUE, 'status', 'failed', 'reason', 'content_missing');
    END IF;

    v_content_text := NULLIF(v_content_jsonb #>> '{}', '');

    BEGIN
        v_payload := v_content_text::jsonb;
    EXCEPTION
        WHEN others THEN
            v_payload := NULL;
    END;

    IF v_payload IS NULL OR jsonb_typeof(v_payload) <> 'object' THEN
        UPDATE public.workflow_runs
        SET context = jsonb_set(
                COALESCE(context, '{}'::jsonb),
                '{geocoding,ai_extract}',
                jsonb_strip_nulls(jsonb_build_object(
                    'status', 'failed',
                    'reason', 'invalid_json',
                    'operation_template_id', v_template.id,
                    'outbound_call_id', p_job.id,
                    'response_status_code', p_job.response_status_code
                )),
                TRUE
            ),
            updated_at = now()
        WHERE id = v_run.id;

        RETURN jsonb_build_object('handled', TRUE, 'status', 'failed', 'reason', 'invalid_json');
    END IF;

    v_country := upper(NULLIF(COALESCE(v_payload->>'country_iso2', v_payload->>'country'), ''));
    IF v_country IS NULL OR length(v_country) <> 2 THEN
        v_country := v_fallback_country;
    END IF;

    v_city := NULLIF(COALESCE(v_payload->>'city', v_payload->>'city_name'), '');
    v_district := NULLIF(COALESCE(v_payload->>'district', v_payload->>'district_name'), '');

    v_city_norm := lower(trim(COALESCE(v_city, '')));
    v_district_norm := lower(trim(COALESCE(v_district, '')));
    IF v_city_norm <> '' AND v_city_norm = v_district_norm THEN
        v_district := NULL;
    END IF;

    -- Apply updates to addresses (respect overwrite policy + write_fields).
    UPDATE public.addresses a
    SET
        country = CASE
            WHEN (jsonb_typeof(v_write_fields) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_write_fields) e WHERE e = 'country'))
                 AND v_country IS NOT NULL
                 AND (v_overwrite OR a.country IS NULL OR a.country = '' OR length(a.country) <> 2)
            THEN v_country
            ELSE a.country
        END,
        city = CASE
            WHEN (jsonb_typeof(v_write_fields) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_write_fields) e WHERE e = 'city'))
                 AND v_city IS NOT NULL
                 AND (v_overwrite OR a.city IS NULL OR a.city = '' OR lower(a.city) = 'unknown')
            THEN v_city
            ELSE a.city
        END,
        district = CASE
            WHEN (jsonb_typeof(v_write_fields) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_write_fields) e WHERE e = 'district'))
                 AND v_district IS NOT NULL
                 AND (v_overwrite OR a.district IS NULL OR a.district = '' OR lower(a.district) = 'unknown')
            THEN v_district
            ELSE a.district
        END,
        updated_at = now()
    WHERE a.id = v_ctx.address_id
      AND a.client_id = v_ctx.client_id;

    v_updated := FOUND;

    UPDATE public.workflow_runs
    SET context = jsonb_set(
            COALESCE(context, '{}'::jsonb),
            '{geocoding,ai_extract}',
            jsonb_strip_nulls(jsonb_build_object(
                'status', 'succeeded',
                'updated_address', v_updated,
                'extracted', jsonb_strip_nulls(jsonb_build_object(
                    'country', v_country,
                    'city', v_city,
                    'district', v_district
                )),
                'operation_template_id', v_template.id,
                'outbound_call_id', p_job.id,
                'response_status_code', p_job.response_status_code,
                'latency_ms', p_job.latency_ms
            )),
            TRUE
        ),
        updated_at = now()
    WHERE id = v_run.id;

    RETURN jsonb_build_object('handled', TRUE, 'status', 'succeeded', 'updated_address', v_updated);
END;
$$;

COMMENT ON FUNCTION workflow_handlers.process_geo_ai_extract_outbound_response_v1(public.outbound_calls, JSONB)
  IS 'Process outbound responses for Geo AI extraction templates (operation_role=geo_ai_extract): parse JSON content and update address components + workflow context.';

-------------------------------------------------------------------------------
-- 7) Outbound response router: route geo_ai_extract by operation_role
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.process_outbound_response_v1(
    p_job public.outbound_calls,
    p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_template_id UUID;
    v_template public.operation_templates%ROWTYPE;
BEGIN
    -- API gateway: post-process provider_api calls linked to api_gateway_requests.
    IF p_job.context ? 'api_gateway_request_id' THEN
        RETURN workflow_handlers.process_api_gateway_outbound_response_v1(p_job, p_response);
    END IF;

    -- Comms first: call_type drives comms handling (independent of operation_name).
    IF p_job.call_type IN ('comms_whatsapp', 'comms_sms', 'comms_email', 'comms_voice') THEN
        v_template_id := NULLIF(p_job.context->>'operation_template_id', '')::UUID;
        IF v_template_id IS NOT NULL THEN
            SELECT * INTO v_template
              FROM public.operation_templates ot
             WHERE ot.id = v_template_id;
        END IF;

        IF v_template.id IS NULL THEN
            -- Best-effort fallback to provider-scoped template for response mapping.
            SELECT * INTO v_template
              FROM public.operation_templates ot
             WHERE ot.provider_id = p_job.target_id
               AND ot.call_type = p_job.call_type
             ORDER BY ot.updated_at DESC
             LIMIT 1;
        END IF;

        RETURN workflow_handlers.process_comms_outbound_response_v1(p_job, v_template, p_response);
    END IF;

    -- Geo AI extract: route by operation template role (row-driven, provider-agnostic).
    BEGIN
        v_template_id := NULLIF(p_job.context->>'operation_template_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_template_id := NULL;
    END;

    IF v_template_id IS NOT NULL THEN
        SELECT * INTO v_template
        FROM public.operation_templates
        WHERE id = v_template_id
        LIMIT 1;

        IF FOUND AND COALESCE(v_template.metadata->>'operation_role', '') = 'geo_ai_extract' THEN
            RETURN workflow_handlers.process_geo_ai_extract_outbound_response_v1(p_job, p_response);
        END IF;
    END IF;

    -- Geocoding (and any other future outbound response handlers) are routed through the
    -- dedicated geocoding handler, which returns handled=false for non-geocoding jobs.
    RETURN workflow_handlers.process_geocoding_outbound_response_v1(p_job, p_response);
END;
$$;

-------------------------------------------------------------------------------
-- 8) workflow_geocoding_standard: insert ai_extract_address after short_code_lookup
-------------------------------------------------------------------------------

DO $$
DECLARE
    v_template_id UUID;
    v_short_seq INT;
    v_exists BOOLEAN := FALSE;
    v_step_id UUID := '99990000-0000-0000-0000-000000410020'::uuid;
BEGIN
    SELECT id
      INTO v_template_id
      FROM public.workflow_templates
     WHERE name = 'workflow_geocoding_standard'
     LIMIT 1;

    IF v_template_id IS NULL THEN
        RAISE NOTICE 'workflow_geocoding_standard not found; skipping ai_extract_address insertion';
        RETURN;
    END IF;

    SELECT TRUE
      INTO v_exists
      FROM public.workflow_template_steps
     WHERE workflow_template_id = v_template_id
       AND operation_name = 'ai_extract_address'
     LIMIT 1;

    IF v_exists THEN
        RETURN;
    END IF;

    SELECT sequence_order
      INTO v_short_seq
      FROM public.workflow_template_steps
     WHERE workflow_template_id = v_template_id
       AND operation_name = 'short_code_lookup'
     LIMIT 1;

    IF v_short_seq IS NULL THEN
        RAISE NOTICE 'workflow_geocoding_standard short_code_lookup step not found; skipping ai_extract_address insertion';
        RETURN;
    END IF;

    -- Shift steps after short_code_lookup by +1 (safe uniqueness: use +1000 dance).
    UPDATE public.workflow_template_steps
    SET sequence_order = sequence_order + 1000,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND sequence_order > v_short_seq;

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
    VALUES (
        v_step_id,
        v_template_id,
        v_short_seq + 1,
        'ai_extract_address',
        'geocoding',
        'always',
        'geo_ai_extract',
        'v1',
        jsonb_build_object('decision_log_event', 'geocoding.ai_extract_address'),
        FALSE,
        TRUE
    )
    ON CONFLICT (id) DO UPDATE
    SET workflow_template_id = EXCLUDED.workflow_template_id,
        sequence_order = EXCLUDED.sequence_order,
        operation_name = EXCLUDED.operation_name,
        operation_settings_category = EXCLUDED.operation_settings_category,
        transition_condition = EXCLUDED.transition_condition,
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        metadata = EXCLUDED.metadata,
        manual_action_required = EXCLUDED.manual_action_required,
        enabled = EXCLUDED.enabled,
        updated_at = now();

    UPDATE public.workflow_template_steps
    SET sequence_order = sequence_order - 999,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND sequence_order > v_short_seq + 1000;

    PERFORM public.workflow_refresh_steps_checksum(v_template_id);
END $$;

COMMIT;
