-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Resolve edge_api_caller JWT from Vault-backed provider auth configs
-- Purpose:
--   - resolve_edge_api_caller_jwt_v1() must work when credentials are stored in Supabase Vault
--     and referenced by provider_auth_configs.credentials_vault_id (credentials JSONB is NULL).
--   - Keep error semantics stable for pgTAP and edge callers.
-- Date: 2026-01-30

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
  SELECT public.get_provider_auth_credential(pac.id, 'shared_secret')
    INTO v_token
    FROM public.providers p
    JOIN public.provider_auth_configs pac ON pac.provider_id = p.id
   WHERE p.name = 'edge_api_caller'
     AND pac.auth_type = 'shared_secret'
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

