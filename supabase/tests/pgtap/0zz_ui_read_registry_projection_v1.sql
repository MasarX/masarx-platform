BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(386);

SELECT is((
  WITH RECURSIVE registry_nodes(resource, node) AS (
    SELECT resource, resource->'base_filter'
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id=s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(sv.value->'resources') resource
     WHERE s.category='ui_read_registry' AND jsonb_typeof(resource->'base_filter')='object'
    UNION ALL
    SELECT resource, rule FROM registry_nodes
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(node->'rules')='array'
        THEN node->'rules' ELSE '[]'::JSONB END) rule
  )
  SELECT count(*) FROM registry_nodes
   WHERE jsonb_typeof(node->'rules') IS DISTINCT FROM 'array'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(resource->'filters','[]'::JSONB)) def
        WHERE def->>'key'=node->>'key' AND NULLIF(btrim(def->>'column'),'') IS NOT NULL
     )
),0::BIGINT,'every registry base_filter rule references an existing filter key with a column');

-- Use the production strict compiler as the authoring contract for every scope.
SELECT lives_ok($registry_contract$
  DO $contract$
  DECLARE v_resource JSONB;
  BEGIN
    FOR v_resource IN
      SELECT resource FROM public.settings s
      JOIN public.settings_versions sv ON sv.id=s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(sv.value->'resources') resource
      WHERE s.category='ui_read_registry' AND resource ? 'base_filter'
    LOOP
      PERFORM public.ui_filter_tree_sql_v1(v_resource->'base_filter',
        COALESCE(v_resource->'filters','[]'::JSONB));
    END LOOP;
  END;
  $contract$;
$registry_contract$, 'every scoped registry base_filter compiles strictly, including values, groups and operators');

SELECT ok(NOT has_function_privilege('authenticated',
  'public.ui_read_projection_columns_v1(jsonb,regclass)', 'EXECUTE'),
  'projection helper is private to checked read RPCs');

SELECT is((
  SELECT count(*) FROM public.settings s
  JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  CROSS JOIN LATERAL jsonb_array_elements(sv.value->'resources') resource
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource->'filters','[]')) filter_def
  WHERE s.category='ui_read_registry'
    AND NOT COALESCE(filter_def->>'column' = ANY(public.ui_read_projection_columns_v1(
      resource,to_regclass(COALESCE(NULLIF(btrim(resource->>'read_relation'), ''), resource->>'relation')))),FALSE)
),0::BIGINT,'every current scoped registry filter column belongs to its allowed projection');
SELECT diag(format('unprojected registry filter: scope=%s/%s resource=%s filter=%s column=%s',
  s.scope_type, s.scope_hash, resource->>'key', filter_def->>'key', filter_def->>'column'))
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  CROSS JOIN LATERAL jsonb_array_elements(sv.value->'resources') resource
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource->'filters','[]')) filter_def
 WHERE s.category='ui_read_registry'
   AND NOT COALESCE(filter_def->>'column' = ANY(public.ui_read_projection_columns_v1(
     resource,to_regclass(COALESCE(NULLIF(btrim(resource->>'read_relation'), ''), resource->>'relation')))),FALSE);

SELECT ok(NOT has_function_privilege('authenticated',
  'public.ui_read_caller_filter_sql_v1(jsonb,jsonb,text[])', 'EXECUTE')
  AND NOT has_function_privilege('anon',
  'public.ui_read_caller_filter_sql_v1(jsonb,jsonb,text[])', 'EXECUTE')
  AND NOT has_function_privilege('service_role',
  'public.ui_read_caller_filter_sql_v1(jsonb,jsonb,text[])', 'EXECUTE'),
  'caller filter compiler remains private to checked list and metrics RPCs');

SELECT ok(NOT has_function_privilege('authenticated',
  'public.tabular_import_match_target_v1(text,text,jsonb,text[])','EXECUTE')
  AND NOT has_function_privilege('anon',
  'public.tabular_import_match_target_v1(text,text,jsonb,text[])','EXECUTE'),
  'dynamic import matching remains internal, not a caller-controlled relation oracle');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.tabular_import_write_row_v1(text,text,jsonb,text)','EXECUTE')
  AND NOT has_function_privilege('anon',
  'public.tabular_import_write_row_v1(text,text,jsonb,text)','EXECUTE')
  AND has_function_privilege('service_role',
  'public.tabular_import_write_row_v1(text,text,jsonb,text)','EXECUTE'),
  'full-row import write result remains internal to service execution');
SELECT diag(format('import writer EXECUTE: anon=%s authenticated=%s service_role=%s',
  has_function_privilege('anon','public.tabular_import_write_row_v1(text,text,jsonb,text)','EXECUTE'),
  has_function_privilege('authenticated','public.tabular_import_write_row_v1(text,text,jsonb,text)','EXECUTE'),
  has_function_privilege('service_role','public.tabular_import_write_row_v1(text,text,jsonb,text)','EXECUTE')));

-- A controlled table proves projection guards while the executor obeys RLS.
CREATE TEMP TABLE ui_projection_scope_fixture (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL, safe_name TEXT,
  detail_name TEXT, internal_sort INTEGER, secret TEXT, "quoted field" TEXT
);
ALTER TABLE pg_temp.ui_projection_scope_fixture ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_org ON pg_temp.ui_projection_scope_fixture FOR ALL TO authenticated, ui_rpc_executor
  USING (organization_id = public.current_user_org_id())
  WITH CHECK (organization_id = public.current_user_org_id());
GRANT SELECT ON pg_temp.ui_projection_scope_fixture TO authenticated;
GRANT SELECT, UPDATE, DELETE ON pg_temp.ui_projection_scope_fixture TO ui_rpc_executor;
DO $temp_grant$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ui_rpc_executor',pg_my_temp_schema()::regnamespace);
END; $temp_grant$;

CREATE FUNCTION pg_temp.test_ui_read_registry_projection_v1() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $test$
DECLARE
  v_org UUID := gen_random_uuid(); v_other_org UUID := gen_random_uuid();
  v_platform UUID := gen_random_uuid(); v_actor UUID := gen_random_uuid(); v_provider UUID := gen_random_uuid();
  v_foreign_provider UUID := gen_random_uuid(); v_foreign_config UUID := gen_random_uuid();
  v_config UUID := gen_random_uuid(); v_legacy UUID := gen_random_uuid();
  v_device UUID := gen_random_uuid(); v_signup UUID := gen_random_uuid();
  v_webhook UUID := gen_random_uuid(); v_own UUID := gen_random_uuid();
  v_foreign UUID := gen_random_uuid(); v_secret UUID;
  v_marker TEXT := 'QA-UI-PROJECTION-SECRET-' || gen_random_uuid();
  v_registry JSONB; v_resource JSONB; v_policy JSONB; v_global_policy JSONB; v_schema INTEGER;
  v_role_key TEXT := 'qa_projection_' || replace(gen_random_uuid()::TEXT, '-', '');
  v_detail JSONB; v_list JSONB; v_expected TEXT[]; v_case RECORD; v_bad JSONB;
  v_api_schema TEXT; v_read_sql TEXT; v_bad_defs JSONB;
  v_api_rejection UUID := gen_random_uuid(); v_webhook_rejection UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
    (v_org,'UI projection fixture','ui-projection-'||v_org,'active'),
    (v_other_org,'Foreign UI projection fixture','ui-projection-'||v_other_org,'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
    VALUES(v_actor,v_org,'projection-'||v_actor||'@example.test','Projection reader','sender_user','active','tenant',NULL);
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
    VALUES(v_platform,v_org,'projection-platform-'||v_platform||'@example.test','Projection platform','super_admin','active','platform');
  INSERT INTO public.providers(id,organization_id,name,provider_type,enabled)
    VALUES(v_provider,v_org,'Projection provider','http',TRUE),
      (v_foreign_provider,v_other_org,'Foreign projection provider','http',TRUE);
  v_secret := vault.create_secret(jsonb_build_object('api_key',v_marker)::TEXT,
    'provider_auth_configs/'||v_config,'Rollback-only UI projection fixture',NULL);
  INSERT INTO public.provider_auth_configs(id,provider_id,auth_type,credentials,credentials_vault_id) VALUES
    (v_config,v_provider,'api_key',NULL,v_secret),
    (v_legacy,v_provider,'api_key',jsonb_build_object('api_key',v_marker),NULL),
    (v_foreign_config,v_foreign_provider,'api_key',jsonb_build_object('api_key',v_marker),NULL);
  INSERT INTO public.user_devices(id,organization_id,user_id,device_platform,device_identifier_sha256,push_token,device_label)
    VALUES(v_device,v_org,v_actor,'android',v_marker,v_marker,'Projection phone');
  INSERT INTO public.tenant_signup_requests(id,email,full_name,organization_name,ip_hash,notes,metadata,decision_metadata)
    VALUES(v_signup,'projection-'||v_signup||'@example.test','Prospective reader','Prospective org',
      v_marker,v_marker,jsonb_build_object('private',v_marker),jsonb_build_object('private',v_marker));
  INSERT INTO public.webhook_log(id,organization_id,direction,method,url,headers,request_body,response_body,timestamp)
    VALUES(v_webhook,v_org,'inbound','POST','https://example.test/projection',
      jsonb_build_object('authorization',v_marker),jsonb_build_object('private',v_marker),
      jsonb_build_object('private',v_marker),'2025-10-22 12:00:00+00');
  INSERT INTO public.intake_auth_rejections(id,organization_id,service,surface,failure_code) VALUES
    (v_api_rejection,v_org,'api_gateway','qa_filter_tree','qa_filter_tree'),
    (v_webhook_rejection,v_org,'webhook_receiver','qa_filter_tree','qa_filter_tree');
  INSERT INTO pg_temp.ui_projection_scope_fixture VALUES
    (v_own,v_org,'Own row','Own detail',2,v_marker,'Own quoted'),
    (v_foreign,v_other_org,'Foreign row','Foreign detail',1,v_marker,'Foreign quoted');

  SELECT p.policy,(SELECT version FROM public.schema_registry WHERE category='access_control_policy'
    AND is_active ORDER BY version DESC LIMIT 1) INTO STRICT v_policy,v_schema
    FROM public.resolve_access_control_policy_v1('tenant',v_org,FALSE) p;
  v_policy := jsonb_set(v_policy,'{roles}',v_policy->'roles'||jsonb_build_array(
    jsonb_build_object('key',v_role_key,'capability_keys',jsonb_build_array(
      'provider_auth.read','user_devices.read','tenant_signup_requests.read','webhooks.read','api_gateway.read','audit_log.read'))));
  v_policy := jsonb_set(v_policy,'{assignments}',COALESCE(v_policy->'assignments','{}')||jsonb_build_object(
    'user_id',COALESCE(v_policy#>'{assignments,user_id}','{}')||jsonb_build_object(v_actor::TEXT,jsonb_build_array(v_role_key))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',v_org,v_policy,v_schema,'Rollback-only projection reader');
  SELECT policy INTO v_global_policy FROM public.resolve_access_control_policy_v1('global',NULL,FALSE);
  v_global_policy := jsonb_set(v_global_policy,'{roles}',v_global_policy->'roles'||jsonb_build_array(
    jsonb_build_object('key',v_role_key,'capability_keys',jsonb_build_array(
      'provider_auth.read','user_devices.read','tenant_signup_requests.read','webhooks.read','audit_log.read'))));
  v_global_policy := jsonb_set(v_global_policy,'{assignments}',COALESCE(v_global_policy->'assignments','{}')||jsonb_build_object(
    'user_id',COALESCE(v_global_policy#>'{assignments,user_id}','{}')||jsonb_build_object(v_platform::TEXT,jsonb_build_array(v_role_key))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','global',NULL,v_global_policy,v_schema,'Rollback-only platform projection reader');

  SELECT sv.value,sv.schema_version INTO STRICT v_registry,v_schema
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='ui_read_registry' AND s.scope_type='global' AND s.scope_id IS NULL;
  -- Exact-count assertions own their test policy; the production telemetry estimate stays unchanged.
  v_registry:=jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='webhook_log'
    THEN jsonb_set(value,'{total_strategy}','"exact"'::jsonb) ELSE value END)
    FROM jsonb_array_elements(v_registry->'resources')));
  v_resource := jsonb_build_object('key','qa_ui_projection',
    'relation',format('%I.ui_projection_scope_fixture',pg_my_temp_schema()::regnamespace),
    'id_column','id','allow_delete',TRUE,'capability_read','webhooks.read','select',jsonb_build_array('safe_name','quoted field','not_a_column',
      'safe_name; DROP TABLE users; --'),
    'columns',jsonb_build_array(jsonb_build_object('key','detail_name','edit_mode','inline')),
    'filters',jsonb_build_array(jsonb_build_object('key','id','column','id','op','eq'),
      jsonb_build_object('key','safe_name','column','safe_name','op','eq'),
      jsonb_build_object('key','hidden_secret','column','secret','op','ilike')),
    'default_sort',jsonb_build_object('column','internal_sort','direction','asc'));
  -- The deliberately invalid hidden_secret declaration tests runtime fail-closed caller reads.
  v_registry := jsonb_set(v_registry,'{resources}',v_registry->'resources'||jsonb_build_array(v_resource));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only projection registry');
  PERFORM public.upsert_settings_value_v1('ui_read_registry','tenant',v_org,v_registry,v_schema,'Rollback-only projection fixture presentation');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM set_config('request.jwt.claim.sub',v_actor::TEXT,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::TEXT,TRUE);
  SET LOCAL ROLE authenticated;
  RETURN NEXT ok(auth.uid()=v_actor AND current_user='authenticated', 'reads use a real authenticated tenant session');

  -- Both capabilities are granted so RLS cannot hide a missing resource predicate.
  FOR v_case IN SELECT * FROM (VALUES
    ('api_gateway_auth_rejections','api_gateway',v_api_rejection,v_webhook_rejection,'webhook_receiver'),
    ('webhook_auth_rejections','webhook_receiver',v_webhook_rejection,v_api_rejection,'api_gateway')
  ) cases(resource_key,service,row_id,other_id,other_service)
  LOOP
    FOREACH v_api_schema IN ARRAY ARRAY['public','api'] LOOP
      EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,10,0,NULL)',v_api_schema)
        INTO v_list USING v_case.resource_key,jsonb_build_object('id',jsonb_build_array(v_api_rejection,v_webhook_rejection));
      RETURN NEXT ok((v_list->>'total')::INTEGER=1 AND v_list#>>'{items,0,id}'=v_case.row_id::TEXT
        AND v_list#>>'{items,0,service}'=v_case.service,
        v_api_schema||' '||v_case.resource_key||' lists only its own service');
      EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,10,0,NULL)',v_api_schema)
        INTO v_list USING v_case.resource_key,jsonb_build_object('id',v_case.other_id,'service',v_case.other_service);
      RETURN NEXT is((v_list->>'total')::INTEGER,0,
        v_api_schema||' '||v_case.resource_key||' caller service cannot bypass base_filter');
      EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',v_api_schema)
        INTO v_detail USING v_case.resource_key,v_case.row_id;
      RETURN NEXT is(v_detail->>'id',v_case.row_id::TEXT,
        v_api_schema||' '||v_case.resource_key||' get retains matching service');
      EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',v_api_schema)
        INTO v_detail USING v_case.resource_key,v_case.other_id;
      RETURN NEXT ok(v_detail IS NULL,
        v_api_schema||' '||v_case.resource_key||' get hides the other service');
    END LOOP;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub',v_platform::TEXT,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_platform,'role','authenticated')::TEXT,TRUE);
  FOR v_case IN SELECT * FROM (VALUES
    ('provider_auth_configs',v_config,ARRAY['credentials','credentials_vault_id']),
    ('provider_auth_configs',v_legacy,ARRAY['credentials','credentials_vault_id']),
    ('user_devices',v_device,ARRAY['push_token','device_identifier_sha256']),
    ('tenant_signup_requests',v_signup,ARRAY['ip_hash','notes','metadata','decision_metadata','approved_auth_user_id']),
    ('webhook_log',v_webhook,ARRAY['headers','request_body','response_body'])
  ) AS cases(resource_key,row_id,forbidden)
  LOOP
    SELECT value INTO STRICT v_bad FROM jsonb_array_elements(v_registry->'resources')
      WHERE value->>'key'=v_case.resource_key;
    -- Use the frozen contract independently of the projection helper under test.
    SELECT array_agg(DISTINCT name) INTO v_expected FROM (
      SELECT jsonb_array_elements_text(v_bad->'select') AS name
      UNION SELECT entry->>'key' FROM jsonb_array_elements(COALESCE(v_bad->'columns','[]')) entry
      UNION SELECT COALESCE(v_bad->>'id_column','id')
    ) declared WHERE name IN (SELECT a.attname::TEXT FROM pg_attribute a
      WHERE a.attrelid=to_regclass(v_bad->>'relation') AND a.attnum>0 AND NOT a.attisdropped);
    v_detail := api.ui_get_resource_v1(v_case.resource_key,v_case.row_id);
    v_list := api.ui_list_resource_v1(v_case.resource_key,jsonb_build_object('id',v_case.row_id),10,0,NULL);
    RETURN NEXT ok(v_detail->>'id'=v_case.row_id::TEXT AND v_detail ?& v_expected,
      v_case.resource_key||' get retains identity and every declared actual column');
    RETURN NEXT ok(NOT(v_detail ?| v_case.forbidden) AND position(v_marker IN v_detail::TEXT)=0,
      v_case.resource_key||' get omits sensitive columns and values');
    RETURN NEXT is(jsonb_array_length(v_list->'items'),1,v_case.resource_key||' list locates the fixture through internal id filtering');
    RETURN NEXT ok((v_list#>'{items,0}') ?& v_expected AND NOT((v_list#>'{items,0}') ?| v_case.forbidden)
      AND position(v_marker IN v_list::TEXT)=0,v_case.resource_key||' list retains declared fields without secrets');
    RETURN NEXT is((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_detail) key),
      (SELECT array_agg(name ORDER BY name) FROM unnest(v_expected) name),v_case.resource_key||' get returns exactly allowed keys');
    RETURN NEXT is((SELECT array_agg(key ORDER BY key) FROM jsonb_array_elements_text(v_list->'keys') key),
      (SELECT array_agg(name ORDER BY name) FROM unnest(v_expected) name),v_case.resource_key||' list keys disclose only projected names');
    RETURN NEXT is((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_list#>'{items,0}') key),
      (SELECT array_agg(name ORDER BY name) FROM unnest(v_expected) name),v_case.resource_key||' list items return exactly allowed keys');
    v_list := api.ui_list_resource_v1(v_case.resource_key,
      jsonb_build_object('id',v_case.row_id,v_case.forbidden[1],'not-the-hidden-value'),10,0,NULL);
    RETURN NEXT ok((v_list->>'total')::INTEGER=1 AND NOT (v_list->>'total_is_estimate')::BOOLEAN
      AND jsonb_array_length(v_list->'items')=1,
      v_case.resource_key||' implicit hidden-column filter is ignored without changing exact totals');
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub',v_actor::TEXT,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::TEXT,TRUE);
  SELECT value INTO STRICT v_bad FROM jsonb_array_elements(v_registry->'resources')
    WHERE value->>'key'='provider_auth_configs';
  RETURN NEXT ok(v_bad->>'relation' IN ('public.provider_auth_configs','public.provider_auth_configs_visible_v1'),
    'provider org-scope documentation covers the base registry and the independent narrow-view repair');
  v_detail := api.ui_get_resource_v1('provider_auth_configs',v_foreign_config);
  v_list := api.ui_list_resource_v1('provider_auth_configs',jsonb_build_object('id',v_foreign_config),10,0,NULL);
  RETURN NEXT is(v_detail IS NULL,TRUE,
    'executor RLS hides foreign provider detail through base and safe-view routing');
  RETURN NEXT is(jsonb_array_length(v_list->'items'),
    0,
    'executor RLS hides foreign provider list rows');

  v_detail := api.ui_get_resource_v1('qa_ui_projection',v_foreign);
  v_list := api.ui_list_resource_v1('qa_ui_projection','{}',1,0,'{"key":"internal_sort","direction":"desc"}');
  RETURN NEXT ok(v_detail IS NULL,
    'executor RLS denies foreign detail without scope_columns');
  RETURN NEXT is(v_list#>>'{items,0,id}',v_own::TEXT,'hidden caller sort is ignored; registry default sort still applies with pagination');
  v_detail := api.ui_get_resource_v1('qa_ui_projection',v_own);
  RETURN NEXT ok(v_detail ?& ARRAY['id','safe_name','detail_name','quoted field']
    AND NOT(v_detail ?| ARRAY['secret','organization_id','internal_sort','not_a_column','safe_name; DROP TABLE users; --']),
    'output is the declared union intersected with actual columns; quoted names work and untrusted names cannot become SQL');
  v_list := api.ui_list_resource_v1('qa_ui_projection','{"internal_sort":2}',10,0,NULL);
  RETURN NEXT is(v_list#>>'{items,0,id}',v_own::TEXT,'undeclared hidden flat filter is ignored');
  RETURN NEXT is((v_list->>'total')::INTEGER,1,'ignored hidden filter does not reveal a matching exact total');
  v_list := api.ui_list_resource_v1('qa_ui_projection','{"internal_sort":[2]}',10,0,NULL);
  RETURN NEXT is((v_list->>'total')::INTEGER,1,'hidden array filter cannot infer a matching value');
  v_list := api.ui_list_resource_v1('qa_ui_projection','{}',1,0,'{"key":"safe_name","direction":"desc"}');
  RETURN NEXT is(v_list#>>'{items,0,id}',v_own::TEXT,'projected caller sort remains available');
  v_list := api.ui_list_resource_v1('qa_ui_projection',
    '{"rules":[{"key":"safe_name","value":"Own row"}]}',10,0,NULL);
  RETURN NEXT is((v_list->>'total')::INTEGER,1,'registry-declared tree filters retain their contract');
  RETURN NEXT is(api.ui_filter_distinct_values_v1('qa_ui_projection','safe_name','Own',1),
    '["Own row"]'::JSONB,'distinct values retain projected columns, query and limit');
  RETURN NEXT is(api.ui_filter_distinct_values_v1('qa_ui_projection','safe_name',NULL,25),
    '["Own row"]'::JSONB,'distinct without a base filter retains only RLS-visible values');
  RETURN NEXT throws_ok('SELECT api.ui_filter_distinct_values_v1(''qa_ui_projection'',''hidden_secret'',NULL,25)',
    'P0001','ui_filter_distinct_values_v1 filter column not allowed: hidden_secret',
    'distinct values fail closed for a declared filter outside the allowed projection');

  FOR v_case IN SELECT * FROM (VALUES
    ('{"hidden_secret":"QA-UI-PROJECTION-SECRET-%"}'::JSONB,'flat ilike'),
    ('{"hidden_secret":["QA-UI-PROJECTION-SECRET-%"]}'::JSONB,'flat array ilike'),
    ('{" hidden_secret ":"QA-UI-PROJECTION-SECRET-%"}'::JSONB,'trimmed flat alias'),
    ('{"rules":[{"key":"hidden_secret","op":"ilike","value":"QA-UI-PROJECTION-SECRET-%"}]}'::JSONB,'tree ilike'),
    ('{"op":"or","rules":[{"key":"safe_name","value":"Own row"},{"op":"and","rules":[{"key":"hidden_secret","op":"ilike","value":"QA-UI-PROJECTION-SECRET-%"}]}]}'::JSONB,'nested tree ilike'),
    ('{"rules":[{"key":"hidden_secret","op":"gt","value":"QA"}]}'::JSONB,'tree gt override'),
    ('{"rules":[{"key":"hidden_secret","op":"lt","value":"QZ"}]}'::JSONB,'tree lt override'),
    ('{"rules":[{"key":"hidden_secret","op":"ne","value":"wrong-prefix"}]}'::JSONB,'tree ne override'),
    ('{"rules":null,"key":"hidden_secret","op":"ilike","value":"QA-UI-PROJECTION-SECRET-%"}'::JSONB,'non-array rules leaf')
  ) AS cases(filters,case_name)
  LOOP
    RETURN NEXT throws_ok(format('SELECT api.ui_list_resource_v1(%L,%L::JSONB,10,0,NULL)',
      'qa_ui_projection',v_case.filters::TEXT),'P0001','ui_read_registry filter column not allowed: hidden_secret',
      'list rejects hidden declared column: '||v_case.case_name);
    RETURN NEXT throws_ok(format('SELECT api.ui_resource_metrics_v1(%L,%L::JSONB,NULL)',
      'qa_ui_projection',v_case.filters::TEXT),'P0001','ui_read_registry filter column not allowed: hidden_secret',
      'metrics rejects hidden declared column: '||v_case.case_name);
  END LOOP;
  RETURN NEXT is((api.ui_resource_metrics_v1('qa_ui_projection','{}',NULL)->>'total')::INTEGER,1,
    'unused hidden declaration does not block unfiltered metrics');
  RETURN NEXT is((api.ui_resource_metrics_v1('qa_ui_projection','{"safe_name":"Own row"}',ARRAY['id'])->>'total')::INTEGER,1,
    'metrics retains projected flat filters independently of aggregate column selection');
  RETURN NEXT is((api.ui_resource_metrics_v1('qa_ui_projection',
    '{"rules":[{"key":"safe_name","op":"ilike","value":"Own%"}]}',NULL)->>'total')::INTEGER,1,
    'metrics retains projected tree filters and operator overrides');
  RETURN NEXT is(api.ui_resource_metrics_v1('qa_ui_projection','{}',ARRAY['internal_sort'])->'columns','{}'::JSONB,
    'metrics aggregate column requests cannot promote hidden numeric columns');

  RETURN NEXT is(public.ui_filter_tree_sql_v1('{"key":"safe_name","op":"is_null"}',v_resource->'filters'),
    'safe_name IS NULL','strict compiler preserves value-free is_null');
  RETURN NEXT is(public.ui_filter_tree_sql_v1('{"key":"safe_name","op":"not_null","value":null}',v_resource->'filters'),
    'safe_name IS NOT NULL','strict compiler preserves value-free not_null');
  RETURN NEXT is(public.ui_filter_tree_sql_v1('{"key":"bad_column","value":"x"}',
    '[{"key":"bad_column"}]',FALSE),NULL::TEXT,'explicit permissive compiler preserves missing-column behavior');
  RETURN NEXT throws_ok('SELECT public.ui_filter_tree_sql_v1(NULL,''[]''::JSONB)',
    'P0001','ui_filter_tree_sql_v1 invalid filter: expected an object','strict compiler rejects SQL null input');

  FOR v_case IN SELECT * FROM (VALUES
    ('mixed unknown tree rule','{"rules":[{"key":"safe_name","value":"Own row"},{"key":"unknown","value":"x"}]}'::JSONB,1),
    ('null tree value','{"rules":[{"key":"safe_name","value":null}]}'::JSONB,1),
    ('empty caller group','{"rules":[]}'::JSONB,1),
    ('null flat value','{"safe_name":null}'::JSONB,1),
    ('unknown caller group op','{"op":"not","rules":[{"key":"safe_name","value":"Own row"}]}'::JSONB,1)
  ) cases(case_name,filters,expected_total)
  LOOP
    FOREACH v_api_schema IN ARRAY ARRAY['public','api'] LOOP
      EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,10,0,NULL)',v_api_schema)
        INTO v_list USING 'qa_ui_projection',v_case.filters;
      RETURN NEXT is((v_list->>'total')::INTEGER,v_case.expected_total,
        'caller filter preserves UX: '||v_api_schema||' list '||v_case.case_name);
      EXECUTE format('SELECT %I.ui_resource_metrics_v1($1,$2,NULL)',v_api_schema)
        INTO v_list USING 'qa_ui_projection',v_case.filters;
      RETURN NEXT is((v_list->>'total')::INTEGER,v_case.expected_total,
        'caller filter preserves UX: '||v_api_schema||' metrics '||v_case.case_name);
    END LOOP;
  END LOOP;

  v_bad_defs := v_resource->'filters'||'[{"key":"bad_column"},{"key":"blank_column","column":""},
    {"key":"null_column","column":null},{"key":"identifier","column":"id","resolver":"shipment_identifier"}]'::JSONB;
  FOR v_case IN SELECT * FROM (VALUES
    ('missing key','{"rules":[{"key":"unknown","value":"x"}]}'::JSONB,'unknown filter key'),
    ('missing column','{"rules":[{"key":"bad_column","value":"x"}]}'::JSONB,'missing filter column'),
    ('omitted value','{"rules":[{"key":"safe_name"}]}'::JSONB,'missing filter value'),
    ('null value','{"rules":[{"key":"safe_name","value":null}]}'::JSONB,'missing filter value'),
    ('empty group','{"rules":[]}'::JSONB,'empty group'),
    ('nested unknown','{"rules":[{"key":"safe_name","value":"Own row"},{"rules":[{"key":"unknown","value":"x"}]}]}'::JSONB,'unknown filter key'),
    ('mixed OR','{"op":"or","rules":[{"key":"safe_name","value":"Own row"},{"key":"unknown","value":"x"}]}'::JSONB,'unknown filter key'),
    ('empty values','{"rules":[{"key":"safe_name","value":[]}]}'::JSONB,'empty filter values'),
    ('empty value','{"rules":[{"key":"safe_name","value":""}]}'::JSONB,'empty filter value'),
    ('missing rule key','{"rules":[{}]}'::JSONB,'missing filter key'),
    ('null rule','{"rules":[null]}'::JSONB,'expected an object'),
    ('malformed rules','{"rules":null}'::JSONB,'rules must be an array'),
    ('empty identifier array','{"rules":[{"key":"identifier","value":[]}]}'::JSONB,'empty shipment identifier values'),
    ('empty identifier','{"rules":[{"key":"identifier","value":"  "}]}'::JSONB,'empty shipment identifier value'),
    ('blank column','{"rules":[{"key":"blank_column","value":"x"}]}'::JSONB,'missing filter column'),
    ('null column','{"rules":[{"key":"null_column","value":"x"}]}'::JSONB,'missing filter column'),
    ('mixed AND','{"op":"and","rules":[{"key":"safe_name","value":"Own row"},{"key":"unknown","value":"x"}]}'::JSONB,'unknown filter key'),
    ('nested empty group','{"rules":[{"key":"safe_name","value":"Own row"},{"rules":[]}]}'::JSONB,'empty group'),
    ('unknown group op','{"op":"not","rules":[{"key":"safe_name","value":"Own row"}]}'::JSONB,'unknown group op')
  ) cases(case_name,filters,error_reason)
  LOOP
    SET LOCAL ROLE postgres;
    v_bad := jsonb_set(jsonb_set(v_resource,'{filters}',v_bad_defs),'{base_filter}',v_case.filters);
    v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
      THEN v_bad ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
    PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only invalid base filter');
    SET LOCAL ROLE authenticated;
    FOREACH v_api_schema IN ARRAY ARRAY['public','api'] LOOP
      FOREACH v_read_sql IN ARRAY ARRAY[
        format('SELECT %I.ui_list_resource_v1(''qa_ui_projection'',''{}'',10,0,NULL)',v_api_schema),
        format('SELECT %I.ui_filter_distinct_values_v1(''qa_ui_projection'',''safe_name'',NULL,25)',v_api_schema),
        format('SELECT %I.ui_resource_metrics_v1(''qa_ui_projection'',''{}'',NULL)',v_api_schema),
        format('SELECT %I.ui_get_resource_v1(''qa_ui_projection'',%L::UUID)',v_api_schema,v_own),
        format('SELECT %I.ui_update_resource_v1(''qa_ui_projection'',%L,''{"detail_name":"Blocked"}'')',v_api_schema,v_own::TEXT),
        format('SELECT %I.ui_delete_resource_v1(''qa_ui_projection'',%L)',v_api_schema,v_own::TEXT)
      ] LOOP
        RETURN NEXT throws_ok(v_read_sql,'P0001','ui_filter_tree_sql_v1 invalid filter: '||v_case.error_reason,
          'invalid base_filter fails closed: '||v_api_schema||' '||v_case.case_name||' '||v_read_sql);
      END LOOP;
    END LOOP;
  END LOOP;

  SET LOCAL ROLE postgres;
  v_bad := jsonb_set(v_resource,'{base_filter}',jsonb_build_object('rules',jsonb_build_array(
    jsonb_build_object('key','hidden_secret','op','ne','value',v_marker))));
  v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
    THEN v_bad ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only trusted hidden base filter');
  SET LOCAL ROLE authenticated;
  RETURN NEXT is((api.ui_list_resource_v1('qa_ui_projection','{}',10,0,NULL)->>'total')::INTEGER,0,
    'list retains full registry definitions for trusted hidden base filters');
  RETURN NEXT is((api.ui_resource_metrics_v1('qa_ui_projection','{}',NULL)->>'total')::INTEGER,0,
    'metrics retains full registry definitions for trusted hidden base filters');
  RETURN NEXT is(api.ui_filter_distinct_values_v1('qa_ui_projection','safe_name',NULL,25),
    '[]'::JSONB,'distinct returns no values when the trusted base filter excludes every row');
  RETURN NEXT throws_ok('SELECT api.ui_filter_distinct_values_v1(''qa_ui_projection'',''hidden_secret'',NULL,25)',
    'P0001','ui_filter_distinct_values_v1 filter column not allowed: hidden_secret',
    'an empty base-filter result does not bypass the distinct projection guard');

  FOREACH v_api_schema IN ARRAY ARRAY['public','api'] LOOP
    EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',v_api_schema)
      INTO v_detail USING 'qa_ui_projection',v_own;
    RETURN NEXT ok(v_detail IS NULL,v_api_schema||' get respects hidden-column base_filter');
    RETURN NEXT throws_ok(format('SELECT %I.ui_update_resource_v1(%L,%L,%L::JSONB)',
      v_api_schema,'qa_ui_projection',v_own::TEXT,'{"detail_name":"Blocked"}'),
      '42501','ui_update_resource_v1 resource not available',
      v_api_schema||' update cannot modify rows outside base_filter');
    RETURN NEXT throws_ok(format('SELECT %I.ui_delete_resource_v1(%L,%L)',
      v_api_schema,'qa_ui_projection',v_own::TEXT),
      'P0001',format('ui_delete_resource_v1 could not find resource qa_ui_projection for id %s',v_own),
      v_api_schema||' delete cannot remove rows outside base_filter');
  END LOOP;
  SET LOCAL ROLE postgres;
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_temp.ui_projection_scope_fixture
    WHERE id=v_own AND detail_name='Own detail'),'blocked mutations preserve the excluded row unchanged');

  -- A base-filter column may also be a patch key: evaluate the original target row.
  v_bad := jsonb_set(v_resource,'{filters}',v_resource->'filters'||
    '[{"key":"detail_name","column":"detail_name","op":"eq"}]'::JSONB);
  v_bad := jsonb_set(v_bad,'{base_filter}','{"key":"detail_name","value":"Own detail"}');
  v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
    THEN v_bad ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only patch-column predicate');
  SET LOCAL ROLE authenticated;
  v_detail := api.ui_update_resource_v1('qa_ui_projection',v_own::TEXT,'{"detail_name":"Allowed update"}');
  RETURN NEXT is(v_detail->>'detail_name','Allowed update','update base_filter uses original target even when the patch key overlaps');
  SET LOCAL ROLE postgres;
  UPDATE pg_temp.ui_projection_scope_fixture SET detail_name='Own detail' WHERE id=v_own;
  v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
    THEN v_resource ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only restore after mutation predicate');

  SET LOCAL ROLE postgres;
  INSERT INTO pg_temp.ui_projection_scope_fixture VALUES
    (gen_random_uuid(),v_org,'Base-filter hidden','Hidden detail',0,v_marker||'-hidden','Hidden quoted'),
    (gen_random_uuid(),v_org,'Base-filter hidden','Hidden detail',0,v_marker||'-hidden','Hidden quoted'),
    (gen_random_uuid(),v_org,'Visible choice','Visible detail',3,v_marker,'Visible quoted');
  v_bad := jsonb_set(v_resource,'{scope_columns}','{"tenant":"organization_id"}');
  v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
    THEN v_bad ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only base-filter control');
  SET LOCAL ROLE authenticated;
  RETURN NEXT is(api.ui_filter_distinct_values_v1('qa_ui_projection','safe_name',NULL,25),
    '["Base-filter hidden","Own row","Visible choice"]'::JSONB,
    'base-filter control rows are within caller scope and otherwise returned');

  SET LOCAL ROLE postgres;
  v_bad := jsonb_set(v_bad,'{base_filter}',jsonb_build_object('rules',jsonb_build_array(
    jsonb_build_object('key','hidden_secret','op','eq','value',v_marker))));
  v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
    THEN v_bad ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only distinct base filter');
  SET LOCAL ROLE authenticated;
  RETURN NEXT is(public.ui_filter_distinct_values_v1('qa_ui_projection','safe_name',NULL,25),
    '["Own row","Visible choice"]'::JSONB,'public distinct excludes hidden rows and keeps visible values');
  RETURN NEXT is(api.ui_filter_distinct_values_v1('qa_ui_projection','safe_name',NULL,25),
    '["Own row","Visible choice"]'::JSONB,'api distinct combines trusted hidden-column base filter and scope_columns');
  RETURN NEXT is(api.ui_filter_distinct_values_v1('qa_ui_projection','safe_name','hidden',25),
    '[]'::JSONB,'distinct query cannot recover a base-filter-hidden value');
  RETURN NEXT is(api.ui_filter_distinct_values_v1('qa_ui_projection','safe_name','Visible',1),
    '["Visible choice"]'::JSONB,'distinct query still returns matching visible values');
  RETURN NEXT is(api.ui_filter_distinct_values_v1('qa_ui_projection','safe_name',NULL,1),
    '["Own row"]'::JSONB,'distinct base filter applies before frequency ordering and limit');
  RETURN NEXT is((api.ui_list_resource_v1('qa_ui_projection','{}',10,0,NULL)->>'total')::INTEGER,2,
    'list uses the same base-filter and scope intersection');
  RETURN NEXT is((api.ui_resource_metrics_v1('qa_ui_projection','{}',NULL)->>'total')::INTEGER,2,
    'metrics uses the same base-filter and scope intersection');
  SET LOCAL ROLE postgres;
  DELETE FROM pg_temp.ui_projection_scope_fixture
    WHERE organization_id=v_org AND safe_name IN ('Base-filter hidden','Visible choice');

  SET LOCAL ROLE postgres;
  v_bad := jsonb_set(v_resource,'{total_strategy}','"estimate"'::JSONB);
  v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
    THEN v_bad ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only estimate inference guard');
  SET LOCAL ROLE authenticated;
  FOR v_bad IN SELECT jsonb_build_object('rules',jsonb_build_array(
    jsonb_build_object('key','hidden_secret','op','ilike','value',prefixes.value)))
    FROM (VALUES ('QA-UI-PROJECTION-SECRET-%'),('wrong-prefix%')) prefixes(value)
  LOOP
    RETURN NEXT throws_ok(format('SELECT api.ui_list_resource_v1(%L,%L::JSONB,10,0,NULL)',
      'qa_ui_projection',v_bad::TEXT),'P0001','ui_read_registry filter column not allowed: hidden_secret',
      'estimated totals reject hidden prefix probes before EXPLAIN');
  END LOOP;
  SET LOCAL ROLE postgres;
  v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
    THEN v_resource ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only restore projection fixture');
  SET LOCAL ROLE authenticated;

  SET LOCAL ROLE postgres;
  v_resource := jsonb_set(v_resource,'{base_filter}',jsonb_build_object('key','hidden_secret','op','eq','value',v_marker));
  v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
    THEN v_resource ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only matching mutation predicate');
  SET LOCAL ROLE authenticated;
  v_detail := api.ui_update_resource_v1('qa_ui_projection',v_own::TEXT,'{"detail_name":"Updated detail"}');
  RETURN NEXT ok(v_detail->>'id'=v_own::TEXT AND v_detail->>'detail_name'='Updated detail'
    AND (SELECT count(*) FROM jsonb_object_keys(v_detail))=4
    AND NOT(v_detail ?| ARRAY['secret','organization_id','internal_sort'])
    AND position(v_marker IN v_detail::TEXT)=0,'update returns the same exact projection with changed detail and identity');
  RETURN NEXT throws_ok(format('SELECT api.ui_update_resource_v1(%L,%L,%L::JSONB)',
    'qa_ui_projection',v_own::TEXT,'{"secret":"overwrite"}'),
    'P0001','ui_update_resource_v1 unknown column secret','projection repair preserves non-editable write validation');

  SET LOCAL ROLE postgres;
  v_resource := jsonb_set(v_resource,'{scope_columns}','{"tenant":"organization_id"}');
  v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
    THEN v_resource ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only scoped projection');
  SET LOCAL ROLE authenticated;
  RETURN NEXT ok(api.ui_get_resource_v1('qa_ui_projection',v_foreign) IS NULL,'configured scope_columns still hide foreign detail');
  v_list := api.ui_list_resource_v1('qa_ui_projection','{}',10,0,NULL);
  RETURN NEXT ok((v_list->>'total')::INTEGER=1 AND v_list#>>'{items,0,id}'=v_own::TEXT,
    'configured scope_columns still restrict list rows and totals');

  v_detail := api.ui_delete_resource_v1('qa_ui_projection',v_own::TEXT);
  RETURN NEXT ok(v_detail->>'id'=v_own::TEXT AND v_detail->>'detail_name'='Updated detail'
    AND (SELECT count(*) FROM jsonb_object_keys(v_detail))=4
    AND NOT(v_detail ?| ARRAY['secret','organization_id','internal_sort'])
    AND position(v_marker IN v_detail::TEXT)=0,'delete returns the same exact projection of the removed row');
  RETURN NEXT ok(api.ui_get_resource_v1('qa_ui_projection',v_own) IS NULL,
    'delete retains its existing mutation semantics');

  -- Test both missing and empty select even with detail columns and identity present.
  FOR v_bad IN SELECT value FROM (VALUES (v_resource-'select'),(jsonb_set(v_resource,'{select}','[]'))) bad(value)
  LOOP
    SET LOCAL ROLE postgres;
    v_registry := jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_ui_projection'
      THEN v_bad ELSE value END) FROM jsonb_array_elements(v_registry->'resources')));
    PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only missing select');
    SET LOCAL ROLE authenticated;
    RETURN NEXT throws_ok(format('SELECT api.ui_get_resource_v1(%L,%L::UUID)','qa_ui_projection',v_own),
      'P0001',NULL,'get fails closed for missing/empty select');
    RETURN NEXT throws_ok('SELECT api.ui_list_resource_v1(''qa_ui_projection'',''{}'',10,0,NULL)',
      'P0001',NULL,'list fails closed for missing/empty select');
    RETURN NEXT throws_ok('SELECT api.ui_resource_metrics_v1(''qa_ui_projection'',''{}'',NULL)',
      'P0001',NULL,'metrics fails closed for missing/empty select');
  END LOOP;
  SET LOCAL ROLE postgres;
END;
$test$;

SELECT * FROM pg_temp.test_ui_read_registry_projection_v1();
SELECT * FROM finish();
ROLLBACK;
