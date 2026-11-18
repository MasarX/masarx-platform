-- Installed-candidate API/ACL proof on a disposable target; every fixture rolls back.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT no_plan();
SELECT has_view('public','marketplace_participant_request_review_read_v1','safe participant review projection exists');
SELECT ok((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class
  WHERE oid='public.marketplace_participant_request_review_read_v1'::regclass) IS TRUE,'review view is security invoker');
SELECT ok(NOT has_table_privilege(role,'public.marketplace_participant_request_review_read_v1',
  'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),role||' has no new direct view access')
FROM unnest(ARRAY['anon','authenticated','service_role']) role;
SELECT ok(has_table_privilege('ui_rpc_executor','public.marketplace_participant_request_review_read_v1','SELECT')
  AND NOT has_table_privilege('ui_rpc_executor','public.marketplace_participant_request_review_read_v1',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'executor receives view SELECT only');
SELECT ok(NOT has_table_privilege(role,'public.marketplace_review_readback_state_v1',
  'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),role||' cannot access the independent epoch')
FROM unnest(ARRAY['anon','authenticated','service_role','ui_rpc_executor']) role;
SELECT is(obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class'),
  (SELECT value#>>'{}' FROM public.marketplace_review_readback_state_v1 WHERE key='baseline_seal'),
  'frozen executor epoch unchanged');
SELECT is(obj_description('public.marketplace_review_readback_state_v1'::regclass,'pg_class'),
  'marketplace_review_readback_state_v1:sha256:' || (SELECT encode(pg_catalog.sha256(convert_to(
    jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex') FROM public.marketplace_review_readback_state_v1),
  'marketplace epoch content matches its owner-controlled seal');
SELECT is((SELECT value FROM public.marketplace_review_readback_state_v1 WHERE key='plan_delta'),
  jsonb_build_array(jsonb_build_object('object_kind','relation','object_id',
    'public.marketplace_participant_request_review_read_v1'::regclass::oid,'privilege','SELECT','column_name',NULL)),
  'canonical plan adds exactly one view SELECT');
SELECT is((SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
    FROM public.ui_rpc_executor_privilege_plan_v1() p),
  (SELECT value FROM public.marketplace_review_readback_state_v1 WHERE key='plan_after'),
  'current plan equals the new epoch receipt');
SELECT is((SELECT resource->>'relation' FROM public.settings s,jsonb_array_elements(s.cached_value->'resources') resource
    WHERE s.category='ui_read_registry' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL
      AND resource->>'key'='marketplace_participant_requests'),
  'public.marketplace_participant_requests','canonical mutation relation is preserved');
SELECT is((SELECT resource->>'read_relation' FROM public.settings s,jsonb_array_elements(s.cached_value->'resources') resource
    WHERE s.category='ui_read_registry' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL
      AND resource->>'key'='marketplace_participant_requests'),
  'public.marketplace_participant_request_review_read_v1','canonical read route uses the safe invoker view');
SELECT ok(NOT EXISTS(SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='marketplace_participant_request_review_read_v1'
    AND column_name IN ('decision_metadata','metadata','public_status_token','ip_hash','verification_documents')),
  'projection has no raw internal metadata, status token or evidence payload');

CREATE FUNCTION pg_temp.test_marketplace_review_readback_v1() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  org UUID:=gen_random_uuid(); foreign_org UUID:=gen_random_uuid();
  platform_actor UUID:=gen_random_uuid(); tenant_actor UUID:=gen_random_uuid(); denied_actor UUID:=gen_random_uuid();
  own_request UUID:=gen_random_uuid(); foreign_request UUID:=gen_random_uuid(); approved_match UUID:=gen_random_uuid();
  null_org_request UUID:=gen_random_uuid();
  tag TEXT:=replace(gen_random_uuid()::text,'-','');
  row_result JSONB; list_result JSONB; v_metadata JSONB; expected JSONB;
  policy JSONB; registry JSONB; schema_version INT; test_scope_type TEXT; test_scope_id UUID;
  scenario TEXT; state TEXT; flag JSONB;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',TRUE);
  INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
    (org,'W2 review own','w2-review-'||org,'active'),
    (foreign_org,'W2 review foreign','w2-review-'||foreign_org,'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id) VALUES
    (platform_actor,org,platform_actor||'@example.invalid','W2 platform','ops_admin','active','platform',NULL),
    (tenant_actor,org,tenant_actor||'@example.invalid','W2 tenant','ops_admin','active','tenant',NULL),
    (denied_actor,org,denied_actor||'@example.invalid','W2 denied','driver','active','tenant',NULL);
  v_metadata:=jsonb_build_object('decision','request_additional_docs','request_additional_docs',TRUE,
    'requested_documents',jsonb_build_array(' license ','identity','license',NULL,17,'',jsonb_build_object('private','W2_PRIVATE'),
      jsonb_build_array('nested'),repeat('x',101),repeat('a',100)),
    'internal_reason','W2_INTERNAL_SENTINEL','credentials',jsonb_build_object('token','W2_PRIVATE_SENTINEL'));
  INSERT INTO public.marketplace_participant_requests(id,requested_participant_type_key,email,full_name,organization_name,
      requested_organization_id,approved_organization_id,reviewed_at,reviewed_by,review_reason,decision_metadata) VALUES
    (own_request,'freelancer_driver','w2-'||tag||'-own@example.invalid','W2 own','W2 own',org,NULL,
      now(),platform_actor,'Replace expired documents',v_metadata),
    (foreign_request,'freelancer_driver','w2-'||tag||'-foreign@example.invalid','W2 foreign','W2 foreign',foreign_org,NULL,
      now(),platform_actor,'Foreign reason',v_metadata),
    (approved_match,'freelancer_driver','w2-'||tag||'-approved@example.invalid','W2 approved match','W2 approved match',foreign_org,org,
      now(),platform_actor,'Approved-org reason',v_metadata),
    (null_org_request,'freelancer_driver','w2-'||tag||'-null@example.invalid','W2 public applicant','W2 public applicant',NULL,NULL,
      now(),platform_actor,'Public applicant reason',v_metadata);
  expected:=jsonb_build_array('license','identity',repeat('a',100));

  -- Provision both owned scopes through canonical policy/settings paths, never executor membership.
  FOREACH test_scope_type IN ARRAY ARRAY[public.get_root_scope_type_key_v1(),'tenant'] LOOP
    test_scope_id:=CASE WHEN test_scope_type='tenant' THEN org ELSE NULL END;
    SELECT resolved.policy INTO policy FROM public.resolve_access_control_policy_v1(test_scope_type,test_scope_id,FALSE) resolved;
    SELECT version INTO schema_version FROM public.schema_registry
      WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
    policy:=jsonb_set(policy,'{roles}',policy->'roles'||jsonb_build_array(
      jsonb_build_object('key','w2_reader_'||tag,'capability_keys',jsonb_build_array('marketplace_participant_requests.read'))));
    policy:=jsonb_set(policy,'{assignments}',COALESCE(policy->'assignments','{}')||jsonb_build_object('user_id',
      COALESCE(policy#>'{assignments,user_id}','{}')||jsonb_build_object(
        CASE WHEN test_scope_type='tenant' THEN tenant_actor::text ELSE platform_actor::text END,
        jsonb_build_array('w2_reader_'||tag))));
    PERFORM public.upsert_settings_value_v1('access_control_policy',test_scope_type,test_scope_id,policy,schema_version,'Rollback-only W2 reader');
  END LOOP;
  SELECT s.cached_value INTO registry FROM public.settings s WHERE category='ui_read_registry'
    AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;
  SELECT version INTO schema_version FROM public.schema_registry
    WHERE category='ui_read_registry' AND is_active ORDER BY version DESC LIMIT 1;
  PERFORM public.upsert_settings_value_v1('ui_read_registry','tenant',org,registry,schema_version,'Rollback-only W2 presentation');

  PERFORM set_config('request.jwt.claim.sub',platform_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',platform_actor,'role','authenticated')::text,TRUE);
  SET LOCAL ROLE authenticated;
  row_result:=api.ui_get_resource_v1('marketplace_participant_requests',own_request);
  RETURN NEXT ok(row_result IS NOT NULL,'platform API returns the owned request');
  RETURN NEXT is(row_result->>'review_decision','request_additional_docs','API projects the current additional-document decision');
  RETURN NEXT is(row_result->'requested_documents',expected,'API trims, deduplicates in first-seen order and rejects malformed document values');
  RETURN NEXT is(row_result->>'status','pending','additional-document review keeps canonical pending status');
  RETURN NEXT is(row_result->>'review_reason','Replace expired documents','API retains the review reason');
  RETURN NEXT ok(NOT (row_result ?| ARRAY['decision_metadata','metadata','public_status_token','ip_hash'])
    AND position('W2_INTERNAL_SENTINEL' IN row_result::text)=0 AND position('W2_PRIVATE_SENTINEL' IN row_result::text)=0,
    'API omits private metadata and token sentinels');
  RETURN NEXT is(public.ui_get_resource_v1('marketplace_participant_requests',own_request),row_result,'public/API read contracts agree');
  RETURN NEXT is(api.ui_get_resource_v1('marketplace_participant_requests',null_org_request)->>'id',null_org_request::text,
    'platform reader sees unassigned public applicants');
  RETURN NEXT throws_ok('SELECT * FROM public.marketplace_participant_request_review_read_v1 LIMIT 1','42501',NULL,
    'authenticated cannot bypass the registry through direct view access');
  RESET ROLE;

  -- Follow the canonical flag, not historical decision text retained after same-request document return.
  FOREACH scenario IN ARRAY ARRAY['resubmitted','missing_flag','json_null_flag','invalid_flag','missing_documents',
    'object_documents','null_documents','scalar_metadata','array_metadata'] LOOP
    UPDATE public.marketplace_participant_requests SET decision_metadata=v_metadata WHERE id=own_request;
    CASE scenario
      WHEN 'resubmitted' THEN UPDATE public.marketplace_participant_requests SET decision_metadata=v_metadata||
        '{"request_additional_docs":false,"documents_resubmitted":true}'::jsonb WHERE id=own_request;
      WHEN 'missing_flag' THEN UPDATE public.marketplace_participant_requests SET decision_metadata=v_metadata-'request_additional_docs' WHERE id=own_request;
      WHEN 'json_null_flag' THEN UPDATE public.marketplace_participant_requests SET decision_metadata=jsonb_set(v_metadata,'{request_additional_docs}','null') WHERE id=own_request;
      WHEN 'invalid_flag' THEN UPDATE public.marketplace_participant_requests SET decision_metadata=jsonb_set(v_metadata,'{request_additional_docs}','"invalid"') WHERE id=own_request;
      WHEN 'missing_documents' THEN UPDATE public.marketplace_participant_requests SET decision_metadata=v_metadata-'requested_documents' WHERE id=own_request;
      WHEN 'object_documents' THEN UPDATE public.marketplace_participant_requests SET decision_metadata=jsonb_set(v_metadata,'{requested_documents}','{"private":"W2_PRIVATE"}') WHERE id=own_request;
      WHEN 'null_documents' THEN UPDATE public.marketplace_participant_requests SET decision_metadata=jsonb_set(v_metadata,'{requested_documents}','null') WHERE id=own_request;
      WHEN 'scalar_metadata' THEN UPDATE public.marketplace_participant_requests SET decision_metadata='7' WHERE id=own_request;
      WHEN 'array_metadata' THEN UPDATE public.marketplace_participant_requests SET decision_metadata='[]' WHERE id=own_request;
    END CASE;
    SET LOCAL ROLE authenticated;
    row_result:=api.ui_get_resource_v1('marketplace_participant_requests',own_request);
    RETURN NEXT is(row_result->'requested_documents','[]'::jsonb,scenario||' returns an empty document array');
    IF scenario NOT IN ('missing_documents','object_documents','null_documents') THEN
      RETURN NEXT ok(row_result IS NOT NULL AND row_result->'review_decision'='null'::jsonb,
        scenario||' cannot revive a historical review decision');
    END IF;
    RESET ROLE;
  END LOOP;
  FOREACH flag IN ARRAY ARRAY['true'::jsonb,'"TRUE"'::jsonb,'"t"'::jsonb,'1'::jsonb,'"yes"'::jsonb] LOOP
    UPDATE public.marketplace_participant_requests SET decision_metadata=jsonb_set(v_metadata,'{request_additional_docs}',flag) WHERE id=own_request;
    SET LOCAL ROLE authenticated;
    RETURN NEXT is(api.ui_get_resource_v1('marketplace_participant_requests',own_request)->'requested_documents',expected,
      flag::text||' follows canonical additional-document flag semantics');
    RESET ROLE;
  END LOOP;
  FOREACH state IN ARRAY ARRAY['approved','rejected','withdrawn'] LOOP
    UPDATE public.marketplace_participant_requests SET status=state,
      review_decision=CASE WHEN state IN ('approved','rejected') THEN state ELSE NULL END,decision_metadata=v_metadata WHERE id=own_request;
    SET LOCAL ROLE authenticated;
    row_result:=api.ui_get_resource_v1('marketplace_participant_requests',own_request);
    RETURN NEXT is(row_result->'requested_documents','[]'::jsonb,state||' hides stale requested documents');
    RETURN NEXT is(row_result->>'review_decision',CASE WHEN state IN ('approved','rejected') THEN state ELSE NULL END,
      state||' preserves canonical terminal review decision');
    RESET ROLE;
  END LOOP;
  UPDATE public.marketplace_participant_requests SET status='pending',review_decision=NULL,decision_metadata=v_metadata WHERE id=own_request;

  PERFORM set_config('request.jwt.claim.sub',tenant_actor::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',tenant_actor,'role','authenticated')::text,TRUE);
  SET LOCAL ROLE authenticated;
  RETURN NEXT is(api.ui_get_resource_v1('marketplace_participant_requests',own_request)->'requested_documents',expected,
    'tenant with NULL access_scope_id retains its own organization readback');
  RETURN NEXT is(api.ui_get_resource_v1('marketplace_participant_requests',approved_match)->>'id',approved_match::text,
    'approved organization match retains the existing read boundary');
  RETURN NEXT ok(api.ui_get_resource_v1('marketplace_participant_requests',foreign_request) IS NULL,'foreign tenant request is hidden');
  RETURN NEXT ok(api.ui_get_resource_v1('marketplace_participant_requests',null_org_request) IS NULL,'tenant cannot read unassigned applicants');
  list_result:=api.ui_list_resource_v1('marketplace_participant_requests',jsonb_build_object('email','%w2-'||tag||'%'),100,0,NULL);
  RETURN NEXT is((list_result->>'total')::int,2,'API list counts only the two permitted organization matches');
  RETURN NEXT ok(list_result->'items' @> jsonb_build_array(jsonb_build_object('id',own_request,'requested_documents',expected))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(list_result->'items') item
      WHERE item->>'id' NOT IN (own_request::text,approved_match::text)),'API list contains canonical safe readback only');
  RETURN NEXT is((api.ui_resource_metrics_v1('marketplace_participant_requests',jsonb_build_object('email','%w2-'||tag||'%'),NULL)->>'total')::int,
    2,'API metrics obey the same tenant boundary');
  RETURN NEXT is(api.ui_filter_distinct_values_v1('marketplace_participant_requests','email',tag,100),
    jsonb_build_array('w2-'||tag||'-approved@example.invalid','w2-'||tag||'-own@example.invalid'),
    'API distinct suggestions cannot reveal foreign applicants');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub',denied_actor::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',denied_actor,'role','authenticated')::text,TRUE);
  SET LOCAL ROLE authenticated;
  RETURN NEXT ok(NOT public.user_has_resource_capability_v1('marketplace_participant_requests','read'),
    'negative fixture has no marketplace request read capability');
  RETURN NEXT throws_ok(format('SELECT api.ui_get_resource_v1(''marketplace_participant_requests'',%L::uuid)',own_request),
    '42501',NULL,'missing capability denies API detail');
  RETURN NEXT throws_ok('SELECT api.ui_list_resource_v1(''marketplace_participant_requests'',''{}''::jsonb,50,0,NULL)',
    '42501',NULL,'missing capability denies API list');
  RETURN NEXT throws_ok('SELECT api.ui_resource_metrics_v1(''marketplace_participant_requests'',''{}''::jsonb,NULL)',
    '42501',NULL,'missing capability denies API metrics');
  RETURN NEXT throws_ok('SELECT api.ui_filter_distinct_values_v1(''marketplace_participant_requests'',''email'',NULL,25)',
    '42501',NULL,'missing capability denies API distinct suggestions');
  RESET ROLE;
  SET LOCAL ROLE anon;
  RETURN NEXT throws_ok(format('SELECT api.ui_get_resource_v1(''marketplace_participant_requests'',%L::uuid)',own_request),
    '42501',NULL,'anonymous caller cannot use API detail');
  RESET ROLE;
END;
$test$;
SELECT * FROM pg_temp.test_marketplace_review_readback_v1();
SELECT * FROM finish();
ROLLBACK;
