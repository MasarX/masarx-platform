-- Migration: Schema-qualify apply_request_mappings to use safe_jsonpath helper
-- Date: 2025-11-20 21:17 UTC

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_request_mappings(
    p_base JSONB,
    p_mappings JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_result JSONB := COALESCE(p_base, '{}'::jsonb);
    v_key TEXT;
    v_expr TEXT;
    v_value JSONB;
    v_path TEXT[];
BEGIN
    IF p_mappings IS NULL OR jsonb_typeof(p_mappings) <> 'object' THEN
        RETURN v_result;
    END IF;

    FOR v_key, v_expr IN
        SELECT key, value::TEXT
        FROM jsonb_each_text(p_mappings)
    LOOP
        v_value := public.safe_jsonpath_query_first(p_context, v_expr);
        IF v_value IS NULL THEN
            CONTINUE;
        END IF;

        v_path := string_to_array(v_key, '.');
        v_result := jsonb_set(v_result, v_path, v_value, TRUE);
    END LOOP;

    RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.apply_request_mappings(JSONB, JSONB, JSONB)
    IS 'Merge jsonpath-derived values into request template (headers/body).';

COMMIT;
