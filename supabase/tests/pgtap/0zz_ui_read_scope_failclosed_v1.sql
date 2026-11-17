-- Rollback-only: client/sender UI reads fail closed on customer-partitioned data (folds #3412).
BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(38);

SELECT is((SELECT count(*) FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry',
    public.get_root_scope_type_key_v1(), NULL)->'resources') resource
  CROSS JOIN unnest(ARRAY['client','sender']) customer(scope_type)
  WHERE (resource->'scope') IS DISTINCT FROM '"global"'::jsonb
    AND NULLIF(btrim(resource#>>ARRAY['scope_columns', customer.scope_type]), '') IS NULL
    AND public.ui_scope_partition_column_v1(customer.scope_type,
      to_regclass(COALESCE(NULLIF(btrim(resource->>'read_relation'), ''), resource->>'relation'))) IS NOT NULL),
  0::bigint, 'registry integrity: no customer-partitioned resource lacks its client/sender scope column');
SELECT ok(has_function_privilege('ui_rpc_executor','public.ui_scope_partition_column_v1(text,regclass)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.ui_scope_partition_column_v1(text,regclass)','EXECUTE')
  AND NOT has_function_privilege('anon','public.ui_scope_partition_column_v1(text,regclass)','EXECUTE'),
  'partition-column helper is executor-only');

CREATE TEMP TABLE fc_rows(id UUID PRIMARY KEY, organization_id UUID NOT NULL, client_id UUID, sender_id UUID, name TEXT, amount INT);
ALTER TABLE pg_temp.fc_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY fc_rows_scope ON pg_temp.fc_rows FOR SELECT TO authenticated, ui_rpc_executor
  USING (organization_id = public.current_user_org_id());
CREATE TEMP TABLE fc_shared(id UUID PRIMARY KEY, organization_id UUID NOT NULL, name TEXT, amount INT);
ALTER TABLE pg_temp.fc_shared ENABLE ROW LEVEL SECURITY;
CREATE POLICY fc_shared_scope ON pg_temp.fc_shared FOR SELECT TO authenticated, ui_rpc_executor
  USING (organization_id = public.current_user_org_id());
GRANT SELECT ON pg_temp.fc_rows, pg_temp.fc_shared TO authenticated, ui_rpc_executor;
DO $schema$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ui_rpc_executor', pg_my_temp_schema()::regnamespace);
END; $schema$;

SELECT is(public.ui_scope_partition_column_v1('client','pg_temp.fc_rows'::regclass),'client_id','ladder derives client partition column');
SELECT is(public.ui_scope_partition_column_v1('sender','pg_temp.fc_rows'::regclass),'sender_id','ladder derives sender partition column');
SELECT ok(public.ui_scope_partition_column_v1('client','pg_temp.fc_shared'::regclass) IS NULL,'tenant-shared relation has no client partition');

CREATE FUNCTION pg_temp.test_ui_read_scope_failclosed_v1() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  v_org UUID:=gen_random_uuid(); v_other UUID:=gen_random_uuid();
  v_client UUID:=gen_random_uuid(); v_client2 UUID:=gen_random_uuid(); v_sender UUID:=gen_random_uuid();
  v_actor UUID:=gen_random_uuid(); v_platform UUID:=gen_random_uuid();
  r_sender UUID:=gen_random_uuid(); r_client UUID:=gen_random_uuid(); r_client2 UUID:=gen_random_uuid(); r_foreign UUID:=gen_random_uuid();
  s_own UUID:=gen_random_uuid(); s_foreign UUID:=gen_random_uuid();
  v_policy JSONB; v_global_policy JSONB; v_registry JSONB; v_schema INT; v_base JSONB;
  v_role TEXT:='qa_fc_'||replace(gen_random_uuid()::text,'-','');
  v_scope TEXT; v_key TEXT; v_result JSONB; v_ids UUID[];
  v_rows TEXT:=format('%I.fc_rows',pg_my_temp_schema()::regnamespace);
  v_shared TEXT:=format('%I.fc_shared',pg_my_temp_schema()::regnamespace);
BEGIN
  SELECT sv.value,sv.schema_version INTO v_registry,v_schema FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_read_registry'
      AND s.scope_type='global' AND s.scope_id IS NULL;
  v_base:=jsonb_build_object('relation',v_rows,'id_column','id','capability_read','webhooks.read',
    'select',jsonb_build_array('id','name','amount'),
    'filters',jsonb_build_array(jsonb_build_object('key','name','column','name','op','eq')),
    'default_sort',jsonb_build_object('column','name','direction','asc'));
  v_registry:=jsonb_set(v_registry,'{resources}',v_registry->'resources'||jsonb_build_array(
    v_base||jsonb_build_object('key','qa_fc_mapped','scope_columns',
      jsonb_build_object('tenant','organization_id','client','client_id','sender','sender_id')),
    v_base||jsonb_build_object('key','qa_fc_client_only','scope_columns',
      jsonb_build_object('tenant','organization_id','client','client_id')),
    v_base||jsonb_build_object('key','qa_fc_unmapped','scope_columns',jsonb_build_object('tenant','organization_id')),
    v_base||jsonb_build_object('key','qa_fc_shared','relation',v_shared,'scope_columns',jsonb_build_object('tenant','organization_id'))));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only FC resources');
  INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
    (v_org,'FC own','fc-'||v_org,'active'),(v_other,'FC foreign','fc-'||v_other,'active');
  INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES
    (v_client,v_org,'FC client','fc-'||v_client,'active'),(v_client2,v_org,'FC client 2','fc-'||v_client2,'active');
  INSERT INTO public.senders(id,client_id,name,status) VALUES(v_sender,v_client,'FC sender','active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id) VALUES
    (v_actor,v_org,v_actor||'@example.test','FC actor','ops_admin','active','tenant',NULL),
    (v_platform,v_org,v_platform||'@example.test','FC platform','super_admin','active','platform',NULL);
  INSERT INTO pg_temp.fc_rows VALUES
    (r_sender,v_org,v_client,v_sender,'OwnSender',1),(r_client,v_org,v_client,NULL,'OwnClient',2),
    (r_client2,v_org,v_client2,NULL,'OtherClient',4),(r_foreign,v_other,NULL,NULL,'Foreign',8);
  INSERT INTO pg_temp.fc_shared VALUES(s_own,v_org,'SharedOwn',1),(s_foreign,v_other,'SharedForeign',2);

  SELECT policy INTO v_policy FROM public.resolve_access_control_policy_v1('tenant',v_org,FALSE);
  SELECT version INTO v_schema FROM public.schema_registry WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
  v_policy:=jsonb_set(v_policy,'{roles}',v_policy->'roles'||jsonb_build_array(jsonb_build_object(
    'key',v_role,'capability_keys',jsonb_build_array('webhooks.read'))));
  v_policy:=jsonb_set(v_policy,'{assignments}',COALESCE(v_policy->'assignments','{}')||jsonb_build_object(
    'user_id',COALESCE(v_policy#>'{assignments,user_id}','{}')||jsonb_build_object(v_actor::text,jsonb_build_array(v_role))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',v_org,v_policy,v_schema,'Rollback-only FC capability');
  PERFORM public.upsert_settings_value_v1('access_control_policy','client',v_client,v_policy,v_schema,'Rollback-only FC capability');
  PERFORM public.upsert_settings_value_v1('access_control_policy','sender',v_sender,v_policy,v_schema,'Rollback-only FC capability');
  SELECT policy INTO v_global_policy FROM public.resolve_access_control_policy_v1('global',NULL,FALSE);
  v_global_policy:=jsonb_set(v_global_policy,'{roles}',v_global_policy->'roles'||jsonb_build_array(jsonb_build_object(
    'key',v_role,'capability_keys',jsonb_build_array('webhooks.read'))));
  v_global_policy:=jsonb_set(v_global_policy,'{assignments}',COALESCE(v_global_policy->'assignments','{}')||jsonb_build_object(
    'user_id',COALESCE(v_global_policy#>'{assignments,user_id}','{}')||jsonb_build_object(v_platform::text,jsonb_build_array(v_role))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','global',NULL,v_global_policy,v_schema,'Rollback-only FC platform capability');

  DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
  SET CONSTRAINTS ALL IMMEDIATE;

  PERFORM set_config('request.jwt.claim.sub',v_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,TRUE);

  -- Tenant is unaffected: tenant mapping, all four reads.
  SET LOCAL ROLE authenticated;
  FOREACH v_key IN ARRAY ARRAY['qa_fc_mapped','qa_fc_unmapped'] LOOP
    RETURN NEXT is(public.ui_list_resource_v1(v_key,'{}',50,0,NULL)->>'total','3',v_key||' tenant list sees own org');
    RETURN NEXT is(public.ui_get_resource_v1(v_key,r_client2)->>'name','OtherClient',v_key||' tenant get');
    RETURN NEXT is(public.ui_resource_metrics_v1(v_key,'{}',NULL)->>'total','3',v_key||' tenant metrics');
    v_result:=public.ui_filter_distinct_values_v1(v_key,'name',NULL,25);
    RETURN NEXT ok(v_result::text LIKE '%OtherClient%' AND v_result::text NOT LIKE '%Foreign%',v_key||' tenant distinct');
  END LOOP;

  FOREACH v_scope IN ARRAY ARRAY['client','sender'] LOOP
    SET LOCAL ROLE postgres;
    UPDATE public.users SET access_scope_type=v_scope,access_scope_id=CASE WHEN v_scope='client' THEN v_client ELSE v_sender END
     WHERE id=v_actor;
    SET LOCAL ROLE authenticated;

    -- Mapped resource: filtered to the caller's own customer scope.
    v_result:=public.ui_list_resource_v1('qa_fc_mapped','{}',50,0,NULL);
    SELECT array_agg((x->>'id')::uuid ORDER BY x->>'name') INTO v_ids FROM jsonb_array_elements(v_result->'items') x;
    RETURN NEXT is(v_ids,CASE WHEN v_scope='client' THEN ARRAY[r_client,r_sender] ELSE ARRAY[r_sender] END,
      v_scope||' list is filtered by its scope column');
    RETURN NEXT ok(public.ui_get_resource_v1('qa_fc_mapped',r_client2) IS NULL,v_scope||' get excludes another client');
    RETURN NEXT ok(public.ui_get_resource_v1('qa_fc_mapped',r_sender) IS NOT NULL,v_scope||' get returns its own row');
    RETURN NEXT is(public.ui_resource_metrics_v1('qa_fc_mapped','{}',NULL)->>'total',
      CASE WHEN v_scope='client' THEN '2' ELSE '1' END,v_scope||' metrics are filtered');
    v_result:=public.ui_filter_distinct_values_v1('qa_fc_mapped','name',NULL,25);
    RETURN NEXT ok(v_result::text LIKE '%OwnSender%' AND v_result::text NOT LIKE '%OtherClient%'
      AND v_result::text NOT LIKE '%Foreign%',v_scope||' distinct values are filtered');

    -- Customer-partitioned resource without the caller's scope column: 42501 on every read.
    FOREACH v_key IN ARRAY CASE WHEN v_scope='client' THEN ARRAY['qa_fc_unmapped']
        ELSE ARRAY['qa_fc_unmapped','qa_fc_client_only'] END LOOP
      RETURN NEXT throws_ok(format('SELECT public.ui_list_resource_v1(%L,''{}'',50,0,NULL)',v_key),'42501',
        format('ui_read_registry resource %s requires a %s scope column',v_key,v_scope),v_scope||' '||v_key||' list fails closed');
      RETURN NEXT throws_ok(format('SELECT public.ui_get_resource_v1(%L,%L)',v_key,r_client2),'42501',
        format('ui_read_registry resource %s requires a %s scope column',v_key,v_scope),v_scope||' '||v_key||' get fails closed');
      RETURN NEXT throws_ok(format('SELECT public.ui_resource_metrics_v1(%L,''{}'',NULL)',v_key),'42501',
        format('ui_read_registry resource %s requires a %s scope column',v_key,v_scope),v_scope||' '||v_key||' metrics fail closed');
      RETURN NEXT throws_ok(format('SELECT public.ui_filter_distinct_values_v1(%L,''name'',NULL,25)',v_key),'42501',
        format('ui_read_registry resource %s requires a %s scope column',v_key,v_scope),v_scope||' '||v_key||' distinct fails closed');
    END LOOP;

    -- Tenant-shared reference data (no customer partition column) keeps the ladder tenant mapping.
    RETURN NEXT is(public.ui_list_resource_v1('qa_fc_shared','{}',50,0,NULL)->>'total','1',v_scope||' reads tenant-shared rows of its tenant only');
  END LOOP;

  -- Platform remains unaffected.
  SET LOCAL ROLE postgres;
  UPDATE public.users SET access_scope_type='tenant',access_scope_id=NULL WHERE id=v_actor;
  PERFORM set_config('request.jwt.claim.sub',v_platform::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_platform,'role','authenticated')::text,TRUE);
  SET LOCAL ROLE authenticated;
  RETURN NEXT lives_ok('SELECT public.ui_list_resource_v1(''qa_fc_unmapped'',''{}'',50,0,NULL)','platform read is unaffected');
  SET LOCAL ROLE postgres;
END;
$test$;

SELECT * FROM pg_temp.test_ui_read_scope_failclosed_v1();
SELECT * FROM finish();
ROLLBACK;
