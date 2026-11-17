-- Migration: Label renderer invoke helper (permanent, configuration-driven)
-- Purpose: Persist invoke_label_renderer() inside the database so pg_cron/worker
--          automation stays declarative. The helper posts to the configured label
--          renderer endpoint using call_api(), keeping timeouts/retries consistent
--          with the rest of the platform.
-- Alignment: SIMPLE (single helper), SCALABLE (max_jobs parameter), DYNAMIC/ZERO
--             HARD CODING (reads settings rows). Raises if placeholder values are
--             still present to enforce settings rotation.

BEGIN;

CREATE OR REPLACE FUNCTION invoke_label_renderer(p_max_jobs INT DEFAULT 5)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_settings JSONB;
    v_provider JSONB;
    v_url TEXT;
    v_secret TEXT;
    v_timeout_ms INT;
    v_timeout_seconds INT;
    v_headers JSONB;
    v_payload JSONB;
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

    v_payload := jsonb_build_object(
        'max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1)
    );

    v_timeout_seconds := GREATEST((v_timeout_ms + 999) / 1000, 1);

    v_response := call_api(
        v_url,
        'POST',
        v_headers,
        v_payload,
        v_timeout_seconds
    );

    RETURN v_response || jsonb_build_object(
        'request_payload', v_payload,
        'provider_name', v_provider->>'name'
    );
END;
$$;

COMMENT ON FUNCTION invoke_label_renderer(INT)
    IS 'Trigger label renderer edge worker using configuration stored in settings; delegates HTTP execution to call_api for consistency.';

GRANT EXECUTE ON FUNCTION invoke_label_renderer(INT) TO service_role;

COMMIT;
