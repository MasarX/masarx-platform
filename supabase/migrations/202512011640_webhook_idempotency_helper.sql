-- Migration: Provide generate_idempotency_key helper used by webhook intake
-- Date: 2025-12-01

BEGIN;

CREATE OR REPLACE FUNCTION public.generate_idempotency_key(
    p_headers JSONB,
    p_payload JSONB,
    p_config JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_key TEXT := NULL;
    v_header TEXT := NULLIF(p_config->>'header', '');
    v_body_path TEXT := NULLIF(p_config->>'body_path', '');
BEGIN
    IF p_config IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_header IS NOT NULL THEN
        v_key := p_headers->>lower(v_header);
    ELSIF v_body_path IS NOT NULL THEN
        v_key := (jsonb_resolve_path(p_payload, v_body_path))::TEXT;
    END IF;

    IF v_key IS NOT NULL THEN
        v_key := NULLIF(btrim(v_key, ' "'), '');
    END IF;

    RETURN v_key;
END;
$$;

COMMIT;
