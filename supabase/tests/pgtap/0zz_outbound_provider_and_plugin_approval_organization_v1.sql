-- Scope outbound provider and plugin approval to the caller's organization.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(19);

DO $installed_scope$
BEGIN
  IF strpos(pg_get_functiondef('public.enqueue_comms_attempt_v1(jsonb)'::regprocedure),
            'p.organization_id = v_shipment.organization_id' || chr(10) || '     AND ot.call_type') = 0
     OR EXISTS (
       SELECT 1 FROM unnest(ARRAY[
         'public.integration_plugin_approve_v1(uuid,text,text)'::regprocedure,
         'public.integration_plugin_submit_v1(uuid,text)'::regprocedure,
         'public.integration_plugin_validate_v1(uuid,jsonb,boolean)'::regprocedure,
         'public.integration_plugin_rotate_credentials_v1(uuid,text,jsonb,timestamptz,text)'::regprocedure,
         'public.integration_plugin_rollback_v1(uuid,uuid,text)'::regprocedure
       ]) AS scoped(signature)
       WHERE strpos(pg_get_functiondef(signature),
                    'public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id') = 0
     ) THEN
    RAISE EXCEPTION 'Install outbound provider and plugin approval organization scope before testing';
  END IF;
END;
$installed_scope$;

SELECT set_config('test.organization_scope.' || fixture, gen_random_uuid()::text, TRUE)
FROM unnest(ARRAY['org', 'peer_org', 'actor', 'peer_actor', 'platform_actor', 'client', 'sender', 'shipment',
  'provider', 'peer_provider', 'mapping', 'workflow', 'draft_plugin', 'draft_version',
  'review_plugin', 'review_version', 'active_plugin', 'active_version']) AS fixtures(fixture);
CREATE FUNCTION pg_temp.scope_id(TEXT) RETURNS UUID LANGUAGE sql AS $$
  SELECT current_setting('test.organization_scope.' || $1)::uuid
$$;
CREATE FUNCTION pg_temp.scope_actor(TEXT, TEXT DEFAULT 'authenticated') RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actor_id UUID := pg_temp.scope_id($1);
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor_id, 'role', $2)::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', actor_id::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', $2, TRUE);
END;
$$;

INSERT INTO public.organizations(id, name, slug)
SELECT id, 'Synthetic organization', 'scope-' || id FROM unnest(ARRAY[
  pg_temp.scope_id('org'), pg_temp.scope_id('peer_org')
]) AS orgs(id);

INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
SELECT pg_temp.scope_id(actor), pg_temp.scope_id(org), 'scope-' || pg_temp.scope_id(actor) || '@example.test',
       'Synthetic actor', 'ops_admin', 'active', scope
FROM (VALUES ('actor', 'org', 'tenant'), ('peer_actor', 'peer_org', 'tenant'),
             ('platform_actor', 'peer_org', 'platform')) AS actors(actor, org, scope);

DO $policies$
DECLARE policy JSONB; schema_version INT;
BEGIN
  SELECT v.value, v.schema_version INTO STRICT policy, schema_version
  FROM public.settings s JOIN public.settings_versions v ON v.id = s.settings_version_id
  WHERE s.category = 'access_control_policy' AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;
  SELECT jsonb_set(policy, '{roles}', jsonb_agg(CASE WHEN role->>'key' = 'ops_admin' THEN
    jsonb_set(role, '{capability_keys}',
              '["comms.write","integration_plugins.approve","integration_plugins.write","integration_plugins.test","integration_plugins.activate"]')
    ELSE role END ORDER BY n))
  INTO policy FROM jsonb_array_elements(policy->'roles') WITH ORDINALITY AS roles(role, n);
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', pg_temp.scope_id(org),
                                          policy, schema_version, 'Synthetic organization policy')
  FROM unnest(ARRAY['org', 'peer_org']) AS orgs(org);
  PERFORM public.upsert_settings_value_v1('communication_policy', 'tenant', pg_temp.scope_id('org'),
    jsonb_build_object('version', 1, 'allow_operator_initiated_send', TRUE, 'allowed_channels', jsonb_build_array('sms', 'email'),
      'operator_initiated', jsonb_build_object(
        'sms', jsonb_build_object('provider_id', pg_temp.scope_id('provider')),
        'email', jsonb_build_object('provider_id', pg_temp.scope_id('peer_provider')))),
    1, 'Synthetic communication policy');
END;
$policies$;

INSERT INTO public.clients(id, organization_id, name, slug, status)
VALUES (pg_temp.scope_id('client'), pg_temp.scope_id('org'), 'Synthetic client', 'scope-' || pg_temp.scope_id('client'), 'active');
INSERT INTO public.senders(id, client_id, name, brand_name, status)
VALUES (pg_temp.scope_id('sender'), pg_temp.scope_id('client'), 'Synthetic sender', 'Synthetic sender', 'active');
INSERT INTO public.shipments(id, organization_id, client_id, sender_id, tracking_number, service_type, status)
VALUES (pg_temp.scope_id('shipment'), pg_temp.scope_id('org'), pg_temp.scope_id('client'), pg_temp.scope_id('sender'),
        'scope-' || pg_temp.scope_id('shipment'), 'delivery', 'pending');
INSERT INTO public.providers(id, organization_id, name, provider_type)
VALUES (pg_temp.scope_id('provider'), pg_temp.scope_id('org'), 'Synthetic provider', 'comms'),
       (pg_temp.scope_id('peer_provider'), pg_temp.scope_id('peer_org'), 'Synthetic provider', 'comms');
INSERT INTO public.mapping_configs(id, mapping_type, mapping_key, mapping_config, mapping_version)
VALUES (pg_temp.scope_id('mapping'), 'provider_response', 'scope-' || pg_temp.scope_id('mapping'),
        '{"success_path":"$.ok","field_mappings":{}}', 1);
INSERT INTO public.operation_templates(provider_id, handler_key, operation_name, method, url_template, mapping_config_id, call_type)
VALUES (pg_temp.scope_id('provider'), 'outbound_http', 'scope_sms', 'POST', 'https://example.invalid/send',
        pg_temp.scope_id('mapping'), 'comms_sms');

INSERT INTO public.workflow_templates(name, version, status, scope_type, scope_id)
VALUES ('scope-' || pg_temp.scope_id('workflow'), 1, 'active', 'tenant', pg_temp.scope_id('org'));
INSERT INTO public.integration_plugins(id, organization_id, plugin_key, name, plugin_kind, status)
SELECT pg_temp.scope_id(kind || '_plugin'), pg_temp.scope_id('org'),
       'scope-' || pg_temp.scope_id(kind || '_plugin'), 'Synthetic plugin', 'webhook', status
FROM (VALUES ('draft', 'draft'), ('review', 'submitted'), ('active', 'active')) AS plugins(kind, status);
INSERT INTO public.integration_plugin_versions(id, plugin_id, organization_id, version_no, status, workflow_binding)
SELECT pg_temp.scope_id(kind || '_version'), pg_temp.scope_id(kind || '_plugin'), pg_temp.scope_id('org'), 1, status,
       jsonb_build_object('template_name', 'scope-' || pg_temp.scope_id('workflow'))
FROM (VALUES ('draft', 'draft'), ('review', 'submitted'), ('active', 'active')) AS versions(kind, status);
UPDATE public.integration_plugins SET active_version_id = pg_temp.scope_id('active_version')
WHERE id = pg_temp.scope_id('active_plugin');
INSERT INTO public.integration_plugin_bindings(plugin_version_id, organization_id, scope_type, scope_id,
  binding_type, runtime_resource_type, runtime_resource_id, enabled)
VALUES (pg_temp.scope_id('active_version'), pg_temp.scope_id('org'), 'tenant', pg_temp.scope_id('org'),
        'provider', 'providers', pg_temp.scope_id('provider'), TRUE);

CREATE FUNCTION pg_temp.enqueue_scoped_comms(provider UUID DEFAULT NULL, channel TEXT DEFAULT 'sms') RETURNS JSONB LANGUAGE sql AS $$
  SELECT public.enqueue_comms_attempt_v1(jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', pg_temp.scope_id('shipment'), 'channel', channel, 'provider_id', provider, 'message_text', 'Synthetic message'
  )))
$$;
CREATE FUNCTION pg_temp.rotate_scoped_plugin() RETURNS JSONB LANGUAGE sql AS $$
  SELECT public.integration_plugin_rotate_credentials_v1(
    pg_temp.scope_id('active_version'), 'api_key', jsonb_build_object('key', gen_random_uuid())
  )
$$;

SELECT pg_temp.scope_actor('peer_actor');
SET LOCAL ROLE authenticated;
SELECT ok(public.user_has_capability_v1('integration_plugins.approve', 'tenant', pg_temp.scope_id('peer_org')),
          'Plugin approval capability is available in the caller''s organization');
SELECT throws_ok($$ SELECT public.integration_plugin_approve_v1(pg_temp.scope_id('review_version'), 'approved') $$,
  '42501', 'Capability denied: integration_plugins.approve', 'Plugin approval is scoped to the caller''s organization');
SELECT throws_ok($$ SELECT public.integration_plugin_approve_v1(pg_temp.scope_id('review_version'), 'rejected') $$,
  '42501', 'Capability denied: integration_plugins.approve', 'Plugin rejection is scoped to the caller''s organization');
SELECT throws_ok($$ SELECT public.integration_plugin_submit_v1(pg_temp.scope_id('draft_version')) $$,
  '42501', 'Capability denied: integration_plugins.write', 'Plugin submission is scoped to the caller''s organization');
SELECT throws_ok($$ SELECT public.integration_plugin_validate_v1(pg_temp.scope_id('draft_version')) $$,
  '42501', 'Capability denied: integration_plugins.test', 'Plugin validation is scoped to the caller''s organization');
SELECT throws_ok($$ SELECT pg_temp.rotate_scoped_plugin() $$,
  '42501', 'Capability denied: integration_plugins.activate', 'Plugin credential rotation is scoped to the caller''s organization');
SELECT throws_ok($$ SELECT public.integration_plugin_rollback_v1(pg_temp.scope_id('active_plugin'), pg_temp.scope_id('active_version')) $$,
  '42501', 'Capability denied: integration_plugins.activate', 'Plugin rollback is scoped to the caller''s organization');
RESET ROLE;

SELECT pg_temp.scope_actor('actor');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT pg_temp.enqueue_scoped_comms(pg_temp.scope_id('peer_provider')) $$,
  '42501', 'enqueue_comms_attempt_v1 provider is outside shipment organization', 'Outbound provider is scoped to the shipment organization');
SELECT throws_ok($$ SELECT pg_temp.enqueue_scoped_comms(channel => 'email') $$,
  '42501', 'enqueue_comms_attempt_v1 provider is outside shipment organization', 'Outbound provider policy is scoped to the shipment organization');
SELECT is(pg_temp.enqueue_scoped_comms()->>'status', 'queued', 'Outbound provider from the organization policy queues');
SELECT is(pg_temp.enqueue_scoped_comms(pg_temp.scope_id('provider'))->>'status', 'queued', 'Outbound provider from the shipment organization queues');
SELECT is(public.integration_plugin_validate_v1(pg_temp.scope_id('draft_version'))->>'ok', 'true', 'Plugin validation works in the caller''s organization');
SELECT is(public.integration_plugin_submit_v1(pg_temp.scope_id('draft_version'))->>'status', 'submitted', 'Plugin submission works in the caller''s organization');
SELECT is(public.integration_plugin_approve_v1(pg_temp.scope_id('draft_version'), 'approved')->>'status', 'approved', 'Plugin approval works in the caller''s organization');
SELECT is(pg_temp.rotate_scoped_plugin()->>'provider_id', pg_temp.scope_id('provider')::text, 'Plugin credential rotation works in the caller''s organization');
SELECT is(public.integration_plugin_rollback_v1(pg_temp.scope_id('active_plugin'), pg_temp.scope_id('active_version'))->>'already_active', 'true',
          'Plugin rollback works in the caller''s organization');
RESET ROLE;
SELECT is((SELECT array_agg(target_id) FROM public.outbound_calls WHERE shipment_id = pg_temp.scope_id('shipment')),
          ARRAY[pg_temp.scope_id('provider'), pg_temp.scope_id('provider')], 'Queued outbound calls use the shipment organization provider');

SELECT pg_temp.scope_actor('platform_actor');
SET LOCAL ROLE authenticated;
SELECT is(public.integration_plugin_approve_v1(pg_temp.scope_id('review_version'), 'rejected')->>'status', 'rejected',
          'Plugin approval preserves platform scope');
RESET ROLE;
SELECT pg_temp.scope_actor('peer_actor', 'service_role');
SET LOCAL ROLE service_role;
SELECT is(public.integration_plugin_approve_v1(pg_temp.scope_id('review_version'), 'rejected')->>'already_processed', 'true',
          'Plugin approval preserves service scope');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
