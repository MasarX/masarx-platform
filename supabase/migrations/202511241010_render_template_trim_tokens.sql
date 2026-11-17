-- Migration: render_template token trimming
-- Purpose: Ensure {{ token }} placeholders ignore surrounding whitespace so JSON paths resolve correctly.
-- Date: 2025-11-24

BEGIN;

CREATE OR REPLACE FUNCTION public.render_template(
    p_template JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
    v_result JSONB;
    v_entry RECORD;
    v_text TEXT;
    v_matches TEXT[];
    v_token TEXT;
    v_value JSONB;
    v_replacement TEXT;
    v_rendered TEXT;
BEGIN
    IF p_template IS NULL THEN
        RETURN NULL;
    END IF;

    IF jsonb_typeof(p_template) = 'object' THEN
        v_result := '{}'::jsonb;
        FOR v_entry IN SELECT key, value FROM jsonb_each(p_template) LOOP
            v_result := jsonb_set(
                v_result,
                ARRAY[v_entry.key],
                render_template(v_entry.value, p_context),
                TRUE
            );
        END LOOP;
        RETURN v_result;
    ELSIF jsonb_typeof(p_template) = 'array' THEN
        v_result := '[]'::jsonb;
        FOR v_entry IN
            SELECT value, ordinality
            FROM jsonb_array_elements(p_template) WITH ORDINALITY AS arr(value, ordinality)
        LOOP
            v_result := v_result || jsonb_build_array(render_template(v_entry.value, p_context));
        END LOOP;
        RETURN v_result;
    ELSIF jsonb_typeof(p_template) = 'string' THEN
        v_text := trim(both '"' FROM p_template::TEXT);
        IF position('{{' IN v_text) = 0 THEN
            RETURN to_jsonb(v_text);
        END IF;

        v_rendered := v_text;
        FOR v_matches IN SELECT regexp_matches(v_text, '\{\{\s*([^}]+)\s*\}\}', 'g') LOOP
            v_token := btrim(v_matches[1]);
            v_value := jsonb_resolve_path(p_context, v_token);
            IF v_value IS NULL OR v_value::TEXT = 'null' THEN
                v_replacement := '';
            ELSIF jsonb_typeof(v_value) IN ('object', 'array') THEN
                v_replacement := v_value::TEXT;
            ELSE
                v_replacement := trim(both '"' FROM v_value::TEXT);
            END IF;
            v_rendered := regexp_replace(
                v_rendered,
                '\{\{\s*' || regexp_replace(v_token, '([\\\^\$\.\|\?\*\+\(\)\[\{\]])', '\\\1', 'g') || '\s*\}\}',
                v_replacement,
                'g'
            );
        END LOOP;

        RETURN to_jsonb(v_rendered);
    END IF;

    RETURN p_template;
END;
$function$;

COMMENT ON FUNCTION public.render_template(JSONB, JSONB)
    IS 'Render JSON template replacing {{tokens}} using dot-path lookups within context (whitespace tolerant).';

COMMIT;
