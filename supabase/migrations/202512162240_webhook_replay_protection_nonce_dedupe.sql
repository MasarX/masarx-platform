-- Migration: Webhook replay protection primitives (nonce dedupe)
-- Purpose: Ensure webhook intake replay protection helpers are present and db-lint clean.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow/row-driven - ZERO HARD CODING.
-- Date: 2025-12-16

BEGIN;

CREATE TABLE IF NOT EXISTS public.webhook_nonce_dedupe (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_source_id UUID NOT NULL REFERENCES public.webhook_sources(id) ON DELETE CASCADE,
    dedupe_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- Harden against drift: the CI database may already contain a legacy
-- webhook_nonce_dedupe table with an older/partial schema. Ensure required
-- columns exist before creating indexes or referencing them from functions.
ALTER TABLE public.webhook_nonce_dedupe
    ADD COLUMN IF NOT EXISTS webhook_source_id UUID;
ALTER TABLE public.webhook_nonce_dedupe
    ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE public.webhook_nonce_dedupe
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.webhook_nonce_dedupe
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- This table is a best-effort dedupe cache; remove unusable/duplicate rows so
-- the unique index can be created deterministically even when legacy data is present.
DELETE FROM public.webhook_nonce_dedupe
WHERE dedupe_key IS NULL OR dedupe_key = '';

WITH ranked AS (
    SELECT
        ctid,
        row_number() OVER (
            PARTITION BY webhook_source_id, dedupe_key
            ORDER BY expires_at DESC NULLS LAST, created_at DESC NULLS LAST, ctid DESC
        ) AS rn
    FROM public.webhook_nonce_dedupe
)
DELETE FROM public.webhook_nonce_dedupe wnd
USING ranked r
WHERE wnd.ctid = r.ctid
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_nonce_dedupe_source_key_uniq
    ON public.webhook_nonce_dedupe (webhook_source_id, dedupe_key);

CREATE INDEX IF NOT EXISTS webhook_nonce_dedupe_expires_at_idx
    ON public.webhook_nonce_dedupe (expires_at);

ALTER TABLE public.webhook_nonce_dedupe ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.webhook_nonce_dedupe FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_nonce_dedupe FROM anon;
REVOKE ALL ON TABLE public.webhook_nonce_dedupe FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_nonce_dedupe TO service_role;
DO $$
BEGIN
  IF to_regrole('edge_webhook_role') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_nonce_dedupe TO edge_webhook_role';
  END IF;
END;
$$;

DROP POLICY IF EXISTS webhook_nonce_dedupe_service_policy ON public.webhook_nonce_dedupe;
CREATE POLICY webhook_nonce_dedupe_service_policy
    ON public.webhook_nonce_dedupe
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

DROP POLICY IF EXISTS webhook_nonce_dedupe_edge_policy ON public.webhook_nonce_dedupe;
DO $$
BEGIN
  IF to_regrole('edge_webhook_role') IS NOT NULL THEN
    EXECUTE 'CREATE POLICY webhook_nonce_dedupe_edge_policy ON public.webhook_nonce_dedupe FOR ALL TO edge_webhook_role USING (TRUE) WITH CHECK (TRUE)';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_webhook_nonce_dedupe(p_limit INTEGER DEFAULT 500)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 50000);
    v_deleted INTEGER := 0;
BEGIN
    WITH doomed AS (
        SELECT ctid
        FROM public.webhook_nonce_dedupe
        WHERE expires_at < now()
        ORDER BY expires_at ASC
        LIMIT v_limit
    )
    DELETE FROM public.webhook_nonce_dedupe wnd
    USING doomed d
    WHERE wnd.ctid = d.ctid;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.cleanup_expired_webhook_nonce_dedupe(INTEGER)
  IS 'Deletes expired webhook nonce dedupe rows (best-effort maintenance).';

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

COMMENT ON FUNCTION public.webhook_replay_protection_check(UUID, JSONB, JSONB, JSONB)
  IS 'Best-effort replay protection using a nonce dedupe key (config-driven); returns JSON evidence for intake logging.';

COMMIT;
