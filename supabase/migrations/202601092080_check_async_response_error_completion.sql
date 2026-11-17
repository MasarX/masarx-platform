-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S05
-- Migration: check_async_response handles pg_net error rows
-- Purpose:
--   - Treat net._http_response rows with error_msg/timed_out as completed so workers can mark
--     outbound_calls as failed (and apply retry policy) instead of looping forever as "pending".
-- Date: 2026-01-09

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.check_async_response(p_request_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_response_status  INT;
    v_response_headers JSONB;
    v_response_body    TEXT;
    v_error_msg        TEXT;
    v_timed_out        BOOLEAN;
BEGIN
    BEGIN
        SELECT status_code, headers, content::TEXT, error_msg, timed_out
          INTO v_response_status, v_response_headers, v_response_body, v_error_msg, v_timed_out
          FROM net._http_response
         WHERE id = p_request_id;
    EXCEPTION
        WHEN undefined_table THEN
            RAISE EXCEPTION 'pg_net extension not available (net._http_response missing). Enable pg_net to use check_async_response().';
    END;

    -- If the HTTP worker wrote an error (or timed out), treat it as completed so callers can handle failure.
    IF v_error_msg IS NOT NULL OR COALESCE(v_timed_out, FALSE) THEN
        RETURN jsonb_build_object(
            'completed', TRUE,
            'status', COALESCE(v_response_status, 0),
            'headers', COALESCE(v_response_headers, '{}'::jsonb),
            'body', jsonb_build_object(
              'error', COALESCE(v_error_msg, 'timed_out'),
              'timed_out', COALESCE(v_timed_out, FALSE)
            )
        );
    END IF;

    IF v_response_status IS NULL THEN
        RETURN jsonb_build_object(
            'completed', FALSE,
            'status', NULL,
            'headers', '{}'::jsonb,
            'body', '{}'::jsonb
        );
    END IF;

    RETURN jsonb_build_object(
        'completed', TRUE,
        'status', v_response_status,
        'headers', COALESCE(v_response_headers, '{}'::jsonb),
        'body', CASE
            WHEN v_response_body IS NULL THEN '{}'::jsonb
            WHEN v_response_body ~ '^\s*[\[\{]' THEN v_response_body::JSONB
            ELSE to_jsonb(v_response_body)
        END
    );
END;
$$;

COMMENT ON FUNCTION public.check_async_response(BIGINT)
    IS 'Return completion status and payload for a pg_net request_id; treats net._http_response error rows as completed failures.';

COMMIT;
