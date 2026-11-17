-- Migration: Restore safe_jsonpath_query_first helper for outbound mappings
-- Date: 2025-11-20 21:16 UTC

BEGIN;

CREATE OR REPLACE FUNCTION public.safe_jsonpath_query_first(
    p_document JSONB,
    p_expression TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_result JSONB;
BEGIN
    IF p_document IS NULL OR p_expression IS NULL OR btrim(p_expression) = '' THEN
        RETURN NULL;
    END IF;

    BEGIN
        v_result := jsonb_path_query_first(p_document, p_expression::jsonpath);
    EXCEPTION
        WHEN others THEN
            v_result := NULL;
    END;

    RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.safe_jsonpath_query_first(JSONB, TEXT)
    IS 'Execute jsonpath query with error trapping; returns NULL when expression fails.';

COMMIT;
