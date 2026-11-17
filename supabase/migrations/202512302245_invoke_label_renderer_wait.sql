-- Migration: invoke_label_renderer uses call_api_wait (sync)
-- Purpose:
--  - Ensure label renderer invocation is synchronous for UX-critical flows.
--  - Prevent partial batches (edge timeouts) from leaving jobs leased/in_progress.
-- Notes:
--  - Uses provider timeout_ms as both HTTP timeout and wait window.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION invoke_label_renderer(
    p_max_jobs INT DEFAULT 5,
    p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_row RECORD;
    v_item JSONB;
    v_settings JSONB;
    v_provider JSONB;
    v_url TEXT;
    v_secret TEXT;
    v_timeout_ms INT;
    v_timeout_seconds INT;
    v_headers JSONB;
    v_body JSONB;
    v_response JSONB;
BEGIN
    SELECT cached_value
    INTO v_settings
    FROM settings
    WHERE category = 'label_provider'
      AND scope_type = 'global'
    ORDER BY last_updated DESC
    LIMIT 1;

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

    v_body := CASE
        WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
            THEN jsonb_strip_nulls(p_payload)
        ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
    END;

    v_timeout_seconds := GREATEST((v_timeout_ms + 999) / 1000, 1);

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

COMMENT ON FUNCTION invoke_label_renderer(INT, JSONB)
    IS 'Trigger label renderer edge worker using settings (sync via call_api_wait).';

GRANT EXECUTE ON FUNCTION invoke_label_renderer(INT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION invoke_label_renderer(INT, JSONB) TO edge_label_renderer_role;

COMMIT;

