-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Redact x-webhook-token in redact_sensitive_headers()
-- Purpose: Prevent API gateway tokens from being persisted in api_call_log or any redacted header logs.
-- Date: 2025-12-25

BEGIN;

CREATE OR REPLACE FUNCTION public.redact_sensitive_headers(p_headers JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_out JSONB := '{}'::jsonb;
  v_entry RECORD;
  v_key_lower TEXT;
BEGIN
  IF p_headers IS NULL OR jsonb_typeof(p_headers) <> 'object' THEN
    RETURN COALESCE(p_headers, '{}'::jsonb);
  END IF;

  FOR v_entry IN SELECT key, value FROM jsonb_each(p_headers) LOOP
    v_key_lower := lower(v_entry.key);
    IF v_key_lower IN (
      'authorization',
      'proxy-authorization',
      'd360-api-key',
      'x-api-key',
      'api-key',
      'apikey',
      'x-auth-token',
      'x-internal-edge-token',
      'x-webhook-token',
      'cookie',
      'set-cookie'
    ) THEN
      v_out := v_out || jsonb_build_object(v_entry.key, 'REDACTED');
    ELSE
      v_out := v_out || jsonb_build_object(v_entry.key, v_entry.value);
    END IF;
  END LOOP;

  RETURN v_out;
END;
$$;

COMMIT;

