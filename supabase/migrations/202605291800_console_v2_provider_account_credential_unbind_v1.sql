-- Console V2 provider-account credential unbind.
--
-- Purpose:
--   Complete the operator lifecycle for route-driven provider accounts by
--   allowing Console V2 to clear the active auth_config_id through the same
--   settings SSOT used by binding. The unbound row writes an explicit JSON null
--   so merged ladder reads do not inherit a less-specific credential.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605291800_console_v2_provider_account_credential_unbind_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_unbind_provider_account_credential_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
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
  v_requested_provider_account_category TEXT := COALESCE(
    NULLIF(btrim(p_args->>'provider_account_category'), ''),
    NULLIF(btrim(p_args->>'category'), '')
  );
  v_provider_account_category TEXT := v_requested_provider_account_category;
  v_route_category TEXT;
  v_route_provider_id UUID;
  v_existing JSONB := NULL;
  v_resolved JSONB := NULL;
  v_company_id TEXT := NULLIF(btrim(COALESCE(p_args->>'company_id', p_args #>> '{provider_account,company_id}')), '');
  v_previous_auth_config_id UUID := NULL;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_settings_version_number INT;
  v_settings_value JSONB;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write');

  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 requires tenant organization scope'
      USING ERRCODE = '23502';
  END IF;

  IF NOT v_is_platform AND v_target_org_id <> v_user_org_id THEN
    RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 tenant % outside caller scope', v_target_org_id
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type NOT IN ('tenant', 'source') THEN
    RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 unsupported scope_type %', v_scope_type
      USING ERRCODE = '23514';
  END IF;

  IF v_scope_type = 'tenant' THEN
    v_scope_id := v_target_org_id;
  ELSIF v_scope_type = 'source' THEN
    IF v_source_id IS NULL THEN
      RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 source scope requires source_id'
        USING ERRCODE = '23502';
    END IF;

    SELECT ws.organization_id
      INTO v_target_org_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_source_id
     LIMIT 1;

    IF v_target_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 source % not found', v_source_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT v_is_platform AND v_target_org_id <> v_user_org_id THEN
      RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 source % outside caller scope', v_source_id
        USING ERRCODE = '42501';
    END IF;

    v_scope_id := v_source_id;
  END IF;

  IF v_route_id IS NOT NULL OR (v_route_method IS NOT NULL AND v_route_path IS NOT NULL) THEN
    SELECT r.id,
           r.provider_id,
           NULLIF(r.policy #>> '{provider_account,category}', '')
      INTO v_route_id,
           v_route_provider_id,
           v_route_category
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
      RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 API route not found'
        USING ERRCODE = '23503';
    END IF;

    IF v_route_category IS NULL THEN
      RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 API route % has no provider_account category', v_route_id
        USING ERRCODE = '23514';
    END IF;

    IF v_route_provider_id IS NULL THEN
      RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 API route % has no provider_id', v_route_id
        USING ERRCODE = '23514';
    END IF;

    IF v_requested_provider_account_category IS NOT NULL
       AND v_requested_provider_account_category <> v_route_category THEN
      RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 provider_account_category % conflicts with route policy %',
        v_requested_provider_account_category, v_route_category
        USING ERRCODE = '23514';
    END IF;

    v_provider_account_category := v_route_category;
  END IF;

  IF v_provider_account_category IS NULL THEN
    RAISE EXCEPTION 'ui_unbind_provider_account_credential_v1 requires provider_account_category or route reference'
      USING ERRCODE = '23502';
  END IF;

  SELECT s.cached_value
    INTO v_existing
    FROM public.settings s
   WHERE s.category = v_provider_account_category
     AND s.scope_type = v_scope_type
     AND s.scope_id IS NOT DISTINCT FROM v_scope_id
   LIMIT 1;

  v_resolved := public.resolve_settings_merged(v_provider_account_category, v_scope_type, v_scope_id);

  IF v_company_id IS NULL THEN
    v_company_id := NULLIF(COALESCE(v_existing->>'company_id', ''), '');
  END IF;

  IF v_company_id IS NULL THEN
    v_company_id := NULLIF(COALESCE(v_resolved->>'company_id', ''), '');
  END IF;

  BEGIN
    v_previous_auth_config_id := NULLIF(
      COALESCE(v_existing->>'auth_config_id', v_resolved->>'auth_config_id', ''),
      ''
    )::uuid;
  EXCEPTION WHEN others THEN
    v_previous_auth_config_id := NULL;
  END;

  v_settings_value := jsonb_build_object(
    'enabled', FALSE,
    'auth_config_id', NULL,
    'unbound_at', clock_timestamp()
  );

  IF v_company_id IS NOT NULL THEN
    v_settings_value := v_settings_value || jsonb_build_object('company_id', v_company_id);
  END IF;

  IF NULLIF(btrim(p_args->>'notes'), '') IS NOT NULL THEN
    v_settings_value := v_settings_value || jsonb_build_object('notes', NULLIF(btrim(p_args->>'notes'), ''));
  END IF;

  SELECT us.settings_id, us.settings_version_id, us.settings_version_number
    INTO v_settings_id, v_settings_version_id, v_settings_version_number
    FROM public.upsert_settings_value_v1(
      v_provider_account_category,
      v_scope_type,
      v_scope_id,
      v_settings_value,
      1,
      COALESCE(NULLIF(btrim(p_args->>'reason'), ''), 'Console V2 provider account credential unbind')
    ) AS us;

  PERFORM public.log_decision(
    p_organization_id := v_target_org_id,
    p_decision_category := 'settings',
    p_resource_type := 'settings',
    p_resource_id := v_settings_id,
    p_decision_point := 'provider_account_credential_unbound',
    p_decision_outcome := 'unbound',
    p_performed_by_system := format('console_v2:%s', v_user_id),
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'provider_account_category', v_provider_account_category,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'route_id', v_route_id,
      'provider_id', v_route_provider_id,
      'previous_auth_config_id', v_previous_auth_config_id,
      'company_id', v_company_id
    )),
    p_decision_reason := 'Provider account credential association removed through Console V2.'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'bound', false,
    'provider_account_category', v_provider_account_category,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'organization_id', v_target_org_id,
    'provider_id', v_route_provider_id,
    'route_id', v_route_id,
    'previous_auth_config_id', v_previous_auth_config_id,
    'auth_config_id', NULL,
    'company_id', v_company_id,
    'settings_id', v_settings_id,
    'settings_version_id', v_settings_version_id,
    'settings_version_number', v_settings_version_number,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_unbind_provider_account_credential_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_unbind_provider_account_credential_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_unbind_provider_account_credential_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_unbind_provider_account_credential_v1(jsonb)
  IS 'Console V2 write RPC: unbind provider-account credentials by writing an explicit null auth_config_id settings override through the row-driven provider_account route policy.';

CREATE OR REPLACE FUNCTION api.ui_unbind_provider_account_credential_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, api, extensions, pg_temp
AS $function$
  SELECT public.ui_unbind_provider_account_credential_v1(COALESCE(p_args, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION api.ui_unbind_provider_account_credential_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_unbind_provider_account_credential_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_unbind_provider_account_credential_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_unbind_provider_account_credential_v1(jsonb)
  IS 'API-schema wrapper for Console V2 provider-account credential unbind.';

SELECT pg_advisory_unlock(hashtext('202605291800_console_v2_provider_account_credential_unbind_v1'));

COMMIT;
