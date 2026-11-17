-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Redact token-like JSON keys (e.g., authToken) in logs
-- Purpose:
--   - Ensure api_call_log and other persisted JSON never store provider-issued bearer tokens.
--   - Extend redact_sensitive_json to treat any key containing "token" as sensitive
--     (covers authToken/idToken/token_type/etc) while keeping behavior recursive and immutable.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.redact_sensitive_json(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_out JSONB;
  v_entry RECORD;
  v_key_lower TEXT;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_value) = 'object' THEN
    v_out := '{}'::jsonb;
    FOR v_entry IN SELECT key, value FROM jsonb_each(p_value) LOOP
      v_key_lower := lower(v_entry.key);
      IF v_key_lower IN (
        'api_key',
        'apikey',
        'password',
        'secret',
        'token',
        'access_token',
        'refresh_token',
        'signing_secret',
        'shared_secret'
      )
      OR v_key_lower LIKE '%token%'
      THEN
        v_out := v_out || jsonb_build_object(v_entry.key, 'REDACTED');
      ELSE
        v_out := v_out || jsonb_build_object(v_entry.key, public.redact_sensitive_json(v_entry.value));
      END IF;
    END LOOP;
    RETURN v_out;
  END IF;

  IF jsonb_typeof(p_value) = 'array' THEN
    v_out := '[]'::jsonb;
    FOR v_entry IN
      SELECT value, ordinality
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS arr(value, ordinality)
    LOOP
      v_out := v_out || jsonb_build_array(public.redact_sensitive_json(v_entry.value));
    END LOOP;
    RETURN v_out;
  END IF;

  RETURN p_value;
END;
$$;

COMMIT;

