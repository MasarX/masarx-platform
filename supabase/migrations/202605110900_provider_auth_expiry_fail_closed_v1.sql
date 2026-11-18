-- Provider auth resolver expiry/revocation fail-closed guard.
--
-- API Gateway dispatch injects provider credentials only at worker/readback time
-- through get_job_call_spec -> get_provider_auth_credentials. Expired or
-- revoked credentials must not be usable by API shipment creation, webhook
-- validation, or any other browser-driven provider path.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605110900_provider_auth_expiry_fail_closed_v1'));

SET search_path TO public, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.get_provider_auth_credentials(p_auth_config_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_row RECORD;
  v_secret TEXT;
BEGIN
  SELECT pac.credentials_vault_id, pac.credentials, pac.expires_at
    INTO v_row
    FROM public.provider_auth_configs pac
   WHERE pac.id = p_auth_config_id
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF COALESCE((v_row.credentials->>'revoked')::boolean, FALSE) THEN
    RETURN NULL;
  END IF;

  IF v_row.expires_at IS NOT NULL AND v_row.expires_at <= now() THEN
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
$function$;

COMMENT ON FUNCTION public.get_provider_auth_credentials(UUID)
  IS 'Resolves Vault-backed provider credentials and fails closed for revoked or expired provider_auth_configs.';

REVOKE ALL ON FUNCTION public.get_provider_auth_credentials(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO service_role;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO edge_api_caller_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO edge_api_gateway_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_webhook_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO edge_webhook_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID) TO edge_label_renderer_role;
  END IF;
END;
$grants$;

SELECT pg_advisory_unlock(hashtext('202605110900_provider_auth_expiry_fail_closed_v1'));

COMMIT;
