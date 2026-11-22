-- use a null-safe caller-organization guard
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(50);

SELECT set_config('test.caller_org_guard.' || fixture, gen_random_uuid()::text, TRUE)
FROM unnest(ARRAY['org', 'peer_org', 'actor', 'peer_actor', 'platform_actor', 'unknown_actor',
  'plugin', 'version', 'provider', 'config', 'pack', 'route', 'mapping', 'client', 'sender', 'source', 'source_mapping', 'company']) AS fixtures(fixture);

CREATE FUNCTION pg_temp.guard_id(TEXT) RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT current_setting('test.caller_org_guard.' || $1)::uuid
$$;

CREATE FUNCTION pg_temp.guard_actor(TEXT, TEXT DEFAULT 'authenticated') RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  actor_id UUID := pg_temp.guard_id($1);
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor_id, 'role', $2)::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', actor_id::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', $2, TRUE);
END;
$$;

INSERT INTO public.organizations(id, name, slug)
SELECT pg_temp.guard_id(fixture), 'Synthetic organization', 'guard-' || pg_temp.guard_id(fixture)
FROM unnest(ARRAY['org', 'peer_org']) AS fixtures(fixture);

INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
SELECT pg_temp.guard_id(actor), pg_temp.guard_id(org),
       concat('guard-', pg_temp.guard_id(actor), '@', 'example', '.', 'test'),
       'Synthetic actor', 'ops_admin', 'active', scope
FROM (VALUES ('actor', 'org', 'tenant'), ('peer_actor', 'peer_org', 'tenant'),
             ('platform_actor', 'peer_org', 'platform')) AS actors(actor, org, scope);

DO $policy$
DECLARE
  policy JSONB;
  schema_version INT;
BEGIN
  SELECT v.value, v.schema_version INTO STRICT policy, schema_version
  FROM public.settings s JOIN public.settings_versions v ON v.id = s.settings_version_id
  WHERE s.category = 'access_control_policy'
    AND s.scope_type = public.get_root_scope_type_key_v1()
    AND s.scope_id IS NULL;
  SELECT jsonb_set(policy, '{roles}', jsonb_agg(CASE WHEN role->>'key' = 'ops_admin' THEN
    jsonb_set(role, '{capability_keys}',
      jsonb_build_array('integration_plugins.write', 'integration_plugins.activate', 'mappings.write',
                        COALESCE(policy #>> '{resource_map,api_routes,write}', 'api_routes.write')))
    ELSE role END ORDER BY n))
  INTO policy FROM jsonb_array_elements(policy->'roles') WITH ORDINALITY AS roles(role, n);
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', pg_temp.guard_id(org),
                                          policy, schema_version, 'Synthetic organization policy')
  FROM unnest(ARRAY['org', 'peer_org']) AS orgs(org);
END;
$policy$;

INSERT INTO public.integration_plugins(id, organization_id, plugin_key, name, plugin_kind)
VALUES (pg_temp.guard_id('plugin'), pg_temp.guard_id('org'), 'guard-fixture', 'Synthetic plugin', 'api');
INSERT INTO public.integration_plugin_versions(id, plugin_id, organization_id, version_no)
VALUES (pg_temp.guard_id('version'), pg_temp.guard_id('plugin'), pg_temp.guard_id('org'), 1);
INSERT INTO public.providers(id, organization_id, name, provider_type)
VALUES (pg_temp.guard_id('provider'), pg_temp.guard_id('org'), 'Synthetic provider', 'http');
INSERT INTO public.provider_auth_configs(id, provider_id, auth_type, credentials)
VALUES (pg_temp.guard_id('config'), pg_temp.guard_id('provider'), 'basic_auth',
        jsonb_build_object('username', gen_random_uuid(), 'password', gen_random_uuid()));

INSERT INTO public.api_route_packs(id, name)
VALUES (pg_temp.guard_id('pack'), 'guard-fixture');
INSERT INTO public.api_routes(id, pack_id, provider_id, method, path_template, scope_type, scope_id, policy)
VALUES (pg_temp.guard_id('route'), pg_temp.guard_id('pack'), pg_temp.guard_id('provider'),
        'POST', '/synthetic/organization-guard', 'tenant', pg_temp.guard_id('org'),
        '{"postprocess":{"mode":"shipment_update_v1"},"provider_account":{"category":"pgtap_caller_org_guard"},"auth":{"auth_type":"basic_auth"}}');
INSERT INTO public.mapping_configs(id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version)
VALUES (pg_temp.guard_id('mapping'), pg_temp.guard_id('org'), 'api_gateway_inbound',
        'pgtap.guard.update', '{"target":"shipments.update"}', 1),
       (pg_temp.guard_id('source_mapping'), pg_temp.guard_id('org'), 'webhook_inbound',
        'pgtap.guard.webhook', '{}'::jsonb, 1);
INSERT INTO public.clients(id, organization_id, name, slug, status)
VALUES (pg_temp.guard_id('client'), pg_temp.guard_id('org'), 'Synthetic client', 'guard-' || pg_temp.guard_id('client'), 'active');
INSERT INTO public.senders(id, client_id, name, brand_name, status)
VALUES (pg_temp.guard_id('sender'), pg_temp.guard_id('client'), 'Synthetic sender', 'Synthetic sender', 'active');
INSERT INTO public.webhook_sources(id, organization_id, source_identifier, name, provider_type,
                                   auth_token, mapping_config_id, sender_id)
VALUES (pg_temp.guard_id('source'), pg_temp.guard_id('org'), 'guard-' || pg_temp.guard_id('source'),
        'Synthetic source', 'api_gateway', gen_random_uuid()::text,
        pg_temp.guard_id('source_mapping'), pg_temp.guard_id('sender'));

CREATE FUNCTION pg_temp.credential_guard_args(scope TEXT, org UUID) RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('organization_id', org, 'scope_type', scope,
    'source_id', CASE WHEN scope = 'source' THEN pg_temp.guard_id('source') END,
    'route_id', pg_temp.guard_id('route'), 'auth_config_id', pg_temp.guard_id('config'), 'company_id', pg_temp.guard_id('company')::text)
$$;

CREATE FUNCTION pg_temp.guard_cases()
RETURNS TABLE (case_no INT, statement TEXT, expected TEXT, denial_state TEXT, denial TEXT, unknown_denial TEXT)
LANGUAGE sql STABLE AS $cases$
  VALUES
  (1, $q$SELECT public.integration_plugin_generate_draft_v1('Synthetic new draft', 'api',
      p_organization_id := pg_temp.guard_id('org'))->>'organization_id'$q$,
      pg_temp.guard_id('org')::text, 'P0001',
      'integration_plugin_generate_draft_v1 cannot create drafts for another organization', NULL),
  (2, $q$SELECT public.integration_plugin_generate_draft_v1('Synthetic existing draft', 'api',
      p_plugin_id := pg_temp.guard_id('plugin'))->>'plugin_id'$q$,
      pg_temp.guard_id('plugin')::text, 'P0001',
      'integration_plugin_generate_draft_v1 cannot create drafts for another organization', NULL),
  (3, $q$SELECT public.plugin_deactivate_v1(
      jsonb_build_object('plugin_id', pg_temp.guard_id('plugin')))->>'ok'$q$,
      'true', '42501', 'Capability denied: integration_plugins.activate', NULL),
  (4, $q$SELECT public.plugin_set_binding_v1(
      jsonb_build_object('plugin_version_id', pg_temp.guard_id('version'), 'enabled', FALSE))->>'ok'$q$,
      'true', '42501', format('plugin_set_binding_v1 plugin %s outside tenant scope', pg_temp.guard_id('plugin')), NULL),
  (5, $q$SELECT public.ui_upsert_provider_auth_config_v1(
      jsonb_build_object('config_id', pg_temp.guard_id('config'), 'expires_at', NULL))->>'provider_auth_config_id'$q$,
      pg_temp.guard_id('config')::text, '42501',
      format('ui_upsert_provider_auth_config_v1 provider %s outside tenant scope', pg_temp.guard_id('provider')),
      'Capability denied: integration_plugins.write'),
  (6, $q$SELECT public.ui_bind_provider_account_credential_v1(
      pg_temp.credential_guard_args('tenant', pg_temp.guard_id('org')))->>'provider_auth_config_id'$q$,
      pg_temp.guard_id('config')::text, '42501',
      format('ui_bind_provider_account_credential_v1 tenant %s outside caller scope', pg_temp.guard_id('org')),
      'Capability denied: integration_plugins.write'),
  (7, $q$SELECT public.ui_bind_provider_account_credential_v1(
      pg_temp.credential_guard_args('source', pg_temp.guard_id('org')))->>'provider_auth_config_id'$q$,
      pg_temp.guard_id('config')::text, '42501',
      format('ui_bind_provider_account_credential_v1 tenant %s outside caller scope', pg_temp.guard_id('org')),
      'Capability denied: integration_plugins.write'),
  (8, $q$SELECT public.ui_upsert_api_gateway_route_mapping_v1(jsonb_build_object(
      'organization_id', pg_temp.guard_id('org'), 'api_route_id', pg_temp.guard_id('route'),
      'mapping_config_id', pg_temp.guard_id('mapping')))->>'mapping_config_id'$q$,
      pg_temp.guard_id('mapping')::text, '42501', 'Capability denied: api_routes.write', NULL),
  (9, $q$SELECT api.integration_plugin_migrate_runtime_assets_v1('webhook_source',
      pg_temp.guard_id('source'), 'Synthetic migrated source')->>'organization_id'$q$,
      pg_temp.guard_id('org')::text, '42501', 'Capability denied: integration_plugins.write', NULL)
$cases$;

SELECT pg_temp.guard_actor('peer_actor');
SET LOCAL ROLE authenticated;
SELECT throws_ok(statement, denial_state, denial, 'use a null-safe caller-organization guard')
FROM pg_temp.guard_cases() ORDER BY case_no;
SELECT throws_ok(
  $$ SELECT public.integration_plugin_generate_draft_v1('Synthetic existing draft', 'api',
       p_plugin_id := pg_temp.guard_id('plugin'), p_organization_id := pg_temp.guard_id('peer_org')) $$,
  'P0001', 'integration_plugin_generate_draft_v1 cannot create drafts for another organization',
  'use a null-safe caller-organization guard'
);
SELECT throws_ok(
  $$ SELECT public.ui_bind_provider_account_credential_v1(
       pg_temp.credential_guard_args('source', pg_temp.guard_id('peer_org'))) $$,
  '42501', format('ui_bind_provider_account_credential_v1 source %s outside caller scope', pg_temp.guard_id('source')),
  'use a null-safe caller-organization guard'
);
RESET ROLE;

SELECT pg_temp.guard_actor('unknown_actor');
SET LOCAL ROLE authenticated;
SELECT ok(auth.uid() = pg_temp.guard_id('unknown_actor') AND public.current_user_org_id() IS NULL,
          'use a null-safe caller-organization guard');
SELECT throws_ok(statement, denial_state, COALESCE(unknown_denial, denial), 'use a null-safe caller-organization guard')
FROM pg_temp.guard_cases() ORDER BY case_no;
RESET ROLE;

SELECT pg_temp.guard_actor('actor');
SET LOCAL ROLE authenticated;
SELECT results_eq(statement, ARRAY[expected], 'use a null-safe caller-organization guard')
FROM pg_temp.guard_cases() ORDER BY case_no;
RESET ROLE;

SELECT pg_temp.guard_actor('platform_actor');
SET LOCAL ROLE authenticated;
SELECT ok(public.is_platform_user() AND public.current_user_org_id() = pg_temp.guard_id('peer_org'),
          'use a null-safe caller-organization guard');
SELECT results_eq(statement, ARRAY[expected], 'use a null-safe caller-organization guard')
FROM pg_temp.guard_cases() ORDER BY case_no;
RESET ROLE;

SELECT pg_temp.guard_actor('peer_actor', 'service_role');
SET LOCAL ROLE service_role;
SELECT ok(public.request_role_is_service_v1() AND public.current_user_org_id() = pg_temp.guard_id('peer_org'),
          'use a null-safe caller-organization guard');
SELECT results_eq(statement, ARRAY[expected], 'use a null-safe caller-organization guard')
FROM pg_temp.guard_cases() ORDER BY case_no;
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
