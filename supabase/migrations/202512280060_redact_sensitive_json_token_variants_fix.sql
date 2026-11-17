-- Plan: PLAN-202512-pr-merge-docs-update / Step: S04
-- Migration: Redact token-like JSON keys (authToken et al) in logs
-- Purpose:
--   - Ensure redact_sensitive_json treats any key containing "token" as sensitive.
--   - Prevent provider-issued tokens from leaking into persisted JSON bodies.
-- Date: 2025-12-28
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
