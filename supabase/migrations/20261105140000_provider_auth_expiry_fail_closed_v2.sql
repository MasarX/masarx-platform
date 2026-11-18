-- Folds G1 (202605110900_provider_auth_expiry_fail_closed_v1): provider credentials fail closed once
-- provider_auth_configs.expires_at has passed or the row carries a credentials.revoked marker.
-- Body is the 202601300580 definition plus those two checks. CREATE OR REPLACE keeps the owner and
-- the existing EXECUTE ACL, so no grants are re-issued (a re-grant could undo a later revoke sweep).
-- No caller needs expired rows: OAuth refresh reads its refresh token from Vault directly.
BEGIN;
SET LOCAL search_path TO public, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261105140000_provider_auth_expiry_fail_closed_v2'));

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
  SELECT pac.credentials_vault_id, pac.credentials, pac.expires_at
  INTO v_row
  FROM public.provider_auth_configs pac
  WHERE pac.id = p_auth_config_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Any revoked marker that is not an explicit false counts as revoked (no cast, so no throw on odd values).
  IF lower(COALESCE(v_row.credentials ->> 'revoked', 'false')) NOT IN ('false', 'f', 'no', 'n', '0', 'off') THEN
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
$$;

COMMENT ON FUNCTION public.get_provider_auth_credentials(UUID)
  IS 'Resolves Vault-backed provider credentials; returns NULL for missing, revoked or expired provider_auth_configs.';

DO $verify$
BEGIN
  IF has_function_privilege('public', 'public.get_provider_auth_credentials(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_provider_auth_credentials must not be executable by PUBLIC';
  END IF;
END;
$verify$;

COMMIT;
