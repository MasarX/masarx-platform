BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(27);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
CREATE TEMP TABLE readiness_fixture AS SELECT gen_random_uuid() org,gen_random_uuid() foreign_org,
 gen_random_uuid() actor,gen_random_uuid() foreign_actor,gen_random_uuid() platform_actor;
INSERT INTO public.organizations(id,name,slug)
SELECT org,'QA readiness','qa-readiness-'||org FROM readiness_fixture
UNION ALL SELECT foreign_org,'QA foreign readiness','qa-readiness-'||foreign_org FROM readiness_fixture;
INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type,access_scope_id,status)
SELECT actor,org,'qa-'||actor||'@example.test','QA readiness','ops_admin','tenant',NULL::uuid,'active' FROM readiness_fixture
UNION ALL SELECT foreign_actor,foreign_org,'qa-'||foreign_actor||'@example.test','QA foreign readiness','ops_admin','tenant',NULL::uuid,'active' FROM readiness_fixture
UNION ALL SELECT platform_actor,foreign_org,'qa-'||platform_actor||'@example.test','QA platform readiness','super_admin','platform',NULL::uuid,'active' FROM readiness_fixture;
-- Organization creation already bootstraps approved tenant defaults.
SELECT 1 FROM readiness_fixture f CROSS JOIN LATERAL public.upsert_settings_value_v1(
 'label_provider','tenant',f.org,
 '{"version":1,"providers":[{"name":"qa","invoke_url":"https://renderer.example.test","invoke_secret":"qa-readiness-sentinel","timeout_ms":15000}]}'::jsonb,
 1,'QA readiness effective fixture');
GRANT SELECT ON readiness_fixture TO authenticated;
SELECT ok(NOT has_function_privilege('anon','api.ui_label_renderer_readiness_v1(uuid)','EXECUTE'),'anonymous API grant denied');
SELECT ok(NOT has_function_privilege('authenticated','public.resolve_label_renderer_invoke_config_v1(uuid)','EXECUTE'),'internal secret-bearing resolver remains restricted');
SELECT ok(NOT has_function_privilege('anon','public.resolve_label_renderer_invoke_config_v1(uuid)','EXECUTE'),'anonymous internal resolver grant denied');
SELECT ok(has_function_privilege('service_role','public.resolve_label_renderer_invoke_config_v1(uuid)','EXECUTE'),'service resolver authority preserved');
SELECT ok(NOT has_function_privilege('authenticated','public.invoke_label_renderer(integer,jsonb)','EXECUTE'),'authenticated renderer invocation denied');
SELECT ok(NOT has_function_privilege('anon','public.invoke_label_renderer(integer,jsonb)','EXECUTE'),'anonymous renderer invocation denied');
SELECT ok(has_function_privilege('service_role','public.invoke_label_renderer(integer,jsonb)','EXECUTE'),'service renderer invocation authority preserved');
SELECT ok(CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='edge_label_renderer_role')
 THEN has_function_privilege((SELECT oid FROM pg_roles WHERE rolname='edge_label_renderer_role'),
  'public.invoke_label_renderer(integer,jsonb)'::regprocedure::oid,'EXECUTE')
 ELSE TRUE END,'optional Edge renderer invocation authority preserved when role exists');

SELECT is(public.resolve_label_renderer_organization_id_v1(
  jsonb_build_object('organization_id','00000000-0000-4000-8000-000000000001')),
  '00000000-0000-4000-8000-000000000001'::uuid,'top-level renderer tenant resolves');
SELECT is(public.resolve_label_renderer_organization_id_v1(
  jsonb_build_object('bundle',jsonb_build_object('organization_id','00000000-0000-4000-8000-000000000001'))),
  '00000000-0000-4000-8000-000000000001'::uuid,'bundle renderer tenant resolves');
SELECT is(public.resolve_label_renderer_organization_id_v1(
  jsonb_build_object('print',jsonb_build_object('organization_id','00000000-0000-4000-8000-000000000001'))),
  '00000000-0000-4000-8000-000000000001'::uuid,'print renderer tenant resolves');
SELECT is(public.resolve_label_renderer_organization_id_v1(jsonb_build_object(
  'organization_id','00000000-0000-4000-8000-000000000001',
  'bundle',jsonb_build_object('organization_id','00000000-0000-4000-8000-000000000001'),
  'print',jsonb_build_object('organization_id','00000000-0000-4000-8000-000000000001'))),
  '00000000-0000-4000-8000-000000000001'::uuid,'matching renderer tenant envelopes resolve once');

SELECT throws_ok(
  $$SELECT public.invoke_label_renderer(NULL, jsonb_build_object(
      'organization_id', '00000000-0000-4000-8000-000000000001',
      'bundle', jsonb_build_object('organization_id', '00000000-0000-4000-8000-000000000002')
  ))$$,
  '22023',
  'invoke_label_renderer: conflicting organization_id values in request envelope',
  'conflicting renderer tenant envelopes fail before provider selection'
);
SELECT ok(CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='edge_label_renderer_role')
 THEN has_function_privilege((SELECT oid FROM pg_roles WHERE rolname='edge_label_renderer_role'),
  'public.resolve_label_renderer_invoke_config_v1(uuid)'::regprocedure::oid,'EXECUTE')
 ELSE TRUE END,'optional Edge resolver authority preserved when role exists');
SET LOCAL ROLE anon;
SELECT throws_ok('SELECT public.resolve_label_renderer_invoke_config_v1(NULL)','42501',NULL,
 'anonymous direct resolver invocation denied before configuration read');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.ui_label_renderer_readiness_v1(%L::uuid)',(SELECT org FROM readiness_fixture)),'42501',NULL,'missing actor denied');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.ui_label_renderer_readiness_v1(%L::uuid)',(SELECT org FROM readiness_fixture)),'42501',NULL,'unknown actor denied');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',foreign_actor::text,true) FROM readiness_fixture;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.ui_label_renderer_readiness_v1(%L::uuid)',(SELECT org FROM readiness_fixture)),'42501',NULL,'foreign tenant actor denied');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',actor::text,true) FROM readiness_fixture;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
SET LOCAL ROLE authenticated;
SELECT throws_ok('SELECT api.ui_label_renderer_readiness_v1(NULL)','42501',NULL,'null target denied');
SELECT is((SELECT api.ui_label_renderer_readiness_v1(org) FROM readiness_fixture),'{"configured":true}'::jsonb,'effective configuration returns only safe readiness');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
-- Pending rows are outside the approved/current partial unique index.
INSERT INTO public.settings_versions(category,scope_type,scope_id,version,value,approved_at)
SELECT 'label_provider','tenant',f.org,
 (SELECT COALESCE(MAX(v.version),0)+1 FROM public.settings_versions v
  WHERE v.category='label_provider' AND v.scope_type='tenant' AND v.scope_id=f.org),
 '{"version":1,"providers":[]}'::jsonb,NULL FROM readiness_fixture f;
SELECT set_config('request.jwt.claim.sub',actor::text,true) FROM readiness_fixture;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT api.ui_label_renderer_readiness_v1(org) FROM readiness_fixture),'{"configured":true}'::jsonb,'pending version does not replace effective readiness');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
UPDATE public.settings SET cached_value=jsonb_set(cached_value,'{providers,0,timeout_ms}','"qa-error-secret-sentinel"'::jsonb)
WHERE category='label_provider' AND scope_type='tenant' AND scope_id=(SELECT org FROM readiness_fixture);
SELECT set_config('request.jwt.claim.sub',actor::text,true) FROM readiness_fixture;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT api.ui_label_renderer_readiness_v1(org) FROM readiness_fixture),'{"configured":false}'::jsonb,'malformed configuration errors never expose sentinel');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
UPDATE public.settings SET cached_value=jsonb_set(jsonb_set(cached_value,'{providers,0,timeout_ms}','15000'::jsonb),'{providers,0,invoke_secret}','"EXAMPLE_PASSWORD"'::jsonb)
WHERE category='label_provider' AND scope_type='tenant' AND scope_id=(SELECT org FROM readiness_fixture);
SELECT set_config('request.jwt.claim.sub',actor::text,true) FROM readiness_fixture;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT api.ui_label_renderer_readiness_v1(org) FROM readiness_fixture),'{"configured":false}'::jsonb,'placeholder configuration remains unconfigured');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',platform_actor::text,true) FROM readiness_fixture;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT api.ui_label_renderer_readiness_v1(org) FROM readiness_fixture),'{"configured":false}'::jsonb,'authorized platform actor can read cross-tenant safe status');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
UPDATE public.settings SET cached_value='{"version":1,"providers":[]}'::jsonb
WHERE category='label_provider' AND scope_type='tenant' AND scope_id=(SELECT org FROM readiness_fixture);
SELECT set_config('request.jwt.claim.sub',actor::text,true) FROM readiness_fixture;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT api.ui_label_renderer_readiness_v1(org) FROM readiness_fixture),'{"configured":false}'::jsonb,'missing provider configuration is unconfigured');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT 1 FROM readiness_fixture f CROSS JOIN LATERAL public.upsert_settings_value_v1(
 'access_control_policy','tenant',f.foreign_org,
 jsonb_build_object('denies',jsonb_build_array(jsonb_build_object(
 'capability_key','settings.read','scope_type','tenant','scope_id',f.foreign_org::text,
 'reason','QA readiness denial'))),1,'QA readiness denial');
SELECT set_config('request.jwt.claim.sub',foreign_actor::text,true) FROM readiness_fixture;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
SET LOCAL ROLE authenticated;
SELECT ok(NOT public.user_has_capability_v1('settings.read','tenant',foreign_org),'same-tenant fixture lacks settings.read') FROM readiness_fixture;
SELECT throws_ok(format('SELECT api.ui_label_renderer_readiness_v1(%L::uuid)',(SELECT foreign_org FROM readiness_fixture)),'42501',NULL,'same-tenant capability denial is not sanitized into readiness');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
