BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT no_plan();

CREATE TEMP TABLE service_acl(signature TEXT, invocation TEXT);
INSERT INTO service_acl VALUES
 ('public.persist_ingress_execution_url_v1(uuid,text,uuid)', 'public.persist_ingress_execution_url_v1(NULL::uuid,NULL::text,NULL::uuid)'),
 ('public.enqueue_comms_whatsapp(uuid,text,text,uuid,uuid,jsonb)', 'public.enqueue_comms_whatsapp(NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::uuid,NULL::jsonb)'),
 ('public.send_comms_reply(uuid,uuid,jsonb,uuid)', 'public.send_comms_reply(NULL::uuid,NULL::uuid,NULL::jsonb,NULL::uuid)'),
 ('public.send_comms_reply_core(uuid,uuid,jsonb,uuid)', 'public.send_comms_reply_core(NULL::uuid,NULL::uuid,NULL::jsonb,NULL::uuid)'),
 ('public.send_comms_reply_core_impl(uuid,uuid,jsonb,uuid)', 'public.send_comms_reply_core_impl(NULL::uuid,NULL::uuid,NULL::jsonb,NULL::uuid)'),
 ('public.dispatch_alert_trigger(uuid)', 'public.dispatch_alert_trigger(NULL::uuid)'),
 ('public.run_alert_dispatch_worker()', 'public.run_alert_dispatch_worker()'),
 ('public.dispatch_outbound_call_inline(uuid,jsonb)', 'public.dispatch_outbound_call_inline(NULL::uuid,NULL::jsonb)'),
 ('public.dispatch_api_request_wait_v1(text,text,jsonb,jsonb,integer,integer,integer)', 'public.dispatch_api_request_wait_v1(NULL::text,NULL::text,NULL::jsonb,NULL::jsonb,NULL::integer,NULL::integer,NULL::integer)');
GRANT SELECT ON service_acl TO anon, authenticated;
SELECT ok(NOT has_function_privilege('anon', signature, 'EXECUTE'), 'anon denied: ' || signature) FROM service_acl;
SELECT ok(NOT has_function_privilege('authenticated', signature, 'EXECUTE'), 'authenticated denied: ' || signature) FROM service_acl;
SELECT ok(has_function_privilege('service_role', signature, 'EXECUTE'), 'service retained: ' || signature) FROM service_acl;
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a
  WHERE p.oid = signature::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
  'no PUBLIC execute: ' || signature) FROM service_acl;
SET LOCAL ROLE anon;
SELECT throws_ok('SELECT ' || invocation, '42501', 'permission denied for function ' || split_part(split_part(signature, '.', 2), '(', 1),
  'real anonymous call denied: ' || signature) FROM service_acl;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok('SELECT ' || invocation, '42501', 'permission denied for function ' || split_part(split_part(signature, '.', 2), '(', 1),
  'real authenticated call denied: ' || signature) FROM service_acl;
RESET ROLE;
SELECT ok(has_function_privilege('edge_label_renderer_role',
  'public.dispatch_api_request_wait_v1(text,text,jsonb,jsonb,integer,integer,integer)', 'EXECUTE'),
  'existing edge renderer wait-dispatch contract is retained');

CREATE TEMP TABLE service_fixture AS SELECT gen_random_uuid() org, gen_random_uuid() foreign_org,
  gen_random_uuid() actor, gen_random_uuid() provider, gen_random_uuid() auth_config,
  gen_random_uuid() client, gen_random_uuid() recipient, gen_random_uuid() correlation,
  gen_random_uuid() outbound, NULL::uuid vault_id;
GRANT SELECT, UPDATE ON service_fixture TO service_role;
GRANT SELECT ON service_fixture TO anon, authenticated;
INSERT INTO public.organizations(id, name, slug)
SELECT org, 'Synthetic messaging tenant', 'comms-' || org FROM service_fixture
UNION ALL SELECT foreign_org, 'Synthetic unrelated tenant', 'comms-' || foreign_org FROM service_fixture;
INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
SELECT actor, foreign_org, 'comms-' || actor || '@example.test', 'Synthetic unrelated actor', 'sender_user', 'active', 'tenant'
FROM service_fixture;
INSERT INTO public.clients(id, organization_id, name, slug, sla_tier, status)
SELECT client, org, 'Synthetic messaging client', 'comms-' || client, 'standard', 'active' FROM service_fixture;
INSERT INTO public.recipients(id, organization_id, client_id, name, phone_number)
SELECT recipient, org, client, 'Synthetic recipient', '+12025550123' FROM service_fixture;
SELECT public.touch_recipient_channel_session(recipient, 'whatsapp', now()) FROM service_fixture;
INSERT INTO public.providers(id, organization_id, name, provider_type, enabled, metadata)
SELECT provider, org, 'Synthetic messaging provider', 'comms', true, '{"base_url":"https://example.test"}' FROM service_fixture;
INSERT INTO public.provider_auth_configs(id, provider_id, auth_type, credentials, credentials_vault_id)
SELECT auth_config, provider, 'api_key', NULL,
  vault.create_secret('{"api_key":"synthetic-dispatch-credential"}', 'test/comms/' || auth_config, 'Rollback-only fixture', NULL)
FROM service_fixture;
SELECT public.upsert_settings_value_v1('provider_defaults', 'resource', provider,
  '{"messaging_product":"whatsapp","whatsapp":{"messages_path":"messages","api_key_header":"x-api-key","headers_template":{"content-type":"application/json"},"text_body_template":{"to":"{{recipient}}","text":{"body":"{{message_text}}"}}}}',
  (SELECT max(version) FROM public.schema_registry WHERE category = 'provider_defaults' AND is_active), 'Synthetic messaging defaults')
FROM service_fixture;

CREATE TEMP TABLE service_before AS SELECT count(*) queued FROM public.outbound_calls;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true) FROM service_fixture;
SELECT set_config('request.jwt.claim.sub', actor::text, true) FROM service_fixture;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(public.current_user_org_id(), foreign_org, 'caller belongs to another organization') FROM service_fixture;
SELECT throws_ok(format('SELECT public.enqueue_comms_whatsapp(%L::uuid,%L,%L,%L::uuid,NULL::uuid,%L::jsonb)',
  auth_config, '+12025550123', 'Synthetic message', correlation,
  jsonb_build_object('organization_id', org, 'client_id', client, 'recipient_id', recipient)::text),
  '42501', 'permission denied for function enqueue_comms_whatsapp', 'caller without organization authority cannot enqueue') FROM service_fixture;
SELECT throws_ok(format('SELECT public.persist_ingress_execution_url_v1(%L::uuid,%L,NULL::uuid)', outbound, 'https://example.test/original'),
  '42501', 'permission denied for function persist_ingress_execution_url_v1', 'unrelated authenticated caller cannot create a Vault entry') FROM service_fixture;
RESET ROLE;
SELECT is((SELECT count(*) FROM public.outbound_calls), (SELECT queued FROM service_before), 'denied caller queues no message');

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;
SELECT lives_ok(format('SELECT public.enqueue_comms_whatsapp(%L::uuid,%L,%L,%L::uuid,NULL::uuid,%L::jsonb)',
  auth_config, '+12025550123', 'Synthetic service message', correlation,
  jsonb_build_object('organization_id', org, 'client_id', client, 'recipient_id', recipient)::text),
  'trusted service queues using Vault-backed credentials and a live recipient session') FROM service_fixture;
UPDATE service_fixture SET vault_id = public.persist_ingress_execution_url_v1(outbound, 'https://example.test/original', NULL);
SELECT is(public.persist_ingress_execution_url_v1(outbound, 'https://example.test/updated', vault_id), vault_id,
  'trusted service can create and update its execution URL Vault entry') FROM service_fixture;
RESET ROLE;
SELECT is((SELECT count(*) FROM public.outbound_calls), (SELECT queued + 1 FROM service_before), 'service queues exactly one message');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.outbound_calls o CROSS JOIN service_fixture f WHERE o.correlation_id = f.correlation
  AND position('synthetic-dispatch-credential' IN to_jsonb(o)::text) > 0), 'queued job never persists the provider credential');
SELECT is((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = (SELECT vault_id FROM service_fixture)),
  'https://example.test/updated', 'legitimate execution URL update is persisted');
SET LOCAL ROLE anon;
SELECT throws_ok(format('SELECT public.persist_ingress_execution_url_v1(%L::uuid,%L,%L::uuid)', outbound, 'https://example.test/attack', vault_id),
  '42501', 'permission denied for function persist_ingress_execution_url_v1', 'anon cannot overwrite an existing Vault entry') FROM service_fixture;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT public.persist_ingress_execution_url_v1(%L::uuid,%L,%L::uuid)', outbound, 'https://example.test/attack', vault_id),
  '42501', 'permission denied for function persist_ingress_execution_url_v1', 'authenticated cannot overwrite an existing Vault entry') FROM service_fixture;
RESET ROLE;
SELECT is((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = (SELECT vault_id FROM service_fixture)),
  'https://example.test/updated', 'denied overwrites leave the existing secret unchanged');
SELECT finish();
ROLLBACK;
