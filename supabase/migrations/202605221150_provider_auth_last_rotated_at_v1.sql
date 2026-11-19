-- Console V2 provider credential rotation timestamp repair.
--
-- The redacted credential directory is the Browser-safe read surface for
-- provider_auth_configs. Rotation already replaces the vaulted secret and
-- refreshes the row, but the directory previously exposed created_at as
-- last_rotated_at, leaving operators with stale action readback after a real
-- rotate. Store the rotation timestamp on the SSOT row and project it without
-- exposing credential material.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605221150_provider_auth_last_rotated_at_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.provider_auth_configs
  ADD COLUMN IF NOT EXISTS last_rotated_at timestamptz;

UPDATE public.provider_auth_configs
   SET last_rotated_at = created_at
 WHERE last_rotated_at IS NULL;

CREATE OR REPLACE FUNCTION public.provider_auth_configs_touch_last_rotated_at_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_is_revoked boolean;
BEGIN
  v_is_revoked := lower(COALESCE(NEW.credentials->>'revoked', 'false')) NOT IN ('false', 'f', 'no', 'n', '0', 'off');

  IF TG_OP = 'INSERT' THEN
    IF NEW.last_rotated_at IS NULL
       AND NOT v_is_revoked
       AND (NEW.credentials IS NOT NULL OR NEW.credentials_vault_id IS NOT NULL) THEN
      NEW.last_rotated_at := COALESCE(NEW.created_at, now());
    END IF;
    RETURN NEW;
  END IF;

  IF NOT v_is_revoked
     AND (
       NEW.credentials_vault_id IS DISTINCT FROM OLD.credentials_vault_id
       OR (
         NEW.credentials IS NOT NULL
         AND NEW.credentials IS DISTINCT FROM OLD.credentials
       )
     ) THEN
    NEW.last_rotated_at := now();
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS provider_auth_configs_touch_last_rotated_at_v1
  ON public.provider_auth_configs;

CREATE TRIGGER provider_auth_configs_touch_last_rotated_at_v1
BEFORE INSERT OR UPDATE OF credentials, credentials_vault_id
ON public.provider_auth_configs
FOR EACH ROW
EXECUTE FUNCTION public.provider_auth_configs_touch_last_rotated_at_v1();

CREATE OR REPLACE FUNCTION public.ui_upsert_provider_auth_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, vault, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_user_org_id uuid := public.current_user_org_id();
  v_config_id uuid := COALESCE(
    NULLIF(p_args->>'config_id', '')::uuid,
    NULLIF(p_args->>'provider_auth_config_id', '')::uuid
  );
  v_is_create boolean := v_config_id IS NULL;
  v_provider_id uuid := NULLIF(p_args->>'provider_id', '')::uuid;
  v_auth_type text := NULLIF(btrim(p_args->>'auth_type'), '');
  v_credentials jsonb := CASE WHEN p_args ? 'credentials' THEN p_args->'credentials' ELSE NULL END;
  v_credentials_vault_id uuid := NULLIF(p_args->>'credentials_vault_id', '')::uuid;
  v_expires_at timestamptz := NULLIF(p_args->>'expires_at', '')::timestamptz;
  v_existing_provider_id uuid;
  v_existing_credentials_vault_id uuid;
  v_existing_credentials jsonb;
  v_target_org uuid;
  v_secret_name text;
  v_secret_description text;
  v_correlation_id uuid := gen_random_uuid();
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

    IF lower(COALESCE(v_existing_credentials->>'revoked', 'false')) NOT IN ('false', 'f', 'no', 'n', '0', 'off') THEN
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
      expires_at,
      last_rotated_at
    ) VALUES (
      v_config_id,
      v_provider_id,
      v_auth_type,
      NULL,
      v_credentials_vault_id,
      v_expires_at,
      CASE
        WHEN v_credentials IS NOT NULL OR v_credentials_vault_id IS NOT NULL THEN now()
        ELSE NULL
      END
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
           expires_at = CASE WHEN p_args ? 'expires_at' THEN v_expires_at ELSE expires_at END,
           last_rotated_at = CASE
             WHEN v_credentials IS NOT NULL OR v_credentials_vault_id IS NOT NULL THEN now()
             ELSE last_rotated_at
           END
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

CREATE OR REPLACE VIEW public.v_integration_credential_directory
  WITH (security_invoker = true)
  AS
WITH credential_base AS (
  SELECT
    pac.id,
    pac.provider_id,
    pac.auth_type,
    pac.expires_at,
    pac.created_at,
    COALESCE(pac.last_rotated_at, pac.created_at) AS last_rotated_at,
    p.name AS provider_label,
    p.provider_type AS provider_kind,
    p.metadata->>'vendor' AS provider_vendor,
    p.organization_id AS provider_organization_id,
    lower(COALESCE(pac.credentials->>'revoked', 'false')) NOT IN ('false', 'f', 'no', 'n', '0', 'off') AS is_revoked
  FROM public.provider_auth_configs pac
  LEFT JOIN public.providers p ON p.id = pac.provider_id
),
credential_rows AS (
  SELECT
    cb.id,
    cb.provider_id,
    cb.auth_type,
    cb.auth_type AS auth_type_label,
    cb.expires_at,
    cb.created_at,
    cb.last_rotated_at,
    CASE
      WHEN cb.is_revoked THEN 'revoked'
      WHEN cb.expires_at IS NULL THEN 'active'
      WHEN cb.expires_at <= now() THEN 'expired'
      WHEN cb.expires_at <= now() + INTERVAL '30 days' THEN 'expiring'
      ELSE 'active'
    END AS status,
    CASE
      WHEN cb.expires_at IS NULL THEN NULL
      ELSE EXTRACT(DAY FROM (cb.expires_at - now()))::INTEGER
    END AS days_until_expiry,
    cb.provider_label,
    cb.provider_kind,
    cb.provider_vendor,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at > now()
      AND cb.expires_at <= now() + INTERVAL '30 days'
    ) AS is_expiring,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at <= now()
    ) AS is_expired,
    (
      NOT cb.is_revoked
      AND (cb.expires_at IS NULL OR cb.expires_at > now() + INTERVAL '30 days')
    ) AS is_active,
    true AS mask_state,
    cb.provider_organization_id AS organization_id,
    NULL::text AS provider_account_category,
    NULL::text AS company_id,
    NULL::text AS bound_scope_type,
    NULL::uuid AS bound_scope_id,
    NULL::uuid AS bound_settings_version_id,
    0 AS binding_rank
  FROM credential_base cb

  UNION ALL

  SELECT
    cb.id,
    cb.provider_id,
    cb.auth_type,
    cb.auth_type AS auth_type_label,
    cb.expires_at,
    cb.created_at,
    cb.last_rotated_at,
    CASE
      WHEN cb.is_revoked THEN 'revoked'
      WHEN cb.expires_at IS NULL THEN 'active'
      WHEN cb.expires_at <= now() THEN 'expired'
      WHEN cb.expires_at <= now() + INTERVAL '30 days' THEN 'expiring'
      ELSE 'active'
    END AS status,
    CASE
      WHEN cb.expires_at IS NULL THEN NULL
      ELSE EXTRACT(DAY FROM (cb.expires_at - now()))::INTEGER
    END AS days_until_expiry,
    cb.provider_label,
    cb.provider_kind,
    cb.provider_vendor,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at > now()
      AND cb.expires_at <= now() + INTERVAL '30 days'
    ) AS is_expiring,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at <= now()
    ) AS is_expired,
    (
      NOT cb.is_revoked
      AND (cb.expires_at IS NULL OR cb.expires_at > now() + INTERVAL '30 days')
    ) AS is_active,
    true AS mask_state,
    sv.scope_id AS organization_id,
    sv.category AS provider_account_category,
    sv.value->>'company_id' AS company_id,
    sv.scope_type AS bound_scope_type,
    sv.scope_id AS bound_scope_id,
    sv.id AS bound_settings_version_id,
    1 AS binding_rank
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  JOIN credential_base cb ON cb.id::text = sv.value->>'auth_config_id'
  WHERE sv.scope_type = 'tenant'
    AND sv.scope_id IS NOT NULL
    AND NULLIF(sv.value->>'auth_config_id', '') IS NOT NULL

  UNION ALL

  SELECT
    cb.id,
    cb.provider_id,
    cb.auth_type,
    cb.auth_type AS auth_type_label,
    cb.expires_at,
    cb.created_at,
    cb.last_rotated_at,
    CASE
      WHEN cb.is_revoked THEN 'revoked'
      WHEN cb.expires_at IS NULL THEN 'active'
      WHEN cb.expires_at <= now() THEN 'expired'
      WHEN cb.expires_at <= now() + INTERVAL '30 days' THEN 'expiring'
      ELSE 'active'
    END AS status,
    CASE
      WHEN cb.expires_at IS NULL THEN NULL
      ELSE EXTRACT(DAY FROM (cb.expires_at - now()))::INTEGER
    END AS days_until_expiry,
    cb.provider_label,
    cb.provider_kind,
    cb.provider_vendor,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at > now()
      AND cb.expires_at <= now() + INTERVAL '30 days'
    ) AS is_expiring,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at <= now()
    ) AS is_expired,
    (
      NOT cb.is_revoked
      AND (cb.expires_at IS NULL OR cb.expires_at > now() + INTERVAL '30 days')
    ) AS is_active,
    true AS mask_state,
    ws.organization_id AS organization_id,
    sv.category AS provider_account_category,
    sv.value->>'company_id' AS company_id,
    sv.scope_type AS bound_scope_type,
    sv.scope_id AS bound_scope_id,
    sv.id AS bound_settings_version_id,
    2 AS binding_rank
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  JOIN public.webhook_sources ws ON ws.id = sv.scope_id
  JOIN credential_base cb ON cb.id::text = sv.value->>'auth_config_id'
  WHERE sv.scope_type = 'source'
    AND sv.scope_id IS NOT NULL
    AND NULLIF(sv.value->>'auth_config_id', '') IS NOT NULL
)
SELECT DISTINCT ON (id, organization_id)
  id,
  provider_id,
  auth_type,
  auth_type_label,
  expires_at,
  created_at,
  last_rotated_at,
  status,
  days_until_expiry,
  provider_label,
  provider_kind,
  provider_vendor,
  is_expiring,
  is_expired,
  is_active,
  mask_state,
  organization_id,
  provider_account_category,
  company_id,
  bound_scope_type,
  bound_scope_id,
  bound_settings_version_id
FROM credential_rows
ORDER BY id, organization_id, binding_rank DESC;

COMMENT ON COLUMN public.provider_auth_configs.last_rotated_at IS
  'Backend-maintained timestamp for the latest non-revocation credential-material replacement. Used by the redacted Console V2 credential directory.';

COMMENT ON FUNCTION public.provider_auth_configs_touch_last_rotated_at_v1() IS
  'Maintains provider_auth_configs.last_rotated_at when secret material or the vault pointer changes; revoked tombstones do not count as rotations.';

COMMENT ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb) IS
  'Canonical write RPC: create/update provider_auth_configs with Vault-backed credential material. Updates reuse the existing Vault secret, revoked tombstones are terminal, and credential-material writes advance last_rotated_at. Capability: integration_plugins.write.';

COMMENT ON VIEW public.v_integration_credential_directory IS
  'FE-friendly projection of provider_auth_configs. Tenant- and source-bound provider-account settings make global route credentials visible to the owning tenant without exposing credential JSON. Revoked tombstones surface status=revoked instead of expired. last_rotated_at comes from provider_auth_configs.last_rotated_at with created_at fallback.';

REVOKE ALL ON public.v_integration_credential_directory FROM PUBLIC;
REVOKE ALL ON public.v_integration_credential_directory FROM anon;
GRANT SELECT ON public.v_integration_credential_directory TO authenticated;
GRANT SELECT ON public.v_integration_credential_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605221150_provider_auth_last_rotated_at_v1'));

COMMIT;
