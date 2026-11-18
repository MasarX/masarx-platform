BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(31);

SELECT ok(
  (SELECT p.prosecdef AND ARRAY(
     SELECT cfg FROM unnest(p.proconfig) AS cfg
      WHERE cfg LIKE 'search_path=%'
   ) = ARRAY['search_path=public, extensions, pg_temp']::text[]
     FROM pg_proc p WHERE p.oid = to_regprocedure('api.ui_upsert_api_gateway_route_mapping_v1(jsonb)')),
  'api.ui_upsert_api_gateway_route_mapping_v1(jsonb) retains SECURITY DEFINER with the exact safe search_path'
);

SELECT has_function('public', 'api_gateway_route_canonical_intent_v1', ARRAY['jsonb']);
SELECT has_function('public', 'api_gateway_mapping_target_intent_v1', ARRAY['text']);
SELECT has_function('public', 'api_gateway_mapping_intents_compatible_v1', ARRAY['text', 'text']);
SELECT has_function(
  'public',
  'api_gateway_route_request_mapping_v1',
  ARRAY['api_routes', 'uuid', 'uuid', 'uuid', 'uuid']
);
SELECT has_function(
  'public',
  'api_gateway_apply_request_mapping_v1',
  ARRAY['api_routes', 'uuid', 'uuid', 'uuid', 'uuid', 'jsonb']
);
SELECT has_function('public', 'ui_upsert_api_gateway_route_mapping_v1', ARRAY['jsonb']);
SELECT has_function('api', 'ui_upsert_api_gateway_route_mapping_v1', ARRAY['jsonb']);
SELECT has_function(
  'public',
  'workflow_intake_api_gateway_base_v1',
  ARRAY['text', 'text', 'text', 'text', 'jsonb', 'jsonb']
);

SELECT is(
  public.api_gateway_route_canonical_intent_v1(
    jsonb_build_object('postprocess', jsonb_build_object('mode', 'shipment_update_v1'))
  ),
  'shipment.update',
  'update mode resolves to a typed mutation intent'
);
SELECT is(
  public.api_gateway_route_canonical_intent_v1(
    jsonb_build_object('workflow', jsonb_build_object('intent', 'shipment.status.update'))
  ),
  'update.status',
  'status aliases resolve to the typed status intent'
);
SELECT is(
  public.api_gateway_mapping_target_intent_v1('shipments.cancel'),
  'shipment.delete',
  'cancel mapping targets normalize to delete intent'
);
SELECT is(
  public.api_gateway_mapping_target_intent_v1('shipments.reschedule'),
  'shipment.reschedule',
  'reschedule mapping targets remain typed'
);
SELECT ok(
  public.api_gateway_mapping_intents_compatible_v1('shipment.update', 'update.address'),
  'generic update routes accept typed update mappings'
);
SELECT ok(
  NOT public.api_gateway_mapping_intents_compatible_v1('shipment.delete', 'shipment.create'),
  'incompatible mapping targets fail closed'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'mapping_type'
      AND lv.value = 'api_gateway_inbound'
      AND lv.status = 'active'
  ),
  'api_gateway_inbound is registered in the row-driven mapping taxonomy'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    WHERE wt.name = 'api_gateway_shipment_mutation_default_v1'
      AND wt.status = 'active'
  ),
  'the shared compatibility mutation workflow template is active'
);

SELECT has_trigger(
  'public',
  'api_routes',
  'trg_api_routes_shipment_mutation_workflow_defaults_v1',
  'shipment mutation routes receive workflow defaults'
);

SELECT is(
  public.api_gateway_shipment_mutation_default_workflow_template_v1('shipment.reschedule'),
  'api_gateway_shipment_mutation_default_v1',
  'reschedule compatibility mutations receive workflow defaults'
);

-- Exercise the API-schema wrapper with a real tenant actor, not service claims.
INSERT INTO public.organizations(id,name,slug)
VALUES ('f6750153-0000-4000-8000-000000000001','Mapping wrapper tenant','mapping-wrapper-tenant');
INSERT INTO public.users(id,organization_id,email,full_name,access_scope_type)
VALUES ('f6750153-0000-4000-8000-000000000002','f6750153-0000-4000-8000-000000000001','mapping-wrapper@example.com','Mapping operator','tenant');
SELECT public.provision_rbac_roles_from_templates_v1(
  'f6750153-0000-4000-8000-000000000001', ARRAY['ops_admin'], 'f6750153-0000-4000-8000-000000000002');
INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
SELECT organization_id,'f6750153-0000-4000-8000-000000000002',id,'f6750153-0000-4000-8000-000000000002','{"source":"pgtap"}'::jsonb
FROM public.rbac_roles WHERE organization_id='f6750153-0000-4000-8000-000000000001' AND key='ops_admin';
INSERT INTO public.api_route_packs(id,name)
VALUES ('f6750153-0000-4000-8000-000000000003','pgtap-mapping-wrapper');
INSERT INTO public.api_routes(id,pack_id,method,path_template,scope_type,scope_id,policy)
VALUES ('f6750153-0000-4000-8000-000000000004','f6750153-0000-4000-8000-000000000003','POST','/pgtap/mapping-wrapper','tenant','f6750153-0000-4000-8000-000000000001','{"postprocess":{"mode":"shipment_update_v1"}}');
INSERT INTO public.mapping_configs(id,organization_id,mapping_type,mapping_key,mapping_config,mapping_version)
VALUES ('f6750153-0000-4000-8000-000000000005','f6750153-0000-4000-8000-000000000001','api_gateway_inbound','pgtap.mapping-wrapper.update','{"target":"shipments.update"}',1);

SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"f6750153-0000-4000-8000-000000000002"}',true);
SELECT set_config('request.jwt.claim.sub','f6750153-0000-4000-8000-000000000002',true);
SET LOCAL ROLE authenticated;
SELECT ok(auth.uid()='f6750153-0000-4000-8000-000000000002'::uuid AND NOT public.request_role_is_service_v1(), 'wrapper executes as the intended non-service actor');
SELECT ok(public.user_has_resource_capability_v1('api_routes','write','tenant','f6750153-0000-4000-8000-000000000001') AND public.user_has_capability_v1('mappings.write','tenant','f6750153-0000-4000-8000-000000000001'), 'real tenant role grants both required mapping capabilities');
SELECT is(
  api.ui_upsert_api_gateway_route_mapping_v1('{"organization_id":"f6750153-0000-4000-8000-000000000001","api_route_id":"f6750153-0000-4000-8000-000000000004","mapping_config_id":"f6750153-0000-4000-8000-000000000005"}') ->> 'mapping_config_id',
  'f6750153-0000-4000-8000-000000000005', 'authenticated API wrapper saves the compatible tenant mapping');
RESET ROLE;
SELECT is((SELECT policy #>> '{request_mapping,saved_by}' FROM public.api_routes WHERE id='f6750153-0000-4000-8000-000000000004'),'f6750153-0000-4000-8000-000000000002','saved mapping retains actual actor lineage');
SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($sql$SELECT api.ui_upsert_api_gateway_route_mapping_v1('{"organization_id":"f6750153-0000-4000-8000-000000000001","api_route_id":"f6750153-0000-4000-8000-000000000004","mapping_config_id":"f6750153-0000-4000-8000-000000000005"}')$sql$,'42501','Capability denied: api_routes.write','wrapper rejects an absent authenticated actor at the capability boundary');
RESET ROLE;
SELECT is((SELECT policy #>> '{request_mapping,saved_by}' FROM public.api_routes WHERE id='f6750153-0000-4000-8000-000000000004'),'f6750153-0000-4000-8000-000000000002','denied wrapper call preserves saved mapping lineage');

-- Test-specific RBAC roles use existing permission rows; transaction rollback owns all fixture changes.
INSERT INTO public.users(id,organization_id,email,full_name,access_scope_type)
VALUES
 ('f6750153-0000-4000-8000-000000000006','f6750153-0000-4000-8000-000000000001','mapping-only@example.com','Mapping only','tenant'),
 ('f6750153-0000-4000-8000-000000000007','f6750153-0000-4000-8000-000000000001','route-only@example.com','Route only','tenant');
DO $policy$
DECLARE
 access_policy jsonb;
 access_schema integer;
BEGIN
 SELECT public.resolve_settings_merged('access_control_policy','tenant','f6750153-0000-4000-8000-000000000001') INTO access_policy;
 SELECT version INTO STRICT access_schema FROM public.schema_registry
 WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(access_policy->'roles') r WHERE r->>'key' IN ('pgtap_mapping_only','pgtap_route_only')) THEN
   RAISE EXCEPTION 'isolated fixture role key collision';
 END IF;
 access_policy:=jsonb_set(access_policy,'{roles}',COALESCE(access_policy->'roles','[]'::jsonb)||
   '[{"key":"pgtap_mapping_only","label":"Mapping only","capability_keys":["mappings.write"]},{"key":"pgtap_route_only","label":"Route only","capability_keys":["system.write"]}]'::jsonb,true);
 access_policy:=jsonb_set(access_policy,'{assignments}',
   COALESCE(access_policy->'assignments','{}'::jsonb)||jsonb_build_object('user_id',
     COALESCE(access_policy#>'{assignments,user_id}','{}'::jsonb)||
     '{"f6750153-0000-4000-8000-000000000006":["pgtap_mapping_only"],"f6750153-0000-4000-8000-000000000007":["pgtap_route_only"]}'::jsonb),true);
 PERFORM public.upsert_settings_value_v1('access_control_policy','tenant','f6750153-0000-4000-8000-000000000001',access_policy,access_schema,'Rollback-contained isolated mapping authorization fixtures');
END;
$policy$;
CREATE TEMP TABLE mapping_policy_before_denials AS SELECT policy FROM public.api_routes WHERE id='f6750153-0000-4000-8000-000000000004';
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"f6750153-0000-4000-8000-000000000006"}',true);
SELECT set_config('request.jwt.claim.sub','f6750153-0000-4000-8000-000000000006',true);
SET LOCAL ROLE authenticated;
SELECT ok(auth.uid()='f6750153-0000-4000-8000-000000000006'::uuid AND NOT public.request_role_is_service_v1() AND public.user_has_resource_capability_v1('api_routes','write','tenant','f6750153-0000-4000-8000-000000000001') IS FALSE AND public.user_has_capability_v1('mappings.write','tenant','f6750153-0000-4000-8000-000000000001') IS TRUE,'isolated actor reaches intended api_routes.write denial');
SELECT throws_ok($sql$SELECT api.ui_upsert_api_gateway_route_mapping_v1('{"organization_id":"f6750153-0000-4000-8000-000000000001","api_route_id":"f6750153-0000-4000-8000-000000000004","mapping_config_id":"f6750153-0000-4000-8000-000000000005"}')$sql$,'42501','Capability denied: api_routes.write','isolated authenticated denial: api_routes.write');
RESET ROLE;
SELECT is((SELECT policy FROM public.api_routes WHERE id='f6750153-0000-4000-8000-000000000004'),(SELECT policy FROM mapping_policy_before_denials),'complete policy unchanged after api_routes.write denial');
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"f6750153-0000-4000-8000-000000000007"}',true);
SELECT set_config('request.jwt.claim.sub','f6750153-0000-4000-8000-000000000007',true);
SET LOCAL ROLE authenticated;
SELECT ok(auth.uid()='f6750153-0000-4000-8000-000000000007'::uuid AND NOT public.request_role_is_service_v1() AND public.user_has_resource_capability_v1('api_routes','write','tenant','f6750153-0000-4000-8000-000000000001') IS TRUE AND public.user_has_capability_v1('mappings.write','tenant','f6750153-0000-4000-8000-000000000001') IS FALSE,'isolated actor reaches intended mappings.write denial');
SELECT throws_ok($sql$SELECT api.ui_upsert_api_gateway_route_mapping_v1('{"organization_id":"f6750153-0000-4000-8000-000000000001","api_route_id":"f6750153-0000-4000-8000-000000000004","mapping_config_id":"f6750153-0000-4000-8000-000000000005"}')$sql$,'42501','Capability denied: mappings.write','isolated authenticated denial: mappings.write');
RESET ROLE;
SELECT is((SELECT policy FROM public.api_routes WHERE id='f6750153-0000-4000-8000-000000000004'),(SELECT policy FROM mapping_policy_before_denials),'complete policy unchanged after mappings.write denial');

SELECT * FROM finish();
ROLLBACK;
