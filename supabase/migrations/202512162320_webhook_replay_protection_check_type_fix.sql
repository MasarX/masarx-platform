-- Migration: Webhook replay protection check (type fix)
-- Purpose: Fix db-lint type error when inserting webhook_source_id into webhook_nonce_dedupe.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow/row-driven - ZERO HARD CODING.
-- Date: 2025-12-16

BEGIN;

CREATE OR REPLACE FUNCTION public.webhook_replay_protection_check(
    p_webhook_source_id UUID,
    p_headers JSONB,
    p_payload JSONB,
    p_config JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
    v_config JSONB := COALESCE(p_config, '{}'::jsonb);
    v_enabled BOOLEAN := COALESCE((v_config->>'enabled')::BOOLEAN, FALSE);
    v_headers JSONB := normalize_headers(COALESCE(p_headers, '{}'::jsonb));
    v_nonce_header TEXT := COALESCE(v_config->>'nonce_header', '');
    v_nonce_path TEXT := COALESCE(
        NULLIF(v_config->>'nonce_jsonpath', ''),
        NULLIF(v_config->>'nonce_path', ''),
        NULLIF(v_config->>'nonce_value_path', '')
    );
    v_window_seconds INTEGER := COALESCE((v_config->>'dedupe_window_seconds')::INTEGER, 3600);
    v_nonce TEXT;
    v_dedupe_key TEXT;
    v_now TIMESTAMPTZ := now();
    v_expires_at TIMESTAMPTZ;
    v_inserted BOOLEAN;
BEGIN
    IF NOT v_enabled THEN
        RETURN jsonb_build_object('enabled', FALSE, 'replayed', FALSE);
    END IF;

    v_window_seconds := LEAST(GREATEST(COALESCE(v_window_seconds, 3600), 0), 86400 * 30);
    v_expires_at := v_now + make_interval(secs => v_window_seconds);

    IF v_nonce_header IS NOT NULL AND btrim(v_nonce_header) <> '' THEN
        v_nonce := NULLIF(v_headers->>lower(v_nonce_header), '');
    END IF;

    IF v_nonce IS NULL AND v_nonce_path IS NOT NULL AND btrim(v_nonce_path) <> '' THEN
        BEGIN
            v_nonce := safe_jsonpath_query_first(COALESCE(p_payload, '{}'::jsonb), v_nonce_path)::TEXT;
            v_nonce := NULLIF(trim(both '\"' FROM v_nonce), '');
        EXCEPTION
            WHEN undefined_function THEN
                v_nonce := NULL;
            WHEN OTHERS THEN
                v_nonce := NULL;
        END;
    END IF;

    IF v_nonce IS NULL OR v_nonce = '' THEN
        RETURN jsonb_build_object(
            'enabled', TRUE,
            'replayed', FALSE,
            'ok', FALSE,
            'reason', 'missing_nonce'
        );
    END IF;

    v_dedupe_key := encode(digest(v_nonce, 'sha256'), 'hex');

    PERFORM public.cleanup_expired_webhook_nonce_dedupe(200);

    DELETE FROM public.webhook_nonce_dedupe
    WHERE webhook_source_id = p_webhook_source_id
      AND expires_at < v_now;

    INSERT INTO public.webhook_nonce_dedupe (webhook_source_id, dedupe_key, created_at, expires_at)
    VALUES (p_webhook_source_id, v_dedupe_key, v_now, v_expires_at)
    ON CONFLICT (webhook_source_id, dedupe_key) DO NOTHING
    RETURNING TRUE INTO v_inserted;

    IF v_inserted IS NULL THEN
        RETURN jsonb_build_object(
            'enabled', TRUE,
            'replayed', TRUE,
            'dedupe_key', v_dedupe_key,
            'status', 409,
            'reason', 'replay_detected'
        );
    END IF;

    RETURN jsonb_build_object(
        'enabled', TRUE,
        'replayed', FALSE,
        'dedupe_key', v_dedupe_key,
        'expires_at', v_expires_at,
        'dedupe_window_seconds', v_window_seconds
    );
END;
$$;

COMMIT;

