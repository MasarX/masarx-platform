-- Console V2 provider-account route policy guard.
--
-- Purpose:
--   API provider-account credential binding must be controlled by the
--   selected api_routes.policy row. Caller-supplied provider/category/auth
--   values may not override or conflict with the route policy.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605091100_console_v2_provider_account_route_policy_guard_v1'));

SET search_path TO public, vault, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;

CREATE OR REPLACE FUNCTION public.ui_bind_provider_account_credential_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, vault, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := COALESCE(public.is_platform_user(), FALSE);
  v_target_org_id UUID := COALESCE(
    NULLIF(p_args->>'organization_id', '')::uuid,
    NULLIF(p_args->>'tenant_id', '')::uuid,
    CASE WHEN NULLIF(p_args->>'scope_type', '') = 'tenant' THEN NULLIF(p_args->>'scope_id', '')::uuid ELSE NULL END,
    v_user_org_id
  );
  v_scope_type TEXT := COALESCE(NULLIF(btrim(p_args->>'scope_type'), ''), 'tenant');
  v_scope_id UUID := NULLIF(p_args->>'scope_id', '')::uuid;
  v_source_id UUID := COALESCE(NULLIF(p_args->>'source_id', '')::uuid, CASE WHEN v_scope_type = 'source' THEN v_scope_id ELSE NULL END);
  v_route_id UUID := NULLIF(p_args->>'route_id', '')::uuid;
  v_route_method TEXT := upper(COALESCE(NULLIF(btrim(p_args->>'route_method'), ''), NULLIF(btrim(p_args->>'method'), '')));
  v_route_path TEXT := COALESCE(NULLIF(btrim(p_args->>'route_path'), ''), NULLIF(btrim(p_args->>'path_template'), ''));
  v_route_provider_id UUID;
  v_route_category TEXT;
  v_route_auth_type TEXT;
  v_requested_provider_id UUID := NULLIF(p_args->>'provider_id', '')::uuid;
  v_provider_id UUID := v_requested_provider_id;
  v_provider_org_id UUID;
  v_nil_org UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_requested_provider_account_category TEXT := COALESCE(
    NULLIF(btrim(p_args->>'provider_account_category'), ''),
    NULLIF(btrim(p_args->>'category'), '')
  );
  v_provider_account_category TEXT := v_requested_provider_account_category;
  v_requested_auth_type TEXT := NULLIF(btrim(p_args->>'auth_type'), '');
  v_auth_type TEXT := COALESCE(v_requested_auth_type, 'basic_auth');
  v_auth_config_id UUID := COALESCE(
    NULLIF(p_args->>'auth_config_id', '')::uuid,
    NULLIF(p_args->>'provider_auth_config_id', '')::uuid,
    NULLIF(p_args->>'config_id', '')::uuid
  );
  v_credentials JSONB := CASE WHEN p_args ? 'credentials' THEN p_args->'credentials' ELSE NULL END;
  v_credentials_vault_id UUID := NULLIF(p_args->>'credentials_vault_id', '')::uuid;
  v_expires_at TIMESTAMPTZ := NULLIF(p_args->>'expires_at', '')::timestamptz;
  v_company_id TEXT := NULLIF(btrim(COALESCE(p_args->>'company_id', p_args #>> '{provider_account,company_id}')), '');
  v_existing JSONB := NULL;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_settings_version_number INT;
  v_existing_config RECORD;
  v_secret_name TEXT;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write');

  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires tenant organization scope'
      USING ERRCODE = '23502';
  END IF;

  IF NOT v_is_platform AND v_target_org_id <> v_user_org_id THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 tenant % outside caller scope', v_target_org_id
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type NOT IN ('tenant', 'source') THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 unsupported scope_type %', v_scope_type
      USING ERRCODE = '23514';
  END IF;

  IF v_scope_type = 'tenant' THEN
    v_scope_id := v_target_org_id;
  ELSIF v_scope_type = 'source' THEN
    IF v_source_id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 source scope requires source_id'
        USING ERRCODE = '23502';
    END IF;

    SELECT ws.organization_id
      INTO v_target_org_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_source_id
     LIMIT 1;

    IF v_target_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 source % not found', v_source_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT v_is_platform AND v_target_org_id <> v_user_org_id THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 source % outside caller scope', v_source_id
        USING ERRCODE = '42501';
    END IF;

    v_scope_id := v_source_id;
  END IF;

  IF v_route_id IS NOT NULL OR (v_route_method IS NOT NULL AND v_route_path IS NOT NULL) THEN
    SELECT r.id,
           r.provider_id,
           NULLIF(r.policy #>> '{provider_account,category}', ''),
           NULLIF(r.policy #>> '{auth,auth_type}', '')
      INTO v_route_id,
           v_route_provider_id,
           v_route_category,
           v_route_auth_type
      FROM public.api_routes r
      JOIN public.api_route_packs p ON p.id = r.pack_id
     WHERE r.enabled = TRUE
       AND p.enabled = TRUE
       AND (
         (v_route_id IS NOT NULL AND r.id = v_route_id)
         OR (
           v_route_id IS NULL
           AND upper(r.method) = v_route_method
           AND r.path_template = v_route_path
         )
       )
     ORDER BY CASE r.scope_type
                WHEN 'source' THEN 1
                WHEN 'sender' THEN 2
                WHEN 'client' THEN 3
                WHEN 'tenant' THEN 4
                ELSE 5
              END,
              r.updated_at DESC
     LIMIT 1;

    IF v_route_id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 API route not found'
        USING ERRCODE = '23503';
    END IF;

    IF v_route_category IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 API route % has no provider_account category', v_route_id
        USING ERRCODE = '23514';
    END IF;

    IF v_route_provider_id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 API route % has no provider_id', v_route_id
        USING ERRCODE = '23514';
    END IF;

    IF v_requested_provider_account_category IS NOT NULL
       AND v_requested_provider_account_category <> v_route_category THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider_account_category % conflicts with route policy %',
        v_requested_provider_account_category, v_route_category
        USING ERRCODE = '23514';
    END IF;

    IF v_requested_provider_id IS NOT NULL
       AND v_requested_provider_id <> v_route_provider_id THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider_id % conflicts with route provider %',
        v_requested_provider_id, v_route_provider_id
        USING ERRCODE = '23514';
    END IF;

    IF v_requested_auth_type IS NOT NULL
       AND v_route_auth_type IS NOT NULL
       AND v_requested_auth_type <> v_route_auth_type THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 auth_type % conflicts with route policy %',
        v_requested_auth_type, v_route_auth_type
        USING ERRCODE = '23514';
    END IF;

    v_provider_id := v_route_provider_id;
    v_provider_account_category := v_route_category;
    v_auth_type := COALESCE(v_route_auth_type, v_requested_auth_type, 'basic_auth');
  END IF;

  IF v_provider_account_category IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires provider_account_category or route reference'
      USING ERRCODE = '23502';
  END IF;

  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires provider_id or route reference'
      USING ERRCODE = '23502';
  END IF;

  SELECT p.organization_id
    INTO v_provider_org_id
    FROM public.providers p
   WHERE p.id = v_provider_id
   LIMIT 1;

  IF v_provider_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider % not found', v_provider_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_is_platform
     AND v_provider_org_id NOT IN (v_target_org_id, v_nil_org) THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider % outside caller scope', v_provider_id
      USING ERRCODE = '42501';
  END IF;

  SELECT cached_value
    INTO v_existing
    FROM public.settings
   WHERE category = v_provider_account_category
     AND scope_type = v_scope_type
     AND scope_id IS NOT DISTINCT FROM v_scope_id
   LIMIT 1;

  IF v_company_id IS NULL THEN
    v_company_id := NULLIF(COALESCE(v_existing->>'company_id', ''), '');
  END IF;

  IF v_company_id IS NULL THEN
    SELECT NULLIF(resolved.value->>'company_id', '')
      INTO v_company_id
      FROM public.resolve_settings_row(v_provider_account_category, v_scope_type, v_scope_id) AS resolved
     LIMIT 1;
  END IF;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires company_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_auth_config_id IS NULL THEN
    IF v_credentials_vault_id IS NULL AND v_credentials IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires auth_config_id or credentials'
        USING ERRCODE = '23502';
    END IF;

    IF v_credentials IS NOT NULL THEN
      IF jsonb_typeof(v_credentials) <> 'object' THEN
        RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 credentials must be a JSON object'
          USING ERRCODE = '22023';
      END IF;

      IF v_auth_type = 'basic_auth'
         AND (
           NULLIF(v_credentials->>'username', '') IS NULL
           OR NULLIF(v_credentials->>'password', '') IS NULL
         ) THEN
        RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 basic_auth credentials require username and password'
          USING ERRCODE = '23502';
      END IF;

      v_auth_config_id := gen_random_uuid();
      v_secret_name := format('provider_auth_configs/%s', v_auth_config_id);
      SELECT vault.create_secret(
        v_credentials::text,
        v_secret_name,
        format('Console V2 provider account credential binding %s', v_auth_config_id),
        NULL
      )
        INTO v_credentials_vault_id;
    ELSE
      v_auth_config_id := gen_random_uuid();
    END IF;

    INSERT INTO public.provider_auth_configs (
      id,
      provider_id,
      auth_type,
      credentials_vault_id,
      credentials,
      expires_at
    ) VALUES (
      v_auth_config_id,
      v_provider_id,
      v_auth_type,
      v_credentials_vault_id,
      NULL,
      v_expires_at
    );
  ELSE
    SELECT pac.id, pac.provider_id, pac.auth_type, p.organization_id AS provider_org_id
      INTO v_existing_config
      FROM public.provider_auth_configs pac
      JOIN public.providers p ON p.id = pac.provider_id
     WHERE pac.id = v_auth_config_id
     LIMIT 1;

    IF v_existing_config.id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider_auth_config % not found', v_auth_config_id
        USING ERRCODE = '23503';
    END IF;

    IF v_existing_config.auth_type <> v_auth_type THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 auth_type mismatch: config % is %, route expects %',
        v_auth_config_id, v_existing_config.auth_type, v_auth_type
        USING ERRCODE = '23514';
    END IF;

    IF v_existing_config.provider_id <> v_provider_id THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider mismatch: config % belongs to provider %, route expects %',
        v_auth_config_id, v_existing_config.provider_id, v_provider_id
        USING ERRCODE = '23514';
    END IF;

    IF NOT v_is_platform
       AND v_existing_config.provider_org_id NOT IN (v_target_org_id, v_nil_org) THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 credential % outside caller scope', v_auth_config_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT us.settings_id, us.settings_version_id, us.settings_version_number
    INTO v_settings_id, v_settings_version_id, v_settings_version_number
    FROM public.upsert_settings_value_v1(
      v_provider_account_category,
      v_scope_type,
      v_scope_id,
      jsonb_strip_nulls(jsonb_build_object(
        'enabled', COALESCE((p_args->>'enabled')::boolean, TRUE),
        'company_id', v_company_id,
        'auth_config_id', v_auth_config_id::text,
        'notes', NULLIF(btrim(p_args->>'notes'), '')
      )),
      1,
      COALESCE(NULLIF(btrim(p_args->>'reason'), ''), 'Console V2 provider account credential binding')
    ) AS us;

  PERFORM public.log_decision(
    p_organization_id := v_target_org_id,
    p_decision_category := 'settings',
    p_resource_type := 'settings',
    p_resource_id := v_settings_id,
    p_decision_point := 'provider_account_credential_bound',
    p_decision_outcome := 'bound',
    p_performed_by_system := format('console_v2:%s', v_user_id),
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'provider_account_category', v_provider_account_category,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'provider_id', v_provider_id,
      'route_id', v_route_id,
      'auth_type', v_auth_type,
      'auth_config_id', v_auth_config_id,
      'company_id', v_company_id,
      'credentials_vault_id', v_credentials_vault_id
    )),
    p_decision_reason := 'Provider account credential binding updated through Console V2.'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'provider_account_category', v_provider_account_category,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'organization_id', v_target_org_id,
    'provider_id', v_provider_id,
    'route_id', v_route_id,
    'auth_type', v_auth_type,
    'provider_auth_config_id', v_auth_config_id,
    'auth_config_id', v_auth_config_id,
    'credentials_vault_id', v_credentials_vault_id,
    'company_id', v_company_id,
    'settings_id', v_settings_id,
    'settings_version_id', v_settings_version_id,
    'settings_version_number', v_settings_version_number,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_bind_provider_account_credential_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_bind_provider_account_credential_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_bind_provider_account_credential_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_bind_provider_account_credential_v1(jsonb)
  IS 'Console V2 write RPC: bind provider credentials through api_routes.policy provider_account. Caller-supplied provider/category/auth conflicts fail closed.';

SELECT pg_advisory_unlock(hashtext('202605091100_console_v2_provider_account_route_policy_guard_v1'));

COMMIT;
