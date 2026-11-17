-- Migration: jsonb_resolve_path multi-path support
-- Purpose:
--   - Allow fallback paths using '|' delimiter (first match wins) for config-driven lookups
--     (e.g., webhook idempotency keys across multiple payload shapes).
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE FUNCTION public.jsonb_resolve_path(
    p_data JSONB,
    p_path TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_candidate TEXT;
    v_candidates TEXT[];
    v_segment TEXT;
    v_segments TEXT[];
    v_cursor JSONB;
BEGIN
    IF p_data IS NULL OR p_path IS NULL OR btrim(p_path) = '' THEN
        RETURN NULL;
    END IF;

    -- Support fallback candidates: "a.b|x.y" (first non-null wins).
    v_candidates := string_to_array(p_path, '|');
    FOREACH v_candidate IN ARRAY v_candidates LOOP
        v_candidate := btrim(v_candidate);
        IF v_candidate IS NULL OR v_candidate = '' THEN
            CONTINUE;
        END IF;

        v_cursor := p_data;
        v_segments := string_to_array(v_candidate, '.');
        FOREACH v_segment IN ARRAY v_segments LOOP
            IF v_cursor IS NULL OR v_cursor = 'null'::jsonb THEN
                v_cursor := NULL;
                EXIT;
            END IF;

            IF jsonb_typeof(v_cursor) = 'array' THEN
                BEGIN
                    v_cursor := v_cursor->(v_segment::INT);
                EXCEPTION
                    WHEN invalid_text_representation THEN
                        v_cursor := NULL;
                        EXIT;
                END;
            ELSE
                v_cursor := v_cursor->v_segment;
            END IF;
        END LOOP;

        IF v_cursor IS NULL OR v_cursor = 'null'::jsonb THEN
            CONTINUE;
        END IF;

        RETURN v_cursor;
    END LOOP;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.jsonb_resolve_path(JSONB, TEXT)
    IS 'Resolve dot-delimited path (array segments allowed) within a JSONB document; supports fallback candidates separated by | (first non-null wins).';

COMMIT;

