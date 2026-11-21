-- pgTAP: Console V2 provider-account credential binding for API shipment routes.
-- Scope: verifies the browser-facing RPC that binds a Vault-backed provider
-- credential into the row-driven provider_account settings used by API Gateway.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);
SET LOCAL pgtap.vendor_company_id = '999999';

CREATE OR REPLACE FUNCTION pg_temp.test_provider_account_credential_binding_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000099213001';
  v_other_org UUID := '00000000-0000-0000-0000-000099213002';
  v_ops UUID := '00000000-0000-0000-0000-000099213011';
  v_wrong_provider UUID := '00000000-0000-0000-0000-000099213021';
  v_wrong_config UUID := '00000000-0000-0000-0000-000099213022';
  v_custom_provider UUID := '00000000-0000-0000-0000-000099213023';
  v_custom_pack UUID := '00000000-0000-0000-0000-000099213031';
  v_custom_route UUID := '00000000-0000-0000-0000-000099213032';
  v_custom_category TEXT := 'pgtap_provider_account_binding_custom_20260529';
  v_result JSONB := '{}'::jsonb;
  v_unbind_result JSONB := '{}'::jsonb;
  v_custom_result JSONB := '{}'::jsonb;
  v_custom_unbind_result JSONB := '{}'::jsonb;
  v_config_id UUID;
  v_custom_config_id UUID;
  v_settings_row public.settings%ROWTYPE;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Console V2 Provider Account Binding Org', 'console-v2-provider-account-binding'),
    (v_other_org, 'Console V2 Provider Account Binding Other Org', 'console-v2-provider-account-binding-other')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_ops,
    v_org,
    'console-v2-provider-account-binding@example.com',
    'Console V2 Provider Account Binding Ops',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status, metadata)
  VALUES
    (
      v_wrong_provider,
      v_org,
      'Console V2 Wrong Provider For Binding Test',
      'http',
      TRUE,
      990,
      'healthy',
      jsonb_build_object('purpose', 'provider-account-binding-negative')
    ),
    (
      v_custom_provider,
      v_org,
      'Console V2 Custom Provider Account Category Test',
      'http',
      TRUE,
      991,
      'healthy',
      jsonb_build_object('purpose', 'provider-account-custom-category')
    )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         provider_type = EXCLUDED.provider_type,
         enabled = EXCLUDED.enabled,
         health_status = EXCLUDED.health_status;

  INSERT INTO public.provider_auth_configs (id, provider_id, auth_type, credentials, expires_at)
  VALUES (
    v_wrong_config,
    v_wrong_provider,
    'basic_auth',
    jsonb_build_object('username', 'wrong-provider', 'password', 'wrong-provider'),
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET provider_id = EXCLUDED.provider_id,
         auth_type = EXCLUDED.auth_type,
         credentials = EXCLUDED.credentials,
         expires_at = EXCLUDED.expires_at;

  INSERT INTO public.api_route_packs (
    id,
    name,
    description,
    enabled,
    scope_type,
    scope_id,
    managed_by,
    managed_metadata
  )
  VALUES (
    v_custom_pack,
    'pgtap-provider-account-custom-category',
    'pgTAP custom provider-account category pack',
    TRUE,
    'tenant',
    v_org,
    'platform',
    jsonb_build_object('purpose', 'provider-account-custom-category')
  )
  ON CONFLICT (id) DO UPDATE
     SET description = EXCLUDED.description,
         enabled = EXCLUDED.enabled,
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         managed_by = EXCLUDED.managed_by,
         managed_metadata = EXCLUDED.managed_metadata;

  INSERT INTO public.api_routes (
    id,
    pack_id,
    route_name,
    enabled,
    method,
    path_template,
    scope_type,
    scope_id,
    provider_id,
    upstream_method,
    upstream_path_template,
    policy,
    managed_by,
    managed_metadata
  )
  VALUES (
    v_custom_route,
    v_custom_pack,
    'pgtap_provider_account_custom_category',
    TRUE,
    'POST',
    '/pgtap/provider-account/custom-category',
    'tenant',
    v_org,
    v_custom_provider,
    'POST',
    '/upstream/pgtap/provider-account/custom-category',
    jsonb_build_object(
      'auth', jsonb_build_object('auth_type', 'basic_auth'),
      'provider_account', jsonb_build_object(
        'category', v_custom_category,
        'required', TRUE,
        'require_company_id', TRUE
      )
    ),
    'platform',
    jsonb_build_object('purpose', 'provider-account-custom-category')
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
     SET pack_id = EXCLUDED.pack_id,
         route_name = EXCLUDED.route_name,
         enabled = EXCLUDED.enabled,
         provider_id = EXCLUDED.provider_id,
         upstream_method = EXCLUDED.upstream_method,
         upstream_path_template = EXCLUDED.upstream_path_template,
         policy = EXCLUDED.policy,
         managed_by = EXCLUDED.managed_by,
         managed_metadata = EXCLUDED.managed_metadata;

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM public.api_routes r
       WHERE NULLIF(r.policy #>> '{provider_account,category}', '') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.schema_registry sr
            WHERE sr.category = r.policy #>> '{provider_account,category}'
              AND sr.version = 1
              AND sr.is_active = TRUE
         )
    ),
    'all api_routes provider_account categories have active schema_registry rows'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.settings_category_registry scr
       WHERE scr.category = v_custom_category
         AND scr.requires_schema = TRUE
         AND scr.safe_missing_behavior = 'hard_fail'
         AND scr.allowed_scopes @> '["tenant","source"]'::jsonb
    ),
    'api_routes provider_account trigger registers custom category in settings_category_registry'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.schema_registry sr
       WHERE sr.category = v_custom_category
         AND sr.version = 1
         AND sr.is_active = TRUE
         AND sr.schema #> '{properties,auth_config_id,anyOf}' @> jsonb_build_array(jsonb_build_object('type', 'null'))
         AND sr.schema #> '{properties}' ? 'unbound_at'
    ),
    'api_routes provider_account trigger registers schema that supports explicit unbind state'
  );

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_custom_result := api.ui_bind_provider_account_credential_v1(jsonb_build_object(
    'route_id', v_custom_route,
    'provider_account_category', v_custom_category,
    'organization_id', v_org,
    'scope_type', 'tenant',
    'company_id', '736259291800',
    'credentials', jsonb_build_object(
      'username', 'pgtap-custom-route-user',
      'password', 'pgtap-custom-route-password'
    ),
    'reason', 'pgTAP custom provider-account category bind proof'
  ));
  v_custom_config_id := NULLIF(v_custom_result->>'provider_auth_config_id', '')::uuid;

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT *
    INTO v_settings_row
    FROM public.settings s
   WHERE s.category = v_custom_category
     AND s.scope_type = 'tenant'
     AND s.scope_id = v_org
   LIMIT 1;

  RETURN NEXT ok(
    COALESCE((v_custom_result->>'ok')::boolean, FALSE)
    AND v_custom_result->>'provider_account_category' = v_custom_category
    AND v_custom_config_id IS NOT NULL
    AND v_settings_row.cached_value->>'company_id' = '736259291800'
    AND v_settings_row.cached_value->>'auth_config_id' = v_custom_config_id::text,
    'binding RPC succeeds for row-driven custom route provider_account category'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  v_custom_unbind_result := api.ui_unbind_provider_account_credential_v1(jsonb_build_object(
    'route_id', v_custom_route,
    'provider_account_category', v_custom_category,
    'organization_id', v_org,
    'scope_type', 'tenant',
    'reason', 'pgTAP custom provider-account category unbind proof'
  ));

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT *
    INTO v_settings_row
    FROM public.settings s
   WHERE s.category = v_custom_category
     AND s.scope_type = 'tenant'
     AND s.scope_id = v_org
   LIMIT 1;

  RETURN NEXT ok(
    COALESCE((v_custom_unbind_result->>'ok')::boolean, FALSE)
    AND COALESCE((v_custom_unbind_result->>'bound')::boolean, TRUE) = FALSE
    AND v_custom_unbind_result->>'previous_auth_config_id' = v_custom_config_id::text
    AND v_settings_row.cached_value->'auth_config_id' = 'null'::jsonb
    AND COALESCE((v_settings_row.cached_value->>'enabled')::boolean, TRUE) = FALSE,
    'unbind RPC succeeds for row-driven custom route provider_account category'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_bind_provider_account_credential_v1(jsonb_build_object(
    'route_method', 'POST',
    'route_path', '/api/ship/request/by-email',
    'organization_id', v_org,
    'scope_type', 'tenant',
    'company_id', current_setting('pgtap.vendor_company_id'),
    'credentials', jsonb_build_object(
      'username', 'pgtap-logestechs-user',
      'password', 'pgtap-logestechs-password'
    ),
    'reason', 'pgTAP provider-account binding proof'
  ));
  v_config_id := NULLIF(v_result->>'provider_auth_config_id', '')::uuid;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    COALESCE((v_result->>'ok')::boolean, FALSE)
    AND v_result->>'provider_account_category' = 'logestechs_v2_account'
    AND v_result->>'auth_type' = 'basic_auth'
    AND v_config_id IS NOT NULL,
    'binding RPC resolves API route provider_account category and returns auth_config_id'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.provider_auth_configs pac
       WHERE pac.id = v_config_id
         AND pac.auth_type = 'basic_auth'
         AND pac.credentials IS NULL
         AND pac.credentials_vault_id IS NOT NULL
    ),
    'binding RPC creates Vault-backed provider_auth_configs row without table plaintext'
  );

  RETURN NEXT is(
    public.get_provider_auth_credentials(v_config_id)->>'username',
    'pgtap-logestechs-user',
    'Vault-backed provider auth credential resolves through SSOT helper'
  );

  SELECT *
    INTO v_settings_row
    FROM public.settings s
   WHERE s.category = 'logestechs_v2_account'
     AND s.scope_type = 'tenant'
     AND s.scope_id = v_org
   LIMIT 1;

  RETURN NEXT ok(
    v_settings_row.id IS NOT NULL
    AND v_settings_row.cached_value->>'company_id' = current_setting('pgtap.vendor_company_id')
    AND NULLIF(v_settings_row.cached_value->>'auth_config_id', '')::uuid = v_config_id,
    'binding RPC writes tenant logestechs_v2_account setting with company_id and auth_config_id'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.settings_versions sv
       WHERE sv.id = v_settings_row.settings_version_id
         AND sv.category = 'logestechs_v2_account'
         AND sv.scope_type = 'tenant'
         AND sv.scope_id = v_org
         AND sv.value->>'auth_config_id' = v_config_id::text
    ),
    'binding RPC persists append-only settings_versions lineage'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.decision_category = 'settings'
         AND dl.resource_id = v_settings_row.id
         AND dl.decision_inputs->>'auth_config_id' = v_config_id::text
    ),
    'binding RPC records governance decision evidence'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.v_integration_credential_directory v
       WHERE v.id = v_config_id
         AND v.organization_id = v_org
         AND v.provider_account_category = 'logestechs_v2_account'
         AND v.company_id = current_setting('pgtap.vendor_company_id')
         AND v.auth_type = 'basic_auth'
    ),
    'credential directory exposes tenant-bound global API route credential readback'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  v_unbind_result := api.ui_unbind_provider_account_credential_v1(jsonb_build_object(
    'route_method', 'POST',
    'route_path', '/api/ship/request/by-email',
    'organization_id', v_org,
    'scope_type', 'tenant',
    'reason', 'pgTAP provider-account unbind proof'
  ));

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT *
    INTO v_settings_row
    FROM public.settings s
   WHERE s.category = 'logestechs_v2_account'
     AND s.scope_type = 'tenant'
     AND s.scope_id = v_org
   LIMIT 1;

  RETURN NEXT ok(
    COALESCE((v_unbind_result->>'ok')::boolean, FALSE)
    AND COALESCE((v_unbind_result->>'bound')::boolean, TRUE) = FALSE
    AND v_unbind_result->>'previous_auth_config_id' = v_config_id::text,
    'unbind RPC returns previous auth_config_id and unbound state'
  );

  RETURN NEXT ok(
    v_settings_row.cached_value ? 'auth_config_id'
    AND v_settings_row.cached_value->'auth_config_id' = 'null'::jsonb
    AND COALESCE((v_settings_row.cached_value->>'enabled')::boolean, TRUE) = FALSE
    AND v_settings_row.cached_value->>'company_id' = current_setting('pgtap.vendor_company_id'),
    'unbind RPC writes explicit null auth_config_id override while preserving company_id'
  );

  RETURN NEXT ok(
    public.resolve_settings_merged('logestechs_v2_account', 'tenant', v_org)->'auth_config_id' = 'null'::jsonb,
    'merged provider account settings keep auth_config_id cleared after unbind'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.decision_category = 'settings'
         AND dl.resource_id = v_settings_row.id
         AND dl.decision_point = 'provider_account_credential_unbound'
         AND dl.decision_inputs->>'previous_auth_config_id' = v_config_id::text
    ),
    'unbind RPC records governance decision evidence'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    $$ SELECT api.ui_bind_provider_account_credential_v1(jsonb_build_object(
         'route_method', 'POST',
         'route_path', '/api/ship/request/by-email',
         'company_id', current_setting('pgtap.vendor_company_id'),
         'credentials', jsonb_build_object('username', 'missing-password')
       )) $$,
    '23502',
    NULL,
    'binding RPC rejects incomplete basic_auth credentials'
  );

  RETURN NEXT throws_ok(
    $$ SELECT api.ui_bind_provider_account_credential_v1(jsonb_build_object(
         'route_method', 'POST',
         'route_path', '/api/ship/request/by-email',
         'provider_account_category', 'wrong_provider_account_category',
         'company_id', current_setting('pgtap.vendor_company_id'),
         'credentials', jsonb_build_object('username', 'conflict', 'password', 'conflict')
       )) $$,
    '23514',
    NULL,
    'binding RPC rejects caller category that conflicts with selected route policy'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT api.ui_bind_provider_account_credential_v1(jsonb_build_object(
           'route_method', 'POST',
           'route_path', '/api/ship/request/by-email',
           'provider_id', %L,
           'company_id', current_setting('pgtap.vendor_company_id'),
           'credentials', jsonb_build_object('username', 'conflict', 'password', 'conflict')
         )) $$,
      v_wrong_provider::text
    ),
    '23514',
    NULL,
    'binding RPC rejects caller provider that conflicts with selected route policy'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT api.ui_bind_provider_account_credential_v1(jsonb_build_object(
           'route_method', 'POST',
           'route_path', '/api/ship/request/by-email',
           'organization_id', %L,
           'scope_type', 'tenant',
           'company_id', current_setting('pgtap.vendor_company_id'),
           'auth_config_id', %L
         )) $$,
      v_org::text,
      v_wrong_config::text
    ),
    '23514',
    NULL,
    'binding RPC rejects existing credentials from a different provider'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT api.ui_bind_provider_account_credential_v1(jsonb_build_object(
           'route_method', 'POST',
           'route_path', '/api/ship/request/by-email',
           'organization_id', %L,
           'scope_type', 'tenant',
           'company_id', current_setting('pgtap.vendor_company_id'),
           'credentials', jsonb_build_object('username', 'cross-tenant', 'password', 'blocked')
         )) $$,
      v_other_org::text
    ),
    '42501',
    NULL,
    'binding RPC rejects cross-tenant provider account binding'
  );

  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_bind_provider_account_credential_v1(jsonb)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'api.ui_unbind_provider_account_credential_v1(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'api.ui_bind_provider_account_credential_v1(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'api.ui_unbind_provider_account_credential_v1(jsonb)', 'EXECUTE'),
    'api wrappers are executable by authenticated callers only'
  );
END;
$function$;

SELECT * FROM pg_temp.test_provider_account_credential_binding_v1();

SELECT * FROM finish();
ROLLBACK;
