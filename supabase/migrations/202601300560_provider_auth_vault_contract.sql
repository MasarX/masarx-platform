-- Migration: Provider auth configs Vault contract + SSOT resolvers
-- Purpose:
--   - Align schema with Vault-backed provider credentials (no plaintext secrets in app tables).
--   - Provide SSOT helpers to resolve provider credentials/keys (service/internal roles only).
-- Notes:
--   - `provider_auth_configs.credentials` remains as a legacy fallback (temporarily); new writes MUST use Vault.
--   - Secrets are stored as JSON payloads in Supabase Vault and referenced by `credentials_vault_id`.

BEGIN;

-- Ensure Supabase Vault is available (idempotent; installs dependencies such as pgsodium when needed).
CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;

-- Vault reference + nullable legacy column (Vault contract).
ALTER TABLE public.provider_auth_configs
  ADD COLUMN IF NOT EXISTS credentials_vault_id UUID;

ALTER TABLE public.provider_auth_configs
  ALTER COLUMN credentials DROP NOT NULL;

-- At least one credential source must exist (Vault ref OR legacy JSONB).
ALTER TABLE public.provider_auth_configs
  DROP CONSTRAINT IF EXISTS provider_auth_configs_credentials_present_chk;

ALTER TABLE public.provider_auth_configs
  ADD CONSTRAINT provider_auth_configs_credentials_present_chk
  CHECK (credentials_vault_id IS NOT NULL OR credentials IS NOT NULL);

-- Keep referential integrity to Vault where supported.
ALTER TABLE public.provider_auth_configs
  DROP CONSTRAINT IF EXISTS provider_auth_configs_credentials_vault_id_fkey;

ALTER TABLE public.provider_auth_configs
  ADD CONSTRAINT provider_auth_configs_credentials_vault_id_fkey
  FOREIGN KEY (credentials_vault_id) REFERENCES vault.secrets(id);

CREATE INDEX IF NOT EXISTS idx_provider_auth_configs_credentials_vault_id
  ON public.provider_auth_configs(credentials_vault_id)
  WHERE credentials_vault_id IS NOT NULL;

-- SSOT: resolve provider auth credentials JSON from Vault (preferred) or legacy JSONB (fallback).
CREATE OR REPLACE FUNCTION public.get_provider_auth_credentials(p_auth_config_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_row RECORD;
  v_secret TEXT;
BEGIN
  SELECT pac.credentials_vault_id, pac.credentials
  INTO v_row
  FROM public.provider_auth_configs pac
  WHERE pac.id = p_auth_config_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.credentials_vault_id IS NOT NULL THEN
    SELECT ds.decrypted_secret
    INTO v_secret
    FROM vault.decrypted_secrets ds
    WHERE ds.id = v_row.credentials_vault_id
    LIMIT 1;

    IF v_secret IS NULL OR btrim(v_secret) = '' THEN
      RETURN NULL;
    END IF;

    BEGIN
      RETURN v_secret::jsonb;
    EXCEPTION WHEN others THEN
      -- Defensive: if a non-JSON secret is stored, return a stable shape.
      RETURN jsonb_build_object('value', v_secret);
    END;
  END IF;

  RETURN v_row.credentials;
END;
$$;

-- SSOT: resolve a single credential key as text (common case).
CREATE OR REPLACE FUNCTION public.get_provider_auth_credential(p_auth_config_id UUID, p_key TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credentials JSONB;
  v_key TEXT;
BEGIN
  v_key := btrim(p_key);
  IF v_key IS NULL OR v_key = '' THEN
    RETURN NULL;
  END IF;

  v_credentials := public.get_provider_auth_credentials(p_auth_config_id);
  IF v_credentials IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_credentials ->> v_key;
END;
$$;

-- Least privilege: never expose secret resolvers to PUBLIC/anon/authenticated.
REVOKE ALL ON FUNCTION public.get_provider_auth_credentials(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_provider_auth_credential(UUID, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_provider_auth_credential(UUID, TEXT) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO edge_api_caller_role;
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credential(UUID, TEXT) TO edge_api_caller_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credential(UUID, TEXT) TO edge_api_gateway_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_webhook_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO edge_webhook_role;
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credential(UUID, TEXT) TO edge_webhook_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credential(UUID, TEXT) TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;

