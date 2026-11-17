-- Plan: PLAN-202601-logestechs-outbound-http2-fix / Step: S05
-- Migration: Fix edge_api_caller JWT validation
-- Purpose:
--   - Ensure resolve_edge_api_caller_jwt_v1() validates JWTs correctly under standard_conforming_strings=on.
--   - Prevent pg_cron api_caller_batch_tick failures that leave outbound_calls stuck in pending_edge.
-- Date: 2026-01-10

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.resolve_edge_api_caller_jwt_v1()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_token TEXT;
  v_parts INT;
BEGIN
  SELECT (pac.credentials->>'shared_secret')::TEXT
    INTO v_token
    FROM public.providers p
    JOIN public.provider_auth_configs pac ON pac.provider_id = p.id
   WHERE p.name = 'edge_api_caller'
   ORDER BY pac.created_at DESC
   LIMIT 1;

  v_token := btrim(COALESCE(v_token, ''));

  IF v_token = '' THEN
    RAISE EXCEPTION 'resolve_edge_api_caller_jwt_v1: shared_secret missing for provider edge_api_caller';
  END IF;

  -- Basic shape check (JWT has exactly 3 dot-separated segments).
  v_parts := array_length(string_to_array(v_token, '.'), 1);
  IF COALESCE(v_parts, 0) <> 3 THEN
    RAISE EXCEPTION 'resolve_edge_api_caller_jwt_v1: token is not a JWT (expected 3 segments)';
  END IF;

  RETURN v_token;
END;
$$;

COMMIT;
