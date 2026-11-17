-- Migration: Fix SECURITY DEFINER search_path for provider auth Vault resolvers
-- Purpose:
--   - pgTAP enforces SECURITY DEFINER functions pin `search_path` to safe schemas:
--     `public, (extensions|workflow_handlers)*, pg_temp`.
--   - Vault objects are schema-qualified; `vault` does not need to be in search_path.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_provider_auth_credentials(p_auth_config_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
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
      RETURN jsonb_build_object('value', v_secret);
    END;
  END IF;

  RETURN v_row.credentials;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_provider_auth_credential(p_auth_config_id UUID, p_key TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
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

-- Least privilege: keep resolver execution restricted.
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

