-- pgTAP: public.v_integration_credential_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W27 (paired projection views - INTEGRATIONS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

-- 1) View exists
SELECT has_view(
  'public', 'v_integration_credential_directory',
  'public.v_integration_credential_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_integration_credential_directory',
  ARRAY[
    'id', 'provider_id', 'auth_type', 'auth_type_label',
    'expires_at', 'created_at', 'last_rotated_at',
    'status', 'days_until_expiry',
    'provider_label', 'provider_kind', 'provider_vendor',
    'is_expiring', 'is_expired', 'is_active',
    'mask_state', 'organization_id',
    'provider_account_category', 'company_id',
    'bound_scope_type', 'bound_scope_id', 'bound_settings_version_id'
  ],
  'v_integration_credential_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_integration_credential_directory', 'SELECT'),
  'service_role has SELECT on v_integration_credential_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_integration_credential_directory', 'SELECT'),
  'anon has no SELECT on v_integration_credential_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_integration_credential_directory', 'SELECT'),
  'authenticated has SELECT on v_integration_credential_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'provider_auth_configs'
       AND c.relkind = 'r'
  ),
  'public.provider_auth_configs remains a base table (SSOT preserved)'
);

-- 7) Projection: insert provider + auth_config; verify status='active' for
--    far-future expiry, plus provider_label / provider_kind / provider_vendor
--    derivations.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000027d001';
  v_prov   UUID := '00000000-0000-0000-0000-00000027d002';
  v_pac    UUID := '00000000-0000-0000-0000-00000027d003';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W27 Cred Org', 'w27-cred-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (
    id, organization_id, name, provider_type, enabled, metadata
  )
  VALUES (
    v_prov, v_org, 'W27 Provider', '3pl', TRUE,
    jsonb_build_object('vendor', 'W27Vendor')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.provider_auth_configs (
    id, provider_id, auth_type, credentials, expires_at, created_at
  )
  VALUES (
    v_pac, v_prov, 'api_key',
    jsonb_build_object('encrypted', 'redacted'),
    now() + INTERVAL '180 days',
    now() - INTERVAL '15 days'
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_integration_credential_directory
    WHERE id = '00000000-0000-0000-0000-00000027d003'::UUID
      AND status = 'active'
      AND provider_label = 'W27 Provider'
      AND provider_kind = '3pl'
      AND provider_vendor = 'W27Vendor'
      AND days_until_expiry > 100
      AND is_active = TRUE
      AND is_expiring = FALSE
      AND is_expired = FALSE
      AND last_rotated_at = created_at
  ),
  'v_integration_credential_directory: far-future expiry resolves status=active + provider_label/kind/vendor + days_until_expiry + is_active=TRUE + last_rotated_at fallback to created_at'
);

-- 8) Secret-material replacement must move last_rotated_at forward without
--    exposing credential material in the browser-safe directory.
DO $$
DECLARE
  v_pac UUID := '00000000-0000-0000-0000-00000027d003';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.provider_auth_configs
     SET credentials = jsonb_build_object('encrypted', 'rotated-redacted')
   WHERE id = v_pac;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_integration_credential_directory
    WHERE id = '00000000-0000-0000-0000-00000027d003'::uuid
      AND last_rotated_at > created_at
      AND mask_state = TRUE
      AND status = 'active'
  ),
  'v_integration_credential_directory: secret-material replacement advances last_rotated_at while keeping browser-safe masked active state'
);

-- 9) Expiry status projection: expiring soon (within 30 days) -> status='expiring'
--    + is_expiring=TRUE; already expired -> status='expired' + is_expired=TRUE.
DO $$
DECLARE
  v_prov     UUID := '00000000-0000-0000-0000-00000027d002';
  v_pac_soon UUID := '00000000-0000-0000-0000-00000027d013';
  v_pac_old  UUID := '00000000-0000-0000-0000-00000027d014';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.provider_auth_configs (
    id, provider_id, auth_type, credentials, expires_at, created_at
  )
  VALUES
    (v_pac_soon, v_prov, 'oauth2',
      jsonb_build_object('encrypted', 'redacted'),
      now() + INTERVAL '15 days',
      now() - INTERVAL '60 days'),
    (v_pac_old, v_prov, 'api_key',
      jsonb_build_object('encrypted', 'redacted'),
      now() - INTERVAL '5 days',
      now() - INTERVAL '120 days')
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_integration_credential_directory soon
    JOIN public.v_integration_credential_directory old
      ON old.id = '00000000-0000-0000-0000-00000027d014'::UUID
    WHERE soon.id = '00000000-0000-0000-0000-00000027d013'::UUID
      AND soon.status = 'expiring'
      AND soon.is_expiring = TRUE
      AND soon.days_until_expiry BETWEEN 10 AND 20
      AND old.status = 'expired'
      AND old.is_expired = TRUE
      AND old.days_until_expiry < 0
  ),
  'v_integration_credential_directory: 15d-out resolves status=expiring + is_expiring=TRUE; -5d resolves status=expired + is_expired=TRUE + days_until_expiry<0'
);

-- 10) Source-scoped provider account settings must project credentials back to
--    the owning tenant. API Gateway testers resolve provider accounts from the
--    selected source, so source-bound expired/revoked credentials must not look
--    like missing credentials in Console.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000027d101';
  v_prov UUID := '00000000-0000-0000-0000-00000027d102';
  v_pac UUID := '00000000-0000-0000-0000-00000027d103';
  v_source UUID := '00000000-0000-0000-0000-00000027d104';
  v_settings_version UUID := '00000000-0000-0000-0000-00000027d105';
  v_mapping UUID := '00000000-0000-0000-0000-00000027d106';
  v_value JSONB := jsonb_build_object(
    'enabled', true,
    'company_id', '362',
    'auth_config_id', v_pac::text
  );
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W27 Source Credential Org', 'w27-source-credential-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (
    id, organization_id, name, provider_type, enabled, metadata
  )
  VALUES (
    v_prov, '00000000-0000-0000-0000-000000000000'::uuid,
    'W27 Global Source Provider', 'http', TRUE,
    jsonb_build_object('vendor', 'W27SourceVendor')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.provider_auth_configs (
    id, provider_id, auth_type, credentials, expires_at, created_at
  )
  VALUES (
    v_pac, v_prov, 'basic_auth',
    jsonb_build_object('encrypted', 'redacted'),
    now() - INTERVAL '1 day',
    now() - INTERVAL '10 days'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (
    id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes
  )
  VALUES (
    v_mapping, v_org, 'webhook_inbound', 'w27-source-credential',
    jsonb_build_object('fields', jsonb_build_object()),
    1,
    'pgTAP source-scoped provider credential mapping'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
  )
  VALUES (
    v_source, v_org, 'w27-source-credential', 'W27 Source Credential', 'api_gateway', 'redacted', v_mapping, TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, version, value, schema_version, change_reason, approved_at, effective_from, created_at
  )
  VALUES (
    v_settings_version, 'logestechs_v2_account', 'source', v_source, 1, v_value, 1,
    'pgTAP source-scoped provider account credential proof', now(), now(), now()
  );

  INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('logestechs_v2_account', 'source', v_source, v_settings_version, v_value, now())
  ON CONFLICT (category, scope_type, scope_hash)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_integration_credential_directory
     WHERE id = '00000000-0000-0000-0000-00000027d103'::uuid
       AND organization_id = '00000000-0000-0000-0000-00000027d101'::uuid
       AND provider_account_category = 'logestechs_v2_account'
       AND company_id = '362'
       AND bound_scope_type = 'source'
       AND bound_scope_id = '00000000-0000-0000-0000-00000027d104'::uuid
       AND status = 'expired'
       AND is_expired = TRUE
  ),
  'v_integration_credential_directory: source-scoped provider account credentials project to owning tenant with expired status'
);

-- 11) Source-scoped revoked provider account settings must project as revoked,
--     not active/expired, so API Gateway testers can block shipment creation
--     before a provider call is attempted.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000027d201';
  v_prov UUID := '00000000-0000-0000-0000-00000027d202';
  v_pac UUID := '00000000-0000-0000-0000-00000027d203';
  v_source UUID := '00000000-0000-0000-0000-00000027d204';
  v_settings_version UUID := '00000000-0000-0000-0000-00000027d205';
  v_mapping UUID := '00000000-0000-0000-0000-00000027d206';
  v_value JSONB := jsonb_build_object(
    'enabled', true,
    'company_id', '362',
    'auth_config_id', v_pac::text
  );
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W27 Revoked Source Credential Org', 'w27-revoked-source-credential-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (
    id, organization_id, name, provider_type, enabled, metadata
  )
  VALUES (
    v_prov, '00000000-0000-0000-0000-000000000000'::uuid,
    'W27 Global Revoked Source Provider', 'http', TRUE,
    jsonb_build_object('vendor', 'W27RevokedSourceVendor')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.provider_auth_configs (
    id, provider_id, auth_type, credentials, expires_at, created_at
  )
  VALUES (
    v_pac, v_prov, 'basic_auth',
    jsonb_build_object('revoked', true, 'reason', 'pgTAP revoked source-scoped provider credential proof'),
    now() + INTERVAL '180 days',
    now() - INTERVAL '10 days'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (
    id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes
  )
  VALUES (
    v_mapping, v_org, 'webhook_inbound', 'w27-revoked-source-credential',
    jsonb_build_object('fields', jsonb_build_object()),
    1,
    'pgTAP revoked source-scoped provider credential mapping'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
  )
  VALUES (
    v_source, v_org, 'w27-revoked-source-credential', 'W27 Revoked Source Credential', 'api_gateway', 'redacted-revoked', v_mapping, TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, version, value, schema_version, change_reason, approved_at, effective_from, created_at
  )
  VALUES (
    v_settings_version, 'logestechs_v2_account', 'source', v_source, 1, v_value, 1,
    'pgTAP revoked source-scoped provider account credential proof', now(), now(), now()
  );

  INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('logestechs_v2_account', 'source', v_source, v_settings_version, v_value, now())
  ON CONFLICT (category, scope_type, scope_hash)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_integration_credential_directory
     WHERE id = '00000000-0000-0000-0000-00000027d203'::uuid
       AND organization_id = '00000000-0000-0000-0000-00000027d201'::uuid
       AND provider_account_category = 'logestechs_v2_account'
       AND company_id = '362'
       AND bound_scope_type = 'source'
       AND bound_scope_id = '00000000-0000-0000-0000-00000027d204'::uuid
       AND status = 'revoked'
       AND is_active = FALSE
       AND is_expired = FALSE
       AND is_expiring = FALSE
  ),
  'v_integration_credential_directory: source-scoped revoked provider account credentials project to owning tenant with revoked status'
);

SELECT * FROM finish();
ROLLBACK;
