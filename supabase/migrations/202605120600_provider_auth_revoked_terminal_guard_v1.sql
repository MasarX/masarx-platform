-- Console V2 provider credential terminal-state guard.
--
-- Revoked provider_auth_configs rows are terminal tombstones. Browser/API
-- update and config-id rotation paths must not re-open them by replacing
-- credential material after revoke.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605120600_provider_auth_revoked_terminal_guard_v1'));

SET search_path TO public, vault, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_upsert_provider_auth_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, vault, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_org_id UUID := public.current_user_org_id();
  v_config_id UUID := COALESCE(
    NULLIF(p_args->>'config_id', '')::uuid,
    NULLIF(p_args->>'provider_auth_config_id', '')::uuid
  );
  v_is_create BOOLEAN := v_config_id IS NULL;
  v_provider_id UUID := NULLIF(p_args->>'provider_id', '')::uuid;
  v_auth_type TEXT := NULLIF(btrim(p_args->>'auth_type'), '');
  v_credentials JSONB := CASE WHEN p_args ? 'credentials' THEN p_args->'credentials' ELSE NULL END;
  v_credentials_vault_id UUID := NULLIF(p_args->>'credentials_vault_id', '')::uuid;
  v_expires_at TIMESTAMPTZ := NULLIF(p_args->>'expires_at', '')::timestamptz;
  v_existing_provider_id UUID;
  v_existing_credentials_vault_id UUID;
  v_existing_credentials JSONB;
  v_target_org UUID;
  v_secret_name TEXT;
  v_secret_description TEXT;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write');

  IF v_is_create AND v_config_id IS NULL THEN
    v_config_id := gen_random_uuid();
  END IF;

  IF v_is_create THEN
    IF v_provider_id IS NULL OR v_auth_type IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires provider_id and auth_type for create'
        USING ERRCODE = '23502';
    END IF;
    IF v_credentials IS NULL AND v_credentials_vault_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires credentials or credentials_vault_id for create'
        USING ERRCODE = '23502';
    END IF;
  END IF;

  IF NOT v_is_create THEN
    SELECT pac.provider_id, pac.credentials_vault_id, pac.credentials, p.organization_id
      INTO v_existing_provider_id, v_existing_credentials_vault_id, v_existing_credentials, v_target_org
      FROM public.provider_auth_configs pac
      JOIN public.providers p ON p.id = pac.provider_id
     WHERE pac.id = v_config_id
     LIMIT 1;

    IF v_existing_provider_id IS NULL OR v_target_org IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % not found', v_config_id
        USING ERRCODE = '23503';
    END IF;

    IF COALESCE((v_existing_credentials->>'revoked')::boolean, FALSE) THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % is revoked and cannot be updated', v_config_id
        USING ERRCODE = '55000';
    END IF;

    IF v_provider_id IS NULL THEN
      v_provider_id := v_existing_provider_id;
    ELSIF v_provider_id <> v_existing_provider_id THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 config % belongs to provider %, not %',
        v_config_id, v_existing_provider_id, v_provider_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_is_create THEN
    SELECT organization_id INTO v_target_org
      FROM public.providers
     WHERE id = v_provider_id;
  END IF;

  IF v_provider_id IS NULL OR v_target_org IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider % not found', v_provider_id
      USING ERRCODE = '23503';
  END IF;

  IF v_user_org_id IS NOT NULL
     AND v_target_org <> v_user_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider % outside tenant scope', v_provider_id
      USING ERRCODE = '42501';
  END IF;

  IF v_credentials IS NOT NULL THEN
    IF jsonb_typeof(v_credentials) <> 'object' THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 credentials must be a JSON object'
        USING ERRCODE = '22023';
    END IF;

    v_secret_name := format('provider_auth_configs/%s', v_config_id);
    v_secret_description := format('Console V2 provider credential %s', v_secret_name);

    IF NOT v_is_create AND COALESCE(v_credentials_vault_id, v_existing_credentials_vault_id) IS NOT NULL THEN
      v_credentials_vault_id := COALESCE(v_credentials_vault_id, v_existing_credentials_vault_id);
      PERFORM vault.update_secret(
        v_credentials_vault_id,
        v_credentials::text,
        v_secret_name,
        v_secret_description,
        NULL
      );
    ELSE
      SELECT vault.create_secret(
        v_credentials::text,
        v_secret_name,
        v_secret_description,
        NULL
      )
        INTO v_credentials_vault_id;
    END IF;
  END IF;

  IF v_is_create THEN
    INSERT INTO public.provider_auth_configs (
      id,
      provider_id,
      auth_type,
      credentials,
      credentials_vault_id,
      expires_at
    ) VALUES (
      v_config_id,
      v_provider_id,
      v_auth_type,
      NULL,
      v_credentials_vault_id,
      v_expires_at
    )
    RETURNING id INTO v_config_id;
  ELSE
    UPDATE public.provider_auth_configs
       SET auth_type = COALESCE(v_auth_type, auth_type),
           credentials = CASE
             WHEN v_credentials IS NOT NULL OR v_credentials_vault_id IS NOT NULL THEN NULL
             ELSE credentials
           END,
           credentials_vault_id = COALESCE(v_credentials_vault_id, credentials_vault_id),
           expires_at = CASE WHEN p_args ? 'expires_at' THEN v_expires_at ELSE expires_at END
     WHERE id = v_config_id
       AND provider_id = v_provider_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % not found', v_config_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'provider_auth_config_id', v_config_id,
    'auth_config_id', v_config_id,
    'credentials_vaulted', true,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb)
  IS 'Canonical write RPC: create/update provider_auth_configs with Vault-backed credential material. Updates reuse the existing Vault secret for the provider_auth_configs/<config_id> canonical name; revoked tombstones are terminal and cannot be updated. Capability: integration_plugins.write.';

SELECT pg_advisory_unlock(hashtext('202605120600_provider_auth_revoked_terminal_guard_v1'));

COMMIT;
