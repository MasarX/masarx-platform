-- Migration: Autonomous edge dispatch for outbound calls
-- Purpose: Make outbound HTTP processing fully autonomous by:
--   1) Scheduling run_outbound_worker() via pg_cron to convert 'pending' → 'pending_edge'.
--   2) Adding run_api_caller_batch() to POST to the api-caller Edge Function using public.call_api (pg_net),
--      with headers resolved from configuration tables (no hardcoded literals).
--   3) Scheduling run_api_caller_batch() via pg_cron.
-- Notes:
--   - Secrets (EDGE_TASK_TOKEN) are expected in provider_auth_configs for provider name 'edge_api_caller'.
--   - The function reads the ANON key from settings category 'supabase_public' (scope global) key anon_key.
--   - URL is read from settings category 'edge_dispatch_policy' (scope global) key endpoint_url. If absent,
--     it falls back to the standard Supabase Functions URL pattern using SUPABASE project ref placeholder.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

SET search_path TO public;

-- Helper: resolve anon key from settings (category = 'supabase_public').
CREATE OR REPLACE FUNCTION public.resolve_anon_key()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_row RECORD;
    v_key TEXT;
BEGIN
    SELECT cached_value AS v
    INTO v_row
    FROM settings
    WHERE category = 'supabase_public' AND scope_type = 'global' AND scope_id IS NULL
    ORDER BY last_updated DESC
    LIMIT 1;

    IF NOT FOUND OR v_row.v IS NULL OR v_row.v->>'anon_key' IS NULL THEN
        RAISE EXCEPTION 'resolve_anon_key: anon_key not configured in settings (category=supabase_public, scope=global)';
    END IF;

    v_key := v_row.v->>'anon_key';
    IF v_key IS NULL OR btrim(v_key) = '' THEN
        RAISE EXCEPTION 'resolve_anon_key: anon_key is empty';
    END IF;
    RETURN v_key;
END;
$$;

-- Helper: resolve edge task token from provider_auth_configs (provider.name='edge_api_caller').
CREATE OR REPLACE FUNCTION public.resolve_edge_task_token()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_token TEXT;
BEGIN
    SELECT (pac.credentials->>'shared_secret')::TEXT
    INTO v_token
    FROM providers p
    JOIN provider_auth_configs pac ON pac.provider_id = p.id
    WHERE p.name = 'edge_api_caller'
    ORDER BY pac.created_at DESC
    LIMIT 1;

    IF v_token IS NULL OR btrim(v_token) = '' THEN
        RAISE EXCEPTION 'resolve_edge_task_token: shared_secret missing for provider edge_api_caller';
    END IF;
    RETURN v_token;
END;
$$;

-- Helper: resolve api-caller endpoint from settings (fallback to project functions URL pattern if configured).
CREATE OR REPLACE FUNCTION public.resolve_api_caller_endpoint()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_url TEXT;
BEGIN
    SELECT (cached_value->>'endpoint_url')::TEXT
    INTO v_url
    FROM settings
    WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL
    ORDER BY last_updated DESC
    LIMIT 1;

    IF v_url IS NULL OR btrim(v_url) = '' THEN
        -- Fallback reminder: seed settings.edge_dispatch_policy with endpoint_url for your project
        RAISE EXCEPTION 'resolve_api_caller_endpoint: endpoint_url not configured (settings: edge_dispatch_policy)';
    END IF;

    RETURN v_url;
END;
$$;

-- Batch runner: POST to api-caller function with Authorization (anon) + x-internal-edge-token
CREATE OR REPLACE FUNCTION public.run_api_caller_batch(p_batch INT DEFAULT 10)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_url TEXT := resolve_api_caller_endpoint();
    v_anon TEXT := resolve_anon_key();
    v_secret TEXT := resolve_edge_task_token();
    v_headers JSONB := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', concat('Bearer ', v_anon),
        'x-internal-edge-token', v_secret
    );
    v_body JSONB := jsonb_build_object('batch', GREATEST(COALESCE(p_batch, 10), 1));
    v_result JSONB;
BEGIN
    -- Use public.call_api which performs HTTP via pg_net in this project baseline
    v_result := public.call_api(v_url, 'POST', v_headers, v_body, 15);
    RETURN v_result;
END;
$$;

-- Schedule workers via pg_cron
DO $$
BEGIN
    -- Outbound worker (prepares jobs for edge)
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'run_outbound_worker') THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'outbound_worker_tick') THEN
            PERFORM cron.unschedule((SELECT jobid FROM cron.job WHERE jobname = 'outbound_worker_tick'));
        END IF;
        PERFORM cron.schedule('outbound_worker_tick', '*/1 * * * *', 'SELECT run_outbound_worker()');
    END IF;

    -- Edge api-caller batch (dispatches pending_edge jobs)
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'run_api_caller_batch') THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'api_caller_batch_tick') THEN
            PERFORM cron.unschedule((SELECT jobid FROM cron.job WHERE jobname = 'api_caller_batch_tick'));
        END IF;
        PERFORM cron.schedule('api_caller_batch_tick', '*/1 * * * *', 'SELECT run_api_caller_batch(10)');
    END IF;
END $$;

COMMIT;
