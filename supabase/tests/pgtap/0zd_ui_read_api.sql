-- Test Suite: UI read API registry + RPC presence
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(178);

SELECT has_function('public', 'ui_me_v1', ARRAY[]::text[], 'ui_me_v1 exists');
SELECT has_function('public', 'ui_navigation_v1', ARRAY['text'], 'ui_navigation_v1 exists');
SELECT has_function('public', 'ui_read_registry_v1', ARRAY[]::text[], 'ui_read_registry_v1 exists');
SELECT has_function('public', 'ui_command_registry_v1', ARRAY[]::text[], 'ui_command_registry_v1 exists');
SELECT has_function('public', 'ui_dashboard_config_v1', ARRAY[]::text[], 'ui_dashboard_config_v1 exists');
SELECT has_function('public', 'ui_filter_operators_v1', ARRAY[]::text[], 'ui_filter_operators_v1 exists');
SELECT has_function(
  'public',
  'ui_filter_distinct_values_v1',
  ARRAY['text','text','text','integer'],
  'ui_filter_distinct_values_v1 exists'
);
SELECT has_function(
  'api',
  'ui_filter_distinct_values_v1',
  ARRAY['text','text','text','integer'],
  'api.ui_filter_distinct_values_v1 exists'
);
SELECT has_function('public', 'ui_tracking_registry_v1', ARRAY[]::text[], 'ui_tracking_registry_v1 exists');
SELECT has_function('public', 'ui_list_resource_v1', ARRAY['text','jsonb','integer','integer','jsonb'], 'ui_list_resource_v1 exists');
SELECT has_function('public', 'ui_get_resource_v1', ARRAY['text','uuid'], 'ui_get_resource_v1 exists');
SELECT has_function(
  'public',
  'ui_get_workflow_run_output_status_v1',
  ARRAY['uuid','text[]'],
  'ui_get_workflow_run_output_status_v1 exists'
);
SELECT has_function(
  'api',
  'ui_get_workflow_run_output_status_v1',
  ARRAY['uuid','text[]'],
  'api.ui_get_workflow_run_output_status_v1 exists'
);
SELECT has_function('public', 'ui_get_trace_v1', ARRAY['uuid'], 'ui_get_trace_v1 exists');
SELECT has_function('public', 'ui_table_views_v1', ARRAY['text','text','uuid'], 'ui_table_views_v1 exists');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_navigation'),
  'ui_navigation category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_read_registry'),
  'ui_read_registry category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_command_registry'),
  'ui_command_registry category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_dashboard_config'),
  'ui_dashboard_config category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_filter_operators'),
  'ui_filter_operators category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_tracking_registry'),
  'ui_tracking_registry category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_table_views'),
  'ui_table_views category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'apps'
  ),
  'ui_navigation global defaults seeded'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_dashboard_config'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'max_sections'
  ),
  'ui_dashboard_config global defaults seeded'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_filter_operators'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'operators'
  ),
  'ui_filter_operators global defaults seeded'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_tracking_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resource_key'
  ),
  'ui_tracking_registry global defaults seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value::text LIKE '%/portal/settings/request%'
  ),
  'ui_navigation includes portal settings request'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value::text LIKE '%/portal/access-policy%'
  ),
  'ui_navigation includes portal access policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'shipments'
      )
  ),
  'ui_read_registry includes shipments'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'tasks'
      )
  ),
  'ui_read_registry includes tasks'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'recipients'
      )
  ),
  'ui_read_registry includes recipients'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'addresses'
      )
  ),
  'ui_read_registry includes addresses'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'shipment_actions'
      )
  ),
  'ui_read_registry includes shipment_actions'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'shipment_boxes'
      )
  ),
  'ui_read_registry includes shipment_boxes'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'shipment_reference_numbers'
      )
  ),
  'ui_read_registry includes shipment_reference_numbers'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'zones'
      )
  ),
  'ui_read_registry includes zones'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'webhook_sources'
      )
  ),
  'ui_read_registry includes webhook_sources'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'webhook_response_events'
      )
  ),
  'ui_read_registry excludes webhook_response_events (view is not RLS-safe)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'lookup_values'
      )
  ),
  'ui_read_registry includes lookup_values'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'label_sections'
      )
  ),
  'ui_read_registry includes label_sections'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'domain_events'
      )
  ),
  'ui_read_registry includes domain_events'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'workflow_runs'
      )
  ),
  'ui_read_registry includes workflow_runs'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'schema_registry'
      )
  ),
  'ui_read_registry includes schema_registry'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'workflow_template_steps'
          AND value->'select' = '["id","workflow_template_id","sequence_order","operation_name","operation_settings_category","transition_condition","condition_jsonlogic","next_operation_name","next_operation_priority","next_operation_delay_seconds","manual_action_required","metadata","enabled","created_at","updated_at","handler_key","handler_version"]'::JSONB
      )
  ),
  'ui_read_registry workflow_template_steps declares its exact safe projection'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'labels'
          AND value ? 'download'
          AND value->'download' ? 'path_column'
      )
  ),
  'ui_read_registry labels include download config'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_table_views'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
  ),
  'ui_table_views global defaults seeded'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.ui_me_v1()', 'EXECUTE'),
  'authenticated can execute ui_me_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_navigation_v1(text)', 'EXECUTE'),
  'authenticated can execute ui_navigation_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_read_registry_v1()', 'EXECUTE'),
  'authenticated can execute ui_read_registry_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_command_registry_v1()', 'EXECUTE'),
  'authenticated can execute ui_command_registry_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_dashboard_config_v1()', 'EXECUTE'),
  'authenticated can execute ui_dashboard_config_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_filter_operators_v1()', 'EXECUTE'),
  'authenticated can execute ui_filter_operators_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_filter_distinct_values_v1(text,text,text,integer)',
    'EXECUTE'
  ),
  'authenticated can execute ui_filter_distinct_values_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.ui_filter_distinct_values_v1(text,text,text,integer)',
    'EXECUTE'
  ),
  'authenticated can execute api.ui_filter_distinct_values_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_tracking_registry_v1()', 'EXECUTE'),
  'authenticated can execute ui_tracking_registry_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute ui_list_resource_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_get_resource_v1(text,uuid)', 'EXECUTE'),
  'authenticated can execute ui_get_resource_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_get_workflow_run_output_status_v1(uuid,text[])',
    'EXECUTE'
  ),
  'authenticated can execute ui_get_workflow_run_output_status_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.ui_get_workflow_run_output_status_v1(uuid,text[])',
    'EXECUTE'
  ),
  'authenticated can execute api.ui_get_workflow_run_output_status_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_get_trace_v1(uuid)', 'EXECUTE'),
  'authenticated can execute ui_get_trace_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_table_views_v1(text,text,uuid)', 'EXECUTE'),
  'authenticated can execute ui_table_views_v1'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.ui_me_v1()', 'EXECUTE'),
  'anon cannot execute ui_me_v1'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.ui_get_trace_v1(uuid)', 'EXECUTE'),
  'anon cannot execute ui_get_trace_v1'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_get_workflow_run_output_status_v1(uuid,text[])',
    'EXECUTE'
  ),
  'anon cannot execute ui_get_workflow_run_output_status_v1'
);

-- F267 U5-U6: real ops_admin consumers and the current narrow RPC ACL.
SELECT ok(has_function_privilege(actor, signature, 'EXECUTE') = allowed,
  actor || ' execute boundary ' || signature)
FROM (VALUES
 ('public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'),
 ('api.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'),
 ('public.ui_get_resource_v1(text,uuid)'), ('api.ui_get_resource_v1(text,uuid)'),
 ('public.ui_resource_metrics_v1(text,jsonb,text[])'), ('api.ui_resource_metrics_v1(text,jsonb,text[])'),
 ('public.ui_filter_distinct_values_v1(text,text,text,integer)'),
 ('api.ui_filter_distinct_values_v1(text,text,text,integer)')
) functions(signature)
CROSS JOIN (VALUES ('authenticated',true),('service_role',true),('anon',false)) roles(actor,allowed)
WHERE NOT (actor='authenticated' AND signature IN (
 'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)',
 'public.ui_get_resource_v1(text,uuid)',
 'public.ui_filter_distinct_values_v1(text,text,text,integer)',
 'api.ui_filter_distinct_values_v1(text,text,text,integer)'))
ORDER BY signature,actor;

SELECT ok(has_function_privilege(actor,'public.resolve_settings_merged(text,text,uuid)','EXECUTE')=allowed,
 actor||' generic settings resolver boundary')
FROM (VALUES ('authenticated',false),('anon',false),('service_role',true)) roles(actor,allowed);
-- Pagination is resolved inside the definer list helper, not a separate public pagination RPC.
SELECT ok(NOT has_function_privilege(actor,'public.ui_assert_read_relation_allowed_v1(text,text,text,text)','EXECUTE'),
 actor||' cannot directly invoke private relation guard')
FROM (VALUES ('authenticated'),('anon')) roles(actor);

CREATE FUNCTION pg_temp.f267_ops_admin_reads() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
 org UUID:=gen_random_uuid(); foreign_org UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid();
 providers UUID[]:=ARRAY[gen_random_uuid(),gen_random_uuid()];
 mappings UUID[]:=ARRAY[gen_random_uuid(),gen_random_uuid()];
 operations UUID[]:=ARRAY[gen_random_uuid(),gen_random_uuid()];
 scope_ids UUID[]:=ARRAY[gen_random_uuid(),gen_random_uuid()]; scope_name TEXT;
 orgs UUID[]; i INT; policy JSONB; schema_version INT; result JSONB;
 lookup_id UUID; marker TEXT:='f267-'||gen_random_uuid(); api_schema TEXT;
 lookup_value_id UUID:=gen_random_uuid(); registry JSONB; registry_version INT; original_registry JSONB;
 forbidden_view TEXT:='f267_forbidden_'||replace(gen_random_uuid()::text,'-','');
 resource_key TEXT; resource_id UUID;
BEGIN
 INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
 (org,'F267 owned UI reads','f267-'||org,'active'),
 (foreign_org,'F267 foreign UI reads','f267-'||foreign_org,'active');
 INSERT INTO public.clients(id,organization_id,name,slug,status)
 VALUES(scope_ids[1],org,'F267 compatibility client','f267-'||scope_ids[1],'active');
 INSERT INTO public.senders(id,client_id,name,status)
 VALUES(scope_ids[2],scope_ids[1],'F267 compatibility sender','active');
 INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
 VALUES(actor,org,'f267-'||actor||'@example.test','F267 ops admin','ops_admin','active','tenant',NULL);
 PERFORM public.provision_rbac_roles_from_templates_v1(org,ARRAY['ops_admin'],actor);
 INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
 SELECT org,actor,id,actor,'{"source":"pgtap-f267-ui-read"}' FROM public.rbac_roles
 WHERE organization_id=org AND key='ops_admin';
 SELECT v.value,v.schema_version INTO STRICT policy,schema_version
 FROM public.settings s JOIN public.settings_versions v ON v.id=s.settings_version_id
 WHERE s.category='access_control_policy' AND s.scope_type='global' AND s.scope_id IS NULL;
 policy:=jsonb_set(policy,'{roles}',(SELECT jsonb_agg(
 CASE WHEN r->>'key'='ops_admin' THEN jsonb_set(r,'{capability_keys}','["lookups.read","integrations.read"]')
 ELSE r END ORDER BY ord) FROM jsonb_array_elements(policy->'roles') WITH ORDINALITY entries(r,ord)));
 policy:=jsonb_set(policy,'{assignments}',COALESCE(policy->'assignments','{}')||
 jsonb_build_object('user_id',COALESCE(policy#>'{assignments,user_id}','{}')||
 jsonb_build_object(actor::text,jsonb_build_array('ops_admin'))));
 PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',org,policy,schema_version,'F267 narrow read fixture');
 orgs:=ARRAY[org,foreign_org];
 FOR i IN 1..2 LOOP
 INSERT INTO public.providers(id,organization_id,name,provider_type,enabled)
 VALUES(providers[i],orgs[i],marker||i,'http',true);
 INSERT INTO public.mapping_configs(id,organization_id,mapping_type,mapping_key,mapping_config,mapping_version)
 VALUES(mappings[i],orgs[i],'provider_response',marker||i,'{}',1);
 INSERT INTO public.operation_templates(id,provider_id,operation_name,handler_key,method,url_template,
 headers_template,body_template,request_mappings,mapping_config_id,timeout_seconds,call_type,metadata)
 VALUES(operations[i],providers[i],marker,'outbound_http','POST','https://example.test/f267-ui',
 '{}','{}','{}',mappings[i],30,'provider_api','{}');
 END LOOP;
 SELECT id INTO STRICT lookup_id FROM public.lookup_definitions WHERE category='workflow_transition';
 INSERT INTO public.lookup_values(id,lookup_definition_id,value,label,sort_order,is_default,status)
 VALUES(lookup_value_id,lookup_id,marker,'F267 rollback-only transition',910,FALSE,'active');
 -- This global lookup is capability-governed, not a fabricated tenant-owned lookup.
 SET CONSTRAINTS ALL IMMEDIATE;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 SET LOCAL ROLE authenticated;
 RETURN NEXT ok(current_user='authenticated' AND auth.uid()=actor
   AND public.user_has_capability_v1('lookups.read','tenant',org)
   AND public.user_has_capability_v1('integrations.read','tenant',org)
   AND NOT public.user_has_capability_v1('webhooks.read','tenant',org),
   'ops_admin has selected reads without unrelated webhook authority');
 FOREACH api_schema IN ARRAY ARRAY['public','api'] LOOP
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'providers',jsonb_build_object('name',marker||'%'),50,0,NULL::jsonb;
 RETURN NEXT is((SELECT array_agg(item->>'id' ORDER BY item->>'id') FROM jsonb_array_elements(result->'items') item),
   ARRAY[providers[1]::text],api_schema||' row50 providers list returns own and excludes foreign');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema) INTO result USING 'providers',providers[1];
 RETURN NEXT is(result->>'id',providers[1]::text,api_schema||' row50 own provider detail');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema) INTO result USING 'providers',providers[2];
 RETURN NEXT is(result,NULL::jsonb,api_schema||' row50 foreign provider detail hidden');
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'lookup_values',jsonb_build_object('lookup_definition_id',lookup_id,'value',marker),50,0,NULL::jsonb;
 RETURN NEXT is((SELECT array_agg(item->>'id') FROM jsonb_array_elements(result->'items') item),
   ARRAY[lookup_value_id::text],api_schema||' row50 capable lookup value list');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema) INTO result USING 'lookup_values',lookup_value_id;
 RETURN NEXT is(result->>'id',lookup_value_id::text,api_schema||' row50 capable lookup value detail');

 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'lookup_definitions', '{"category":"workflow_transition"}'::jsonb,50,0,NULL::jsonb;
 RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') item
   WHERE item->>'id'=lookup_id::text AND item->>'category'='workflow_transition'),
   api_schema||' ops_admin reads workflow_transition definition');
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'operation_templates',jsonb_build_object('operation_name',marker),50,0,NULL::jsonb;
 RETURN NEXT is((SELECT array_agg(item->>'id' ORDER BY item->>'id')
   FROM jsonb_array_elements(result->'items') item),ARRAY[operations[1]::text],
   api_schema||' ops_admin reads own operation template and excludes foreign provider template');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema)
 INTO result USING 'operation_templates',operations[1];
 RETURN NEXT is(result->>'id',operations[1]::text,api_schema||' gets own operation template');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema)
 INTO result USING 'operation_templates',operations[2];
 RETURN NEXT is(result,NULL::jsonb,api_schema||' cannot get foreign operation template');
 EXECUTE format('SELECT %I.ui_resource_metrics_v1($1,$2,$3)',api_schema)
 INTO result USING 'operation_templates',jsonb_build_object('operation_name',marker),ARRAY['timeout_seconds'];
 RETURN NEXT ok((result->>'total')::int=1 AND (result#>>'{columns,timeout_seconds,sum}')::int=30,
   api_schema||' metrics count only own operation template');
 EXECUTE format('SELECT %I.ui_filter_distinct_values_v1($1,$2,$3,$4)',api_schema)
 INTO result USING 'operation_templates','provider_id',NULL::text,50;
 RETURN NEXT is(result,jsonb_build_array(providers[1]::text),
   api_schema||' distinct provider values exclude foreign operation template');
 END LOOP;

 -- Retain the original platform branch using the same real actor, not SQL-owner impersonation.
 RESET ROLE;
 FOR i IN 1..2 LOOP
 scope_name:=CASE i WHEN 1 THEN 'client' ELSE 'sender' END;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 UPDATE public.users SET access_scope_type=scope_name,access_scope_id=scope_ids[i] WHERE id=actor;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 SET LOCAL ROLE authenticated;
 result:=api.ui_get_resource_v1('operation_templates',operations[1]);
 RETURN NEXT ok(current_user='authenticated' AND auth.uid()=actor AND result IS NULL,
   scope_name||' cannot bypass the tenant-only provider RLS boundary');
 RETURN NEXT is(api.ui_get_resource_v1('operation_templates',operations[2]),NULL::jsonb,
   scope_name||' excludes foreign organization operation template');
 RESET ROLE;
 END LOOP;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 UPDATE public.users SET access_scope_type='platform',access_scope_id=NULL WHERE id=actor;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 SET LOCAL ROLE authenticated;
 FOREACH api_schema IN ARRAY ARRAY['public','api'] LOOP
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'operation_templates',jsonb_build_object('operation_name',marker),50,0,NULL::jsonb;
 RETURN NEXT is((SELECT count(*)::int FROM jsonb_array_elements(result->'items') item
   WHERE item->>'id'=ANY(ARRAY[operations[1]::text,operations[2]::text])),2,
   api_schema||' platform list retains both provider organizations');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema)
 INTO result USING 'operation_templates',operations[2];
 RETURN NEXT is(result->>'id',operations[2]::text,api_schema||' platform gets foreign organization template');
 EXECUTE format('SELECT %I.ui_resource_metrics_v1($1,$2,$3)',api_schema)
 INTO result USING 'operation_templates',jsonb_build_object('operation_name',marker),ARRAY['timeout_seconds'];
 RETURN NEXT ok((result->>'total')::int=2 AND (result#>>'{columns,timeout_seconds,sum}')::int=60,
   api_schema||' platform metrics retain both organizations');
 EXECUTE format('SELECT %I.ui_filter_distinct_values_v1($1,$2,$3,$4)',api_schema)
 INTO result USING 'operation_templates','operation_name',marker,50;
 RETURN NEXT is(result,jsonb_build_array(marker),api_schema||' platform distinct remains callable');
 END LOOP;
 RESET ROLE;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','service_role')::text,true);
 SET LOCAL ROLE service_role;
 FOREACH api_schema IN ARRAY ARRAY['public','api'] LOOP
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'operation_templates',jsonb_build_object('operation_name',marker),50,0,NULL::jsonb;
 RETURN NEXT is((SELECT count(*)::int FROM jsonb_array_elements(result->'items') item
   WHERE item->>'id'=ANY(ARRAY[operations[1]::text,operations[2]::text])),2,
   api_schema||' JWT service caller retains existing read authority');
 END LOOP;
 RESET ROLE;
 -- Row47: a real registered plain view must fail the relation guard, not auth or missing-resource lookup.
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 UPDATE public.users SET access_scope_type='tenant',access_scope_id=NULL WHERE id=actor;
 EXECUTE format('CREATE VIEW public.%I AS SELECT * FROM public.providers',forbidden_view);
 SELECT v.value,v.schema_version INTO STRICT registry,registry_version
 FROM public.settings s JOIN public.settings_versions v ON v.id=s.settings_version_id
 WHERE s.category='ui_read_registry' AND s.scope_type='global' AND s.scope_id IS NULL;
 original_registry:=registry;
 registry:=jsonb_set(registry,'{resources}',(SELECT jsonb_agg(
   CASE WHEN r->>'key'='providers' THEN jsonb_set(r - 'read_relation','{relation}',to_jsonb('public.'||forbidden_view))
   ELSE r END ORDER BY ord) FROM jsonb_array_elements(registry->'resources') WITH ORDINALITY entries(r,ord)));
 PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,registry,registry_version,
   'F267 rollback-only forbidden relation');
 SET CONSTRAINTS ALL IMMEDIATE;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 SET LOCAL ROLE authenticated;
 RETURN NEXT ok(current_user='authenticated' AND auth.uid()=actor
   AND public.user_has_capability_v1('integrations.read','tenant',org),
   'row47 forbidden relation probe retains real authorized reader');
 FOREACH api_schema IN ARRAY ARRAY['public','api'] LOOP
 RETURN NEXT throws_ok(format('SELECT %I.ui_list_resource_v1(''providers'',''{}'',1,0,NULL)',api_schema),
   'P0001','ui_list_resource_v1 view missing security_invoker: public.'||forbidden_view,
   api_schema||' row47 list rejects registered plain view');
 RETURN NEXT throws_ok(format('SELECT %I.ui_get_resource_v1(''providers'',%L::uuid)',api_schema,providers[1]),
   'P0001','ui_get_resource_v1 relation not allowed: public.'||forbidden_view,
   api_schema||' row47 get rejects registered plain view');
 RETURN NEXT throws_ok(format('SELECT %I.ui_resource_metrics_v1(''providers'',''{}'',NULL)',api_schema),
   'P0001','ui_resource_metrics_v1 relation not allowed: public.'||forbidden_view,
   api_schema||' row47 metrics reject registered plain view');
 RETURN NEXT throws_ok(format('SELECT %I.ui_filter_distinct_values_v1(''providers'',''provider_type'',NULL,1)',api_schema),
   'P0001','ui_filter_distinct_values_v1 relation not allowed: public.'||forbidden_view,
   api_schema||' row47 distinct rejects registered plain view');
 END LOOP;
 RESET ROLE;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 -- Explicit canonical denies preserve the provisioned actor while denying the named read authorities.
 registry:=original_registry;
 PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,registry,registry_version,
   'F267 restore canonical global relation before capability denial');
 PERFORM public.upsert_settings_value_v1('ui_read_registry','tenant',org,registry,registry_version,
   'F267 restore canonical relation before capability denial');
 policy:=jsonb_set(policy,'{denies}',COALESCE(policy->'denies','[]')||jsonb_build_array(
   jsonb_build_object('capability_key','integrations.read','scope_type','tenant','scope_id',org,'reason','F267 rollback-only denial'),
   jsonb_build_object('capability_key','lookups.read','scope_type','tenant','scope_id',org,'reason','F267 rollback-only denial')));
 PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',org,policy,schema_version,
   'F267 named resource denial');
 SET CONSTRAINTS ALL IMMEDIATE;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 SET LOCAL ROLE authenticated;
 FOREACH api_schema IN ARRAY ARRAY['public','api'] LOOP
 FOREACH resource_key IN ARRAY ARRAY['providers','lookup_values','lookup_definitions'] LOOP
 resource_id:=CASE resource_key WHEN 'providers' THEN providers[1]
   WHEN 'lookup_values' THEN lookup_value_id ELSE lookup_id END;
 RETURN NEXT throws_ok(format('SELECT %I.ui_list_resource_v1(%L,''{}'',1,0,NULL)',api_schema,resource_key),
   '42501',NULL,api_schema||' row50 denied actor cannot list '||resource_key);
 RETURN NEXT throws_ok(format('SELECT %I.ui_get_resource_v1(%L,%L::uuid)',api_schema,resource_key,resource_id),
   '42501',NULL,api_schema||' row50 denied actor cannot get '||resource_key);
 END LOOP;
 END LOOP;
 RESET ROLE;
 SET CONSTRAINTS ALL IMMEDIATE;
END;
$test$;
SELECT * FROM pg_temp.f267_ops_admin_reads();

-- F267 row69: browser-facing template and step composition, not direct RLS only.
CREATE FUNCTION pg_temp.f267_client_template_reads() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
 org UUID:=gen_random_uuid(); foreign_org UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid();
 clients UUID[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
 templates UUID[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
 steps UUID[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
 marker TEXT:='f267-row69-'||gen_random_uuid(); role_key TEXT:='qa_f267_'||replace(gen_random_uuid()::text,'-','');
 policy JSONB; schema_version INT; result JSONB; api_schema TEXT; i INT;
BEGIN
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
 (org,'F267 template scope','f267-'||org,'active'),
 (foreign_org,'F267 foreign template scope','f267-'||foreign_org,'active');
 FOR i IN 1..3 LOOP
 INSERT INTO public.clients(id,organization_id,name,slug,status)
 VALUES(clients[i],CASE WHEN i=3 THEN foreign_org ELSE org END,marker||i,'f267-'||clients[i],'active');
 INSERT INTO public.workflow_templates(id,name,version,status,scope_type,scope_id,notes)
 VALUES(templates[i],marker||'-'||i,1,'draft','client',clients[i],'Owned rollback row69 fixture');
 INSERT INTO public.workflow_template_steps(id,workflow_template_id,sequence_order,operation_name,
   operation_settings_category,transition_condition,handler_key,handler_version,enabled,metadata)
 VALUES(steps[i],templates[i],0,'reserve_shipment_identifiers','workflow','always',
   'reserve_shipment_identifiers','v1',true,'{}');
 END LOOP;
 INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
 VALUES(actor,org,'f267-'||actor||'@example.test','F267 client reader','client_admin','active','client',clients[1]);
 PERFORM public.provision_rbac_roles_from_templates_v1(org,ARRAY['client_admin'],actor);
 INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
 SELECT org,actor,id,actor,'{"source":"pgtap-f267-row69"}' FROM public.rbac_roles
 WHERE organization_id=org AND key='client_admin';
 SELECT p.policy,(SELECT version FROM public.schema_registry WHERE category='access_control_policy'
   AND is_active ORDER BY version DESC LIMIT 1) INTO STRICT policy,schema_version
 FROM public.resolve_access_control_policy_v1('client',clients[1],FALSE) p;
 policy:=jsonb_set(policy,'{roles}',(policy->'roles')||jsonb_build_array(
   jsonb_build_object('key',role_key,'capability_keys',jsonb_build_array('workflow_runs.read'))));
 policy:=jsonb_set(policy,'{assignments}',COALESCE(policy->'assignments','{}')||
   jsonb_build_object('user_id',COALESCE(policy#>'{assignments,user_id}','{}')||
     jsonb_build_object(actor::text,jsonb_build_array(role_key))));
 PERFORM public.upsert_settings_value_v1('access_control_policy','client',clients[1],policy,schema_version,'F267 row69 narrow reader');
 SET CONSTRAINTS ALL IMMEDIATE;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
   'organization_id',org,'scope_type','client','scope_id',clients[1])::text,true);
 SET LOCAL ROLE authenticated;
 RETURN NEXT ok(current_user='authenticated' AND auth.uid()=actor
   AND public.current_user_scope_type()='client' AND public.current_user_scope_id()=clients[1]
   AND public.user_has_capability_v1('workflow_runs.read','client',clients[1])
   AND NOT public.user_has_capability_v1('workflow_runs.write','client',clients[1]),
   'row69 actual client reader has read without workflow write authority');
 FOREACH api_schema IN ARRAY ARRAY['public','api'] LOOP
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'workflow_templates',jsonb_build_object('name',marker||'%'),50,0,NULL::jsonb;
 RETURN NEXT is((SELECT array_agg(item->>'id' ORDER BY item->>'id') FROM jsonb_array_elements(result->'items') item),
   ARRAY[templates[1]::text],api_schema||' row69 template list includes own and excludes sibling/foreign');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema) INTO result USING 'workflow_templates',templates[1];
 RETURN NEXT is(result->>'id',templates[1]::text,api_schema||' row69 own template detail');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema) INTO result USING 'workflow_templates',templates[2];
 RETURN NEXT is(result,NULL::jsonb,api_schema||' row69 sibling template detail hidden');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema) INTO result USING 'workflow_templates',templates[3];
 RETURN NEXT is(result,NULL::jsonb,api_schema||' row69 foreign template detail hidden');
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'workflow_template_steps',jsonb_build_object('workflow_template_id',templates[1]),50,0,NULL::jsonb;
 RETURN NEXT is((SELECT array_agg(item->>'id' ORDER BY item->>'id') FROM jsonb_array_elements(result->'items') item),
   ARRAY[steps[1]::text],api_schema||' row69 own template steps visible');
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'workflow_template_steps',jsonb_build_object('workflow_template_id',templates[2]),50,0,NULL::jsonb;
 RETURN NEXT is(result->'items','[]'::jsonb,api_schema||' row69 sibling template steps empty');
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'workflow_template_steps',jsonb_build_object('workflow_template_id',templates[3]),50,0,NULL::jsonb;
 RETURN NEXT is(result->'items','[]'::jsonb,api_schema||' row69 foreign template steps empty');
 EXECUTE format('SELECT %I.ui_resource_metrics_v1($1,$2,$3)',api_schema)
 INTO result USING 'workflow_templates',jsonb_build_object('name',marker||'%'),NULL::text[];
 RETURN NEXT is((result->>'total')::int,1,api_schema||' row69 template metrics exclude sibling/foreign');
 EXECUTE format('SELECT %I.ui_filter_distinct_values_v1($1,$2,$3,$4)',api_schema)
 INTO result USING 'workflow_templates','name',marker,50;
 RETURN NEXT is(result,jsonb_build_array(marker||'-1'),api_schema||' row69 distinct names exclude sibling/foreign');
 FOR i IN 1..3 LOOP
   EXECUTE format('SELECT %I.ui_resource_metrics_v1($1,$2,$3)',api_schema)
   INTO result USING 'workflow_template_steps',jsonb_build_object('workflow_template_id',templates[i]),NULL::text[];
   RETURN NEXT is((result->>'total')::int,CASE WHEN i=1 THEN 1 ELSE 0 END,
     api_schema||' row69 step metrics enforce exact parent '||i);
   EXECUTE format('SELECT %I.ui_filter_distinct_values_v1($1,$2,$3,$4)',api_schema)
   INTO result USING 'workflow_template_steps','workflow_template_id',templates[i]::text,50;
   RETURN NEXT is(result,CASE WHEN i=1 THEN jsonb_build_array(templates[1]::text) ELSE '[]'::jsonb END,
     api_schema||' row69 distinct step parents enforce exact parent '||i);
 END LOOP;
 END LOOP;
 RESET ROLE;
 SET CONSTRAINTS ALL IMMEDIATE;
END;
$test$;
SELECT * FROM pg_temp.f267_client_template_reads();

SELECT finish();

ROLLBACK;
