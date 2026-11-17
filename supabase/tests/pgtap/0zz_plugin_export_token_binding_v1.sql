-- Token, authenticated-actor and route-scope regression coverage.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(40);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
CREATE TEMP TABLE export_fixture AS SELECT gen_random_uuid() org,gen_random_uuid() plugin,
  gen_random_uuid() version,gen_random_uuid() mapping,gen_random_uuid() source,gen_random_uuid() binding;
INSERT INTO public.organizations(id,name,slug)
SELECT org,'QA export token fixture','qa-export-'||org FROM export_fixture;
INSERT INTO public.mapping_configs(id,mapping_type,mapping_key,mapping_config,mapping_version)
SELECT mapping,'provider_response','qa-export-'||mapping,'{}'::jsonb,1 FROM export_fixture;
INSERT INTO public.integration_plugins(id,organization_id,plugin_key,name)
SELECT plugin,org,'qa-export-'||plugin,'QA export token fixture' FROM export_fixture;
INSERT INTO public.integration_plugin_versions(id,plugin_id,organization_id,version_no)
SELECT version,plugin,org,1 FROM export_fixture;
INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,auth_token,mapping_config_id)
SELECT source,org,'qa-export-'||source,'QA export token source','generic','qa-token-'||source,mapping FROM export_fixture;
INSERT INTO public.integration_plugin_bindings(id,plugin_version_id,organization_id,scope_type,scope_id,
  binding_type,runtime_resource_type,runtime_resource_id,activation_payload)
SELECT binding,version,org,'tenant',org,'webhook_source','webhook_sources',source,
  jsonb_build_object('issued_token','qa-token-'||source) FROM export_fixture;
CREATE TEMP TABLE export_first AS
SELECT public.integration_plugin_export_handoff_v1(version,'https://example.test') result FROM export_fixture;
SELECT throws_ok(format('SELECT public.integration_plugin_export_handoff_v1(%L::uuid,%L)',
  (SELECT version FROM export_fixture),invalid.base),'22023',
  'plugin export requires an HTTP(S) base without credentials, query or fragment',
  invalid.label)
FROM (VALUES ('file:///tmp/export','rejects non-HTTP export base'),
  (('https' || '://user:password@example.test'),'rejects credential-bearing export base'),
  ('https://example.test?token=value','rejects query-bearing export base'),
  ('https://example.test#fragment','rejects fragment-bearing export base')) invalid(base,label);
CREATE TEMP TABLE export_foreign AS SELECT gen_random_uuid() org;
INSERT INTO public.organizations(id,name,slug)
SELECT org,'QA foreign export tenant','qa-foreign-export-'||org FROM export_foreign;
CREATE TEMP TABLE export_actors AS SELECT gen_random_uuid() allowed_actor,gen_random_uuid() foreign_actor;
INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type,access_scope_id,status)
SELECT a.allowed_actor,f.org,'qa-'||a.allowed_actor||'@example.test','QA export actor','ops_admin','tenant',NULL::uuid,'active'
FROM export_actors a CROSS JOIN export_fixture f
UNION ALL
SELECT a.foreign_actor,f.org,'qa-'||a.foreign_actor||'@example.test','QA foreign export actor','ops_admin','tenant',NULL::uuid,'active'
FROM export_actors a CROSS JOIN export_foreign f;
GRANT SELECT ON export_fixture,export_actors,export_first TO authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',allowed_actor)::text,true)
FROM export_actors;
SELECT set_config('request.jwt.claim.sub',allowed_actor::text,true) FROM export_actors;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
SELECT ok((SELECT api.integration_plugin_export_handoff_v1(version,'https://example.test')->>'token' FROM export_fixture)=
  (SELECT result->>'token' FROM export_first),'authorized tenant actor exports through API without rotation');
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',foreign_actor)::text,true)
FROM export_actors;
SELECT set_config('request.jwt.claim.sub',foreign_actor::text,true) FROM export_actors;
SELECT set_config('request.jwt.claim.role','authenticated',true);
CREATE TEMP TABLE export_foreign_before AS
SELECT s.auth_token_hash,b.activation_payload,
 (SELECT count(*) FROM public.webhook_source_token_history h WHERE h.source_id=s.id) history_count
FROM export_fixture f JOIN public.webhook_sources s ON s.id=f.source
JOIN public.integration_plugin_bindings b ON b.id=f.binding;
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.integration_plugin_export_handoff_v1(%L::uuid,%L)',
  (SELECT version FROM export_fixture),'https://example.test'),'42501',NULL,
  'foreign tenant actor cannot export another tenant token');
RESET ROLE;
SELECT ok((SELECT s.auth_token_hash IS NOT DISTINCT FROM old.auth_token_hash
 AND b.activation_payload IS NOT DISTINCT FROM old.activation_payload
 AND (SELECT count(*) FROM public.webhook_source_token_history h WHERE h.source_id=s.id)=old.history_count
 FROM export_fixture f JOIN public.webhook_sources s ON s.id=f.source
 JOIN public.integration_plugin_bindings b ON b.id=f.binding CROSS JOIN export_foreign_before old),
 'foreign actor rejection preserves source hash binding and history');
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
UPDATE public.integration_plugin_bindings SET activation_payload='{}'::jsonb WHERE id=(SELECT binding FROM export_fixture);
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',foreign_actor)::text,true) FROM export_actors;
SELECT set_config('request.jwt.claim.sub',foreign_actor::text,true) FROM export_actors;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.integration_plugin_export_handoff_v1(%L::uuid,%L)',
 (SELECT version FROM export_fixture),'https://example.test'),'42501',NULL,
 'foreign actor cannot trigger missing-token repair');
RESET ROLE;
SELECT ok((SELECT s.auth_token_hash IS NOT DISTINCT FROM old.auth_token_hash
 AND b.activation_payload='{}'::jsonb
 AND (SELECT count(*) FROM public.webhook_source_token_history h WHERE h.source_id=s.id)=old.history_count
 FROM export_fixture f JOIN public.webhook_sources s ON s.id=f.source
 JOIN public.integration_plugin_bindings b ON b.id=f.binding CROSS JOIN export_foreign_before old),
 'foreign repair rejection preserves hash empty binding and history');
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
UPDATE public.integration_plugin_bindings SET activation_payload=(SELECT activation_payload FROM export_foreign_before)
WHERE id=(SELECT binding FROM export_fixture);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.integration_plugin_export_handoff_v1(%L::uuid,%L)',
 (SELECT version FROM export_fixture),'https://example.test'),'42501',NULL,
 'missing actor cannot export tenant credentials');
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',gen_random_uuid())::text,true);
SELECT set_config('request.jwt.claim.sub',current_setting('request.jwt.claims')::jsonb->>'sub',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.integration_plugin_export_handoff_v1(%L::uuid,%L)',
 (SELECT version FROM export_fixture),'https://example.test'),'42501',NULL,
 'actor absent from users cannot export tenant credentials');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
CREATE TEMP TABLE export_platform_actor AS SELECT gen_random_uuid() id;
INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type,access_scope_id,status)
SELECT id,(SELECT org FROM export_foreign),'qa-platform-export-'||id||'@example.test','QA platform export','super_admin','platform',NULL,'active' FROM export_platform_actor;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) FROM export_platform_actor;
SELECT set_config('request.jwt.claim.sub',id::text,true) FROM export_platform_actor;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
SELECT ok((SELECT api.integration_plugin_export_handoff_v1(version,'https://example.test')->>'token' =
 (SELECT result->>'token' FROM export_first) FROM export_fixture),
 'authorized platform actor retains cross-tenant export without rotation');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
CREATE TEMP TABLE export_readonly_fixture AS SELECT gen_random_uuid() org,
 gen_random_uuid() actor,gen_random_uuid() plugin,gen_random_uuid() version;
INSERT INTO public.organizations(id,name,slug)
SELECT org,'QA readonly export tenant','qa-readonly-export-'||org FROM export_readonly_fixture;
INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type,access_scope_id,status)
SELECT actor,org,'qa-'||actor||'@example.test','QA readonly export actor','ops_admin','tenant',NULL::uuid,'active'
FROM export_readonly_fixture;
INSERT INTO public.integration_plugins(id,organization_id,plugin_key,name)
SELECT plugin,org,'qa-readonly-export-'||plugin,'QA readonly export plugin' FROM export_readonly_fixture;
INSERT INTO public.integration_plugin_versions(id,plugin_id,organization_id,version_no)
SELECT version,plugin,org,1 FROM export_readonly_fixture;
-- Canonical six-argument history-writing helper, invoked by setup role only.
SELECT 1 FROM export_readonly_fixture f CROSS JOIN LATERAL public.upsert_settings_value_v1(
 'access_control_policy','tenant',f.org,
 jsonb_build_object('denies',jsonb_build_array(jsonb_build_object(
   'capability_key','integration_plugins.write','scope_type','tenant',
   'scope_id',f.org::text,'reason','QA readonly export boundary'))),
 1,'QA readonly export boundary');
GRANT SELECT ON export_readonly_fixture TO authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true)
FROM export_readonly_fixture;
SELECT set_config('request.jwt.claim.sub',actor::text,true) FROM export_readonly_fixture;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
SELECT ok(public.user_has_capability_v1('integration_plugins.read','tenant',org),
 'same-tenant readonly actor retains plugin read') FROM export_readonly_fixture;
SELECT ok(NOT public.user_has_capability_v1('integration_plugins.write','tenant',org),
 'same-tenant readonly actor lacks plugin write') FROM export_readonly_fixture;
SELECT throws_ok(format('SELECT api.integration_plugin_export_handoff_v1(%L::uuid,%L)',
 (SELECT version FROM export_readonly_fixture),'https://example.test'),'42501',NULL,
 'same-tenant readonly actor cannot export credentials');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT throws_ok(format('UPDATE public.integration_plugin_bindings SET scope_id=%L::uuid WHERE id=%L::uuid',
  (SELECT org FROM export_foreign),(SELECT binding FROM export_fixture)),
  '23514',format('integration_plugin_bindings: scope tenant/%s does not belong to organization %s',
    (SELECT org FROM export_foreign),(SELECT org FROM export_fixture)),
  'canonical trigger rejects a foreign tenant binding without bypass');
SELECT is((SELECT scope_id FROM public.integration_plugin_bindings
  WHERE id=(SELECT binding FROM export_fixture)),(SELECT org FROM export_fixture),
  'failed foreign binding update preserves original tenant scope');
SELECT ok((SELECT result->>'token' FROM export_first)=
  (SELECT 'qa-token-'||source FROM export_fixture),'valid bound token is stable');
UPDATE public.integration_plugin_bindings SET activation_payload='{}'::jsonb
WHERE id=(SELECT binding FROM export_fixture);
CREATE TEMP TABLE export_repaired AS
SELECT api.integration_plugin_export_handoff_v1(version,'https://example.test') result FROM export_fixture;
SELECT ok((SELECT result->>'token' FROM export_repaired)<>
  (SELECT result->>'token' FROM export_first),'missing binding causes token repair through API');
SELECT ok((SELECT extensions.crypt(r.result->>'token',s.auth_token_hash)=s.auth_token_hash
  AND b.activation_payload->>'issued_token'=r.result->>'token'
  FROM export_fixture f JOIN public.webhook_sources s ON s.id=f.source
  JOIN public.integration_plugin_bindings b ON b.id=f.binding CROSS JOIN export_repaired r),
  'returned token matches persisted binding and canonical source hash');
SELECT is((SELECT count(*) FROM public.webhook_source_token_history
  WHERE source_id=(SELECT source FROM export_fixture)),1::bigint,
  'one repair appends exactly one prior-token history row');
CREATE TEMP TABLE export_repeat AS
SELECT public.integration_plugin_export_handoff_v1(version,'https://example.test') result FROM export_fixture;
SELECT ok((SELECT result->>'token' FROM export_repeat)=
  (SELECT result->>'token' FROM export_repaired),'repeat export preserves repaired token');
SELECT is((SELECT count(*) FROM public.webhook_source_token_history
  WHERE source_id=(SELECT source FROM export_fixture)),1::bigint,
  'repeat export creates no extra rotation history');
UPDATE public.integration_plugin_bindings SET activation_payload=jsonb_build_object('issued_token','REDACTED')
WHERE id=(SELECT binding FROM export_fixture);
CREATE TEMP TABLE export_redacted AS
SELECT public.integration_plugin_export_handoff_v1(version,'https://example.test') result FROM export_fixture;
SELECT ok((SELECT result->>'token' FROM export_redacted)<>
  (SELECT result->>'token' FROM export_repaired),'redacted binding is repaired');
UPDATE public.integration_plugin_bindings SET activation_payload=jsonb_build_object('issued_token','known-mismatched-qa-token')
WHERE id=(SELECT binding FROM export_fixture);
CREATE TEMP TABLE export_mismatch AS
SELECT public.integration_plugin_export_handoff_v1(version,'https://example.test') result FROM export_fixture;
SELECT ok((SELECT r.result->>'token' <> 'known-mismatched-qa-token'
  AND extensions.crypt(r.result->>'token',s.auth_token_hash)=s.auth_token_hash
  AND b.activation_payload->>'issued_token'=r.result->>'token'
  FROM export_fixture f JOIN public.webhook_sources s ON s.id=f.source
  JOIN public.integration_plugin_bindings b ON b.id=f.binding CROSS JOIN export_mismatch r),
  'mismatched binding is repaired to a persisted matching token');
SELECT is((SELECT count(*) FROM public.webhook_source_token_history
  WHERE source_id=(SELECT source FROM export_fixture)),3::bigint,
  'three repairs create exactly three immutable history entries');
UPDATE public.integration_plugin_versions SET workflow_binding='{"intent":"shipment.create"}'::jsonb
WHERE id=(SELECT version FROM export_fixture);
SELECT throws_ok(format('SELECT public.integration_plugin_export_handoff_v1(%L::uuid,%L)',
  (SELECT version FROM export_fixture),'https://example.test'),'22023',
  'shipment-create plugin export requires a sender-bound webhook source',
  'shipment creation without sender binding is rejected');
SELECT is((SELECT count(*) FROM public.webhook_source_token_history
  WHERE source_id=(SELECT source FROM export_fixture)),3::bigint,
  'sender rejection does not rotate token');
UPDATE public.integration_plugin_versions SET workflow_binding='{}'::jsonb
WHERE id=(SELECT version FROM export_fixture);
CREATE TEMP TABLE export_route_fixture AS SELECT gen_random_uuid() client,
  gen_random_uuid() sender,gen_random_uuid() pack,gen_random_uuid() route;
INSERT INTO public.clients(id,organization_id,name,slug,status)
SELECT r.client,f.org,'QA export route client','qa-export-route-'||r.client,'active'
FROM export_route_fixture r CROSS JOIN export_fixture f;
INSERT INTO public.senders(id,client_id,name,status)
SELECT sender,client,'QA export route sender','active' FROM export_route_fixture;
UPDATE public.webhook_sources SET sender_id=(SELECT sender FROM export_route_fixture)
WHERE id=(SELECT source FROM export_fixture);
CREATE TEMP TABLE export_unbound_competitor AS SELECT gen_random_uuid() source,gen_random_uuid() binding;
INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,auth_token,mapping_config_id)
SELECT c.source,f.org,'qa-export-competitor-'||c.source,'QA unbound export competitor',
 'generic','qa-token-'||c.source,f.mapping FROM export_unbound_competitor c CROSS JOIN export_fixture f;
INSERT INTO public.integration_plugin_bindings(id,plugin_version_id,organization_id,scope_type,scope_id,
 binding_type,runtime_resource_type,runtime_resource_id,activation_payload,created_at)
SELECT c.binding,f.version,f.org,'client',r.client,'webhook_source','webhook_sources',c.source,
 jsonb_build_object('issued_token','qa-token-'||c.source),clock_timestamp()+interval '1 minute'
FROM export_unbound_competitor c CROSS JOIN export_fixture f CROSS JOIN export_route_fixture r;
SELECT ok((SELECT api.integration_plugin_export_handoff_v1(version,'https://example.test')->>'token' FROM export_fixture)=
 (SELECT activation_payload->>'issued_token' FROM public.integration_plugin_bindings WHERE id=(SELECT binding FROM export_fixture)),
 'sender-bound source wins over a newer valid unbound source');
UPDATE public.integration_plugins SET plugin_kind='api' WHERE id=(SELECT plugin FROM export_fixture);
-- Platform-owned gateway routes are valid existing binding targets. This fixture
-- tests export scope resolution, not integration-plugin route creation policy.
INSERT INTO public.api_route_packs(id,name,enabled)
SELECT pack,'qa-export-route-'||pack,true FROM export_route_fixture;
INSERT INTO public.api_routes(id,pack_id,method,path_template,scope_type,scope_id,enabled)
SELECT route,pack,'POST','/qa-export-route/'||route,'global',NULL,true FROM export_route_fixture;
INSERT INTO public.integration_plugin_bindings(plugin_version_id,organization_id,scope_type,scope_id,
 binding_type,runtime_resource_type,runtime_resource_id)
SELECT f.version,f.org,'tenant',f.org,'api_route','api_routes',r.route
FROM export_fixture f CROSS JOIN export_route_fixture r;
CREATE FUNCTION pg_temp.check_export_route_scope(p_scope text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE result jsonb; expected text;
BEGIN
 UPDATE public.api_routes SET scope_type=p_scope,scope_id=p_id
 WHERE id=(SELECT route FROM export_route_fixture);
 SELECT api.integration_plugin_export_handoff_v1(version,'https://example.test') INTO result FROM export_fixture;
 SELECT activation_payload->>'issued_token' INTO expected FROM public.integration_plugin_bindings
 WHERE id=(SELECT binding FROM export_fixture);
 RETURN result->>'kind'='api' AND result->>'method'='POST' AND result->>'token'=expected
   AND result->>'endpoint'='https://example.test/functions/v1/api-gateway/t/'||expected||'/qa-export-route/'||(SELECT route FROM export_route_fixture);
END $$;
SELECT ok(pg_temp.check_export_route_scope('global',NULL),'export accepts global route');
SELECT ok(pg_temp.check_export_route_scope('tenant',(SELECT org FROM export_fixture)),'export accepts tenant route');
SELECT ok(pg_temp.check_export_route_scope('client',(SELECT client FROM export_route_fixture)),'export accepts client route');
SELECT ok(pg_temp.check_export_route_scope('sender',(SELECT sender FROM export_route_fixture)),'export accepts sender route');
SELECT ok(pg_temp.check_export_route_scope('source',(SELECT source FROM export_fixture)),'export accepts source route');
-- Force repair to be necessary, then ensure route rejection occurs before repair.
UPDATE public.integration_plugin_bindings SET activation_payload='{}'::jsonb WHERE id=(SELECT binding FROM export_fixture);
CREATE TEMP TABLE export_route_before AS SELECT s.auth_token_hash,
 (SELECT count(*) FROM public.webhook_source_token_history WHERE source_id=s.id) history_count
FROM public.webhook_sources s WHERE s.id=(SELECT source FROM export_fixture);
UPDATE public.api_routes SET scope_type='tenant',scope_id=(SELECT org FROM export_foreign)
WHERE id=(SELECT route FROM export_route_fixture);
SELECT throws_ok(format('SELECT public.integration_plugin_export_handoff_v1(%L::uuid,%L)',
 (SELECT version FROM export_fixture),'https://example.test'),'22023',
 'plugin export requires a concrete enabled api route','foreign route rejected before token repair');
SELECT ok((SELECT s.auth_token_hash=b.auth_token_hash AND
 (SELECT count(*) FROM public.webhook_source_token_history WHERE source_id=s.id)=b.history_count AND
 (SELECT activation_payload FROM public.integration_plugin_bindings WHERE id=(SELECT binding FROM export_fixture))='{}'::jsonb
 FROM public.webhook_sources s CROSS JOIN export_route_before b WHERE s.id=(SELECT source FROM export_fixture)),
 'foreign route rejection preserves hash history and empty binding');
UPDATE public.api_routes SET scope_type='global',scope_id=NULL WHERE id=(SELECT route FROM export_route_fixture);
UPDATE public.api_route_packs SET enabled=false WHERE id=(SELECT pack FROM export_route_fixture);
SELECT throws_ok(format('SELECT api.integration_plugin_export_handoff_v1(%L::uuid,%L)',
 (SELECT version FROM export_fixture),'https://example.test'),'22023',
 'plugin export requires a concrete enabled api route','disabled pack rejected before token repair');
SELECT ok((SELECT s.auth_token_hash=b.auth_token_hash AND
 (SELECT count(*) FROM public.webhook_source_token_history WHERE source_id=s.id)=b.history_count AND
 (SELECT activation_payload FROM public.integration_plugin_bindings WHERE id=(SELECT binding FROM export_fixture))='{}'::jsonb
 FROM public.webhook_sources s CROSS JOIN export_route_before b WHERE s.id=(SELECT source FROM export_fixture)),
 'disabled pack rejection preserves hash history and empty binding');
UPDATE public.webhook_sources SET enabled=false WHERE id=(SELECT source FROM export_fixture);
-- Disable itself legitimately appends revocation history; snapshot after that action.
CREATE TEMP TABLE export_disabled_before AS SELECT auth_token_hash,
  (SELECT count(*) FROM public.webhook_source_token_history
    WHERE source_id=(SELECT source FROM export_fixture)) history_count
FROM public.webhook_sources WHERE id=(SELECT source FROM export_fixture);
SELECT throws_ok(format('SELECT public.integration_plugin_export_handoff_v1(%L::uuid,%L)',
  (SELECT version FROM export_fixture),'https://example.test'),'22023',
  'plugin export requires an enabled tenant webhook source',
  'disabled source export is rejected');
SELECT ok((SELECT s.auth_token_hash=b.auth_token_hash AND
  (SELECT count(*) FROM public.webhook_source_token_history WHERE source_id=s.id)=b.history_count
  FROM public.webhook_sources s CROSS JOIN export_disabled_before b
  WHERE s.id=(SELECT source FROM export_fixture)),
  'disabled source rejection changes neither hash nor history');
SELECT finish();
ROLLBACK;
