-- Installed ACL/catalog proof. Five-category behavioral and overlapping-connection proof is native.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SELECT plan(22);
SELECT ok(NOT has_function_privilege('anon','public.register_artifact_v1(jsonb)','EXECUTE'),'anonymous generic import registration denied');
SELECT ok(NOT has_function_privilege('authenticated','api.register_artifact_v1(jsonb)','EXECUTE'),'authenticated API generic import registration denied');
SELECT ok(NOT has_function_privilege('anon','api.register_artifact_v1(jsonb)','EXECUTE'),'anonymous API generic import registration denied');
SELECT ok(has_function_privilege('service_role','api.register_artifact_v1(jsonb)','EXECUTE'),'service API import registration remains available');
SELECT has_function('public','submit_self_kyc_v1',ARRAY['text','jsonb','text','uuid'],'canonical submission exists');
SELECT has_function('api','ui_execute_self_kyc_v1',ARRAY['text','text','uuid[]','uuid','integer','jsonb','text','uuid'],'API command exists');
SELECT has_function('api','register_self_kyc_artifact_v1',ARRAY['jsonb'],'API ownership registration exists');
SELECT ok(has_function_privilege('authenticated','api.ui_execute_self_kyc_v1(text,text,uuid[],uuid,integer,jsonb,text,uuid)','EXECUTE'),'authenticated API submission allowed');
SELECT ok(NOT has_function_privilege('anon','api.ui_execute_self_kyc_v1(text,text,uuid[],uuid,integer,jsonb,text,uuid)','EXECUTE'),'anonymous API submission denied');
SELECT ok(has_function_privilege('authenticated','api.register_self_kyc_artifact_v1(jsonb)','EXECUTE'),'authenticated API registration allowed');
SELECT ok(NOT has_function_privilege('anon','api.register_self_kyc_artifact_v1(jsonb)','EXECUTE'),'anonymous registration denied');
SELECT ok(NOT has_function_privilege('authenticated','public.assert_self_kyc_object_v1(text,text)','EXECUTE'),'object authority is private');
SELECT ok(NOT has_function_privilege('authenticated','public.assert_self_kyc_actor_v1()','EXECUTE'),'actor lock authority is private');
SELECT ok(NOT has_table_privilege('authenticated','public.driver_compliance_events','INSERT,UPDATE,DELETE'),'no direct compliance write authority');
SELECT ok(NOT has_function_privilege('authenticated','public.register_artifact_v1(jsonb)','EXECUTE'),'generic import registration remains private');
SELECT ok(has_function_privilege('service_role','public.register_artifact_v1(jsonb)','EXECUTE'),'service import registration remains available');
SELECT ok((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='public.driver_self_kyc'::regclass),'self read view invokes caller security');
SELECT ok((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='api.driver_self_kyc'::regclass),'API read view invokes caller security');
SELECT throws_ok($$SELECT public.ui_assert_generic_mutation_relation_v1('public.driver_compliance_events'::regclass)$$,'42501','Compliance events require dedicated append-only RPCs','ledger aliases cannot bypass the relation guard');
SELECT throws_ok($$SELECT public.ui_assert_generic_mutation_relation_v1('public.workflow_run_triggers'::regclass)$$,'42501','Workflow run trigger mutations require dedicated lifecycle RPCs','original workflow boundary remains');
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry','global',NULL)->'commands') c
 WHERE c->>'key' IN ('driver_self_kyc.document','driver_self_kyc.vehicle_registration','driver_self_kyc.vehicle_photos','driver_self_kyc.cleaning','driver_self_kyc.pre_shift')),5,'all five current commands registered');
SELECT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(public.resolve_settings_merged('access_control_policy','global',NULL)->'roles') r
 WHERE r->>'key'='driver' AND r->'capability_keys' ? 'kyc.write'),'driver policy actually grants KYC');
SELECT * FROM finish();
ROLLBACK;
