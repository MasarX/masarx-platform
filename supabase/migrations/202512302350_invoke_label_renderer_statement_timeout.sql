-- Migration: invoke_label_renderer statement_timeout guard (sync UX)
-- Purpose:
--  - Prevent low session statement_timeout from canceling synchronous label renderer calls
--    inside workflow progression (e.g., label_print_prepare_v2 + bundle flows).
-- Notes:
--  - Only increases statement_timeout when the session has a non-zero limit.
--  - Uses provider timeout_ms to size the minimum timeout window.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.invoke_label_renderer(
    p_max_jobs INT DEFAULT 5,
    p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_settings JSONB;
    v_provider JSONB;
    v_url TEXT;
    v_secret TEXT;
    v_timeout_ms INT;
    v_timeout_seconds INT;
    v_headers JSONB;
    v_body JSONB;
    v_response JSONB;
    v_org_id UUID;

    v_existing_timeout_text TEXT;
    v_existing_timeout_ms INT;
    v_desired_timeout_ms INT;
BEGIN
    v_body := CASE
        WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
            THEN jsonb_strip_nulls(p_payload)
        ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
    END;

    v_org_id := NULLIF(v_body->>'organization_id', '')::UUID;

    v_settings := COALESCE(
        CASE
            WHEN v_org_id IS NOT NULL THEN resolve_settings('label_provider', 'tenant', v_org_id)
            ELSE NULL
        END,
        resolve_settings('label_provider', 'global', NULL)
    );

    IF v_settings IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: label_provider settings not found';
    END IF;

    v_provider := COALESCE((v_settings->'providers')->0, '{}'::jsonb);

    v_url := NULLIF(v_provider->>'invoke_url', '');
    v_secret := NULLIF(v_provider->>'invoke_secret', '');
    v_timeout_ms := COALESCE((v_provider->>'timeout_ms')::INT, 15000);

    IF v_url IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: invoke_url missing in label_provider configuration';
    END IF;

    IF v_secret IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: invoke_secret missing in label_provider configuration';
    END IF;

    IF v_url LIKE 'https://example.%' OR v_secret = 'EXAMPLE_PASSWORD' THEN
        RAISE EXCEPTION 'invoke_label_renderer: provider invoke configuration not activated (update settings)';
    END IF;

    v_headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', concat('Bearer ', v_secret)
    );

    v_timeout_seconds := GREATEST((v_timeout_ms + 999) / 1000, 1);

    -- Avoid cancellations from low session statement_timeout while we synchronously wait.
    v_existing_timeout_text := current_setting('statement_timeout', true);
    v_desired_timeout_ms := (v_timeout_seconds + 5) * 1000;
    IF v_existing_timeout_text IS NOT NULL THEN
        BEGIN
            v_existing_timeout_ms :=
                ROUND(EXTRACT(EPOCH FROM v_existing_timeout_text::interval) * 1000)::INT;
        EXCEPTION WHEN OTHERS THEN
            v_existing_timeout_ms := NULL;
        END;
    END IF;

    IF v_existing_timeout_ms IS NOT NULL AND v_existing_timeout_ms > 0 THEN
        v_desired_timeout_ms := GREATEST(v_existing_timeout_ms, v_desired_timeout_ms);
        PERFORM set_config('statement_timeout', v_desired_timeout_ms::TEXT, true);
    END IF;

    v_response := public.call_api_wait(
        v_url,
        'POST',
        v_headers,
        v_body,
        v_timeout_seconds,
        v_timeout_seconds
    );

    RETURN v_response || jsonb_build_object(
        'request_payload', v_body,
        'provider_name', v_provider->>'name'
    );
END;
$$;

COMMENT ON FUNCTION public.invoke_label_renderer(INT, JSONB)
    IS 'Trigger label renderer edge worker using settings (sync via call_api_wait; statement_timeout guard).';

GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO edge_label_renderer_role;

COMMIT;

