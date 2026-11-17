-- Migration: jsonb_extract_fields - support array of candidate JSONPaths
-- Purpose:
--   Allow mapping_configs.field_mappings values to be either:
--     - a single JSONPath string (current behaviour), or
--     - an array of JSONPath strings (first match wins).
--   This keeps provider parsing row-driven while enabling safe fallbacks (e.g., HERE province = state OR county).
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - ZERO HARD CODING - SSOT-friendly mappings.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION public.jsonb_extract_fields(
    p_source JSONB,
    p_field_mappings JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_result JSONB := '{}'::JSONB;
    v_key TEXT;
    v_spec JSONB;
    v_path TEXT;
    v_jsonpath TEXT;
    v_value JSONB;
    v_candidate_paths TEXT[];
BEGIN
    IF p_source IS NULL OR p_field_mappings IS NULL THEN
        RETURN '{}'::JSONB;
    END IF;

    FOR v_key, v_spec IN
        SELECT key, value FROM jsonb_each(p_field_mappings)
    LOOP
        v_candidate_paths := ARRAY[]::TEXT[];

        IF jsonb_typeof(v_spec) = 'string' THEN
            v_candidate_paths := ARRAY[trim(both '\"' FROM v_spec::TEXT)];
        ELSIF jsonb_typeof(v_spec) = 'array' THEN
            SELECT COALESCE(array_agg(trim(elem)), ARRAY[]::TEXT[])
              INTO v_candidate_paths
              FROM jsonb_array_elements_text(v_spec) AS elem;
        END IF;

        v_value := NULL;
        FOREACH v_path IN ARRAY v_candidate_paths LOOP
            v_jsonpath := NULLIF(trim(v_path), '');
            IF v_jsonpath IS NULL THEN
                CONTINUE;
            END IF;

            BEGIN
                v_value := jsonb_path_query_first(p_source, v_jsonpath::JSONPATH);
            EXCEPTION
                WHEN OTHERS THEN
                    v_value := NULL;
            END;

            IF v_value IS NULL OR v_value = 'null'::JSONB THEN
                v_value := NULL;
            ELSE
                EXIT;
            END IF;
        END LOOP;

        IF v_value IS NULL THEN
            v_value := 'null'::JSONB;
        END IF;

        v_result := jsonb_set(v_result, ARRAY[v_key], v_value, TRUE);
    END LOOP;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.jsonb_extract_fields(JSONB, JSONB)
    IS 'Apply JSONPath field mappings and return extracted values (supports array of candidate paths; first match wins).';

COMMIT;

