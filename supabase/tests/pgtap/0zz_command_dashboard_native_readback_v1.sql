-- F31 live projections only. Migration-time count backfill is a separate selection.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SELECT plan(44);
CREATE FUNCTION pg_temp.f31_dashboard() RETURNS SETOF text LANGUAGE plpgsql AS $test$
DECLARE
  org uuid := gen_random_uuid(); foreign_org uuid := gen_random_uuid();
  actor uuid := gen_random_uuid(); denied uuid := gen_random_uuid(); platform_actor uuid := gen_random_uuid();
  client_a uuid := gen_random_uuid(); client_b uuid := gen_random_uuid(); client_f uuid := gen_random_uuid();
  sender_a uuid := gen_random_uuid(); sender_b uuid := gen_random_uuid();
  sender_c uuid := gen_random_uuid(); sender_f uuid := gen_random_uuid();
  shipments uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  attempts uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  clients uuid[]; senders uuid[]; orgs uuid[];
  route_a uuid := gen_random_uuid(); route_f uuid := gen_random_uuid();
  alert_a uuid := gen_random_uuid(); alert_f uuid := gen_random_uuid();
  provider uuid := gen_random_uuid(); foreign_provider uuid := gen_random_uuid(); v_template uuid := gen_random_uuid();
  template_step uuid := gen_random_uuid(); run uuid := gen_random_uuid(); step uuid := gen_random_uuid();
  call_id uuid; policy_value jsonb; policy_schema integer;
  definition uuid := gen_random_uuid(); missing uuid := gen_random_uuid();
  latest uuid := gen_random_uuid(); same_day uuid := gen_random_uuid();
  old_day uuid := gen_random_uuid(); stale uuid := gen_random_uuid(); boundary uuid := gen_random_uuid();
  foreign_rollup uuid := gen_random_uuid(); result jsonb; row_value jsonb; spec record; i integer;
BEGIN
  INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
    (org,'F31 owned','f31-'||org,'active'),(foreign_org,'F31 foreign','f31-'||foreign_org,'active');
  INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES
    (client_a,org,'A','f31-'||client_a,'active'),(client_b,org,'B','f31-'||client_b,'active'),
    (client_f,foreign_org,'F','f31-'||client_f,'active');
  INSERT INTO public.senders(id,client_id,name,status) VALUES
    (sender_a,client_a,'A','active'),(sender_b,client_a,'B','active'),
    (sender_c,client_b,'C','active'),(sender_f,client_f,'F','active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id) VALUES
    (actor,org,'f31-'||actor||'@example.test','F31 operator','ops_admin','active','tenant',NULL),
    (denied,org,'f31-'||denied||'@example.test','F31 unassigned','ops_admin','active','tenant',NULL),
    (platform_actor,org,'f31-'||platform_actor||'@example.test','F31 platform','super_admin','active','platform',NULL);
  PERFORM public.provision_rbac_roles_from_templates_v1(org,ARRAY['ops_admin'],actor);
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
    SELECT org,actor,r.id,actor,'{"source":"pgtap-f31"}'::jsonb FROM public.rbac_roles r
    WHERE r.organization_id=org AND r.key='ops_admin';
  SELECT sv.value,sv.schema_version INTO STRICT policy_value,policy_schema
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='access_control_policy' AND s.scope_type='global' AND s.scope_id IS NULL;
  policy_value:=jsonb_set(policy_value,'{assignments}',COALESCE(policy_value->'assignments','{}') ||
    jsonb_build_object('user_id',COALESCE(policy_value#>'{assignments,user_id}','{}') || jsonb_build_object(denied::text,'[]'::jsonb)));
  -- Grant only the selected registry read requirements to this rollback-only actor;
  -- denied stays explicitly unassigned, and all scope exclusions remain enforced.
  policy_value:=jsonb_set(policy_value,'{roles}',(SELECT jsonb_agg(
    CASE WHEN r->>'key'='ops_admin' THEN jsonb_set(r,'{capability_keys}',
      (SELECT jsonb_agg(capability ORDER BY capability) FROM (
        SELECT DISTINCT jsonb_array_elements_text(COALESCE(r->'capability_keys','[]'::jsonb)
          || '["routes.read","alerts.read","shipments.read","insights.read"]'::jsonb) AS capability
      ) required_reads))
      ELSE r END ORDER BY ordinal)
    FROM jsonb_array_elements(policy_value->'roles') WITH ORDINALITY AS roles(r,ordinal)));
  PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',org,policy_value,policy_schema,'rollback F31 explicitly unassigned actor');
  PERFORM public.upsert_settings_value_v1('access_control_policy','client',client_a,policy_value,policy_schema,'rollback F31 owned client read capabilities');
  PERFORM public.upsert_settings_value_v1('access_control_policy','sender',sender_a,policy_value,policy_schema,'rollback F31 owned sender read capabilities');
  policy_value:=jsonb_set(policy_value,'{assignments}',policy_value->'assignments' ||
    jsonb_build_object('user_id',policy_value#>'{assignments,user_id}' ||
      jsonb_build_object(platform_actor::text,jsonb_build_array('ops_admin'))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','global',NULL,policy_value,policy_schema,'rollback F31 platform read actor');
  INSERT INTO public.route_runs(id,organization_id,status,metadata) VALUES
    (route_a,org,'planned','{"stops":3}'),(route_f,foreign_org,'planned','{"stops":9}');
  INSERT INTO public.ops_alerts(id,organization_id,alert_type,severity,message,acknowledged_at,
    acknowledged_by_user_id,resolved_at,resolved_by_user_id,resolution_notes) VALUES
    (alert_a,org,'f31_test','warning','owned',now(),actor,now(),actor,'owned closeout'),
    (alert_f,foreign_org,'f31_test','warning','foreign',NULL,NULL,NULL,NULL,NULL);
  INSERT INTO public.providers(id,organization_id,name,provider_type,enabled,metadata)
    VALUES(provider,org,'F31 provider','http',TRUE,'{}'),
      (foreign_provider,foreign_org,'F31 foreign provider','http',TRUE,'{}');
  PERFORM set_config('app.workflow_run_id',run::text,TRUE);
  INSERT INTO public.workflow_templates(id,name,description,version,status,scope_type)
    VALUES(v_template,'f31_'||replace(v_template::text,'-',''),'F31 fixture',1,'active','global');
  INSERT INTO public.workflow_template_steps(id,workflow_template_id,sequence_order,operation_name,
    transition_condition,handler_key,handler_version,enabled)
    VALUES(template_step,v_template,1,'workflow_control','always','workflow_control','v1',TRUE);
  INSERT INTO public.workflow_runs(id,workflow_template_id,workflow_template_version,entry_point,workflow_status,context)
    VALUES(run,v_template,1,'test','pending','{}');
  INSERT INTO public.workflow_run_steps(id,workflow_run_id,workflow_template_step_id,sequence_order,
    step_status,operation_name,handler_key,handler_version,max_retries,enqueued_at)
    VALUES(step,run,template_step,1,'pending','workflow_control','workflow_control','v1',1,now());
  PERFORM set_config('app.workflow_run_step_id',step::text,TRUE);
  PERFORM set_config('platform.workflow_engine','1',TRUE);
  PERFORM set_config('platform.workflow_run_step_id',step::text,TRUE);
  clients:=ARRAY[client_a,client_a,client_b,client_f];
  senders:=ARRAY[sender_a,sender_b,sender_c,sender_f]; orgs:=ARRAY[org,org,org,foreign_org];
  FOR i IN 1..4 LOOP
    INSERT INTO public.shipments(id,organization_id,client_id,sender_id,service_type,tracking_number,status)
      VALUES(shipments[i],orgs[i],clients[i],senders[i],'delivery',shipments[i]::text,'pending');
    call_id:=gen_random_uuid();
    INSERT INTO public.outbound_calls(id,shipment_id,call_type,target_type,target_id,method,url,headers,
      body,status,priority,retry_count,max_retries,scheduled_at,context,workflow_run_step_id)
      VALUES(call_id,shipments[i],'comms_whatsapp','provider',CASE WHEN i=4 THEN foreign_provider ELSE provider END,'POST','https://example.test/f31',
        '{}','{}','in_progress_edge',100,0,3,now(),jsonb_build_object('organization_id',orgs[i],'template_id','f31'),step);
    INSERT INTO public.comms_attempts(id,outbound_call_id,provider_id,attempt_number,status,provider_message_id)
      VALUES(attempts[i],call_id,CASE WHEN i=4 THEN foreign_provider ELSE provider END,1,'sent','f31-'||i);
  END LOOP;
  INSERT INTO public.kpi_definitions(id,organization_id,key,name,definition,metadata) VALUES
    (definition,org,'f31_latest','Latest','{"group":"command_center"}','{}'),
    (missing,org,'f31_missing','Missing','{"group":"command_center"}','{}'),
    (gen_random_uuid(),org,'f31_stale','Stale','{"group":"command_center"}','{}'),
    (gen_random_uuid(),org,'f31_boundary','Boundary','{"group":"command_center"}','{}'),
    (gen_random_uuid(),foreign_org,'f31_latest','Foreign','{"group":"command_center"}','{}');
  INSERT INTO public.kpi_rollups_daily(id,organization_id,kpi_key,day,dimensions,value_num,numerator,denominator,updated_at) VALUES
    (old_day,org,'f31_latest',current_date-1,'{}',999,999,1,now()),
    (same_day,org,'f31_latest',current_date,'{"fixture":"older"}',22,22,2,now()-interval '2 hours'),
    (latest,org,'f31_latest',current_date,'{"fixture":"latest"}',33,33,3,now()-interval '1 hour'),
    (stale,org,'f31_stale',current_date,'{}',44,44,4,now()-interval '25 hours'),
    (boundary,org,'f31_boundary',current_date,'{}',55,55,5,now()-interval '24 hours'),
    (foreign_rollup,foreign_org,'f31_latest',current_date,'{}',88,88,8,now());
  PERFORM set_config('request.jwt.claim.sub',actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT count(*)::int FROM public.command_route_runs_dashboard_v1 WHERE id=route_a),1,'owned route exists');
  RETURN NEXT is((SELECT count(*)::int FROM public.command_route_runs_dashboard_v1 WHERE id=route_f),0,'foreign route hidden');
  -- Capabilities do not bypass trusted-only telemetry RLS.
  result:=api.ui_get_resource_v1('ops_alerts',alert_a);
  RETURN NEXT ok(result IS NULL,'tenant cannot read owned trusted-only alert');
  RETURN NEXT ok(api.ui_get_resource_v1('ops_alerts',alert_f) IS NULL,
    'foreign alert hidden through scoped API');
  -- Communications base tables remain service-only; use the registry read contract.
  result:=api.ui_list_resource_v1('comms_attempts','{}'::jsonb,100,0,NULL);
  RETURN NEXT is((SELECT array_agg((x->>'id')::uuid ORDER BY (x->>'id')::uuid)
    FROM jsonb_array_elements(result->'items') x WHERE (x->>'id')::uuid=ANY(attempts)),
    NULL::uuid[],'tenant sees no trusted-only attempts');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') x WHERE (x->>'shipment_id')::uuid=ANY(shipments)),
    'tenant cannot infer owned communications lineage');
  RETURN NEXT is((SELECT count(*)::int FROM jsonb_array_elements(result->'items') x
    WHERE (x->>'id')::uuid=attempts[4]),0,'foreign comms hidden');
  RETURN NEXT is((SELECT count(*)::int FROM public.command_dashboard_kpi_rollup_directory_v1 WHERE id=foreign_rollup::text),0,'foreign KPI hidden');
  SELECT to_jsonb(k) INTO row_value FROM public.command_dashboard_kpi_rollup_directory_v1 k WHERE definition_id=definition;
  RETURN NEXT ok(row_value->>'id'=latest::text AND (row_value->>'value_num')::numeric=33
    AND (row_value->>'numerator')::numeric=33 AND (row_value->>'denominator')::numeric=3,'day then updated_at selects exact rollup');
  RETURN NEXT ok((row_value->>'is_fresh')::boolean AND NOT (row_value->>'is_stale')::boolean
    AND (row_value->>'age_seconds')::bigint=3600,'recent rollup freshness');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.command_dashboard_kpi_rollup_directory_v1 WHERE id=stale::text
    AND NOT is_fresh AND is_stale AND age_seconds=90000),'older rollup stale');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.command_dashboard_kpi_rollup_directory_v1 WHERE id=boundary::text
    AND NOT is_fresh AND is_stale AND age_seconds=86400),'exact 24 hour boundary stale');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.command_dashboard_kpi_rollup_directory_v1 WHERE definition_id=missing
    AND id=missing::text||'::no_rollup' AND NOT has_rollup AND value_num IS NULL AND age_seconds IS NULL
    AND NOT is_fresh AND is_stale),'missing rollup remains explicitly missing and stale');
  FOR spec IN SELECT * FROM (VALUES
    ('route_runs',route_a::text,route_f::text),('ops_alerts',alert_a::text,alert_f::text),
    ('comms_attempts',attempts[1]::text,attempts[4]::text),('kpi_rollup_directory',latest::text,foreign_rollup::text)
  ) v(resource,owned_id,foreign_id) LOOP
    RETURN NEXT ok(public.user_has_resource_capability_v1(spec.resource,'read'),spec.resource||' actual read capability');
    result:=api.ui_list_resource_v1(spec.resource,'{}'::jsonb,100,0,NULL);
    RETURN NEXT is(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') x WHERE x->>'id'=spec.owned_id),
      spec.resource IN ('route_runs','kpi_rollup_directory'),spec.resource||' API retains the owned read boundary');
    RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') x WHERE x->>'id'=spec.foreign_id),spec.resource||' API foreign exclusion');
  END LOOP;
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.users SET access_scope_type='client',access_scope_id=client_a WHERE id=actor;
  EXECUTE 'SET LOCAL ROLE authenticated';
  result:=api.ui_list_resource_v1('comms_attempts','{}'::jsonb,100,0,NULL);
  RETURN NEXT is((SELECT array_agg((x->>'id')::uuid ORDER BY (x->>'id')::uuid)
    FROM jsonb_array_elements(result->'items') x WHERE (x->>'id')::uuid=ANY(attempts)),
    NULL::uuid[],'client cannot read trusted-only attempts');
  RETURN NEXT ok(api.ui_get_resource_v1('ops_alerts',alert_a) IS NULL,'client cannot read trusted-only alert');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.users SET access_scope_type='sender',access_scope_id=sender_a WHERE id=actor;
  EXECUTE 'SET LOCAL ROLE authenticated';
  result:=api.ui_list_resource_v1('comms_attempts','{}'::jsonb,100,0,NULL);
  RETURN NEXT is((SELECT array_agg((x->>'id')::uuid)
    FROM jsonb_array_elements(result->'items') x WHERE (x->>'id')::uuid=ANY(attempts)),NULL::uuid[],'sender cannot read trusted-only attempts');
  RETURN NEXT ok(api.ui_get_resource_v1('ops_alerts',alert_a) IS NULL,'sender cannot read trusted-only alert');
  PERFORM set_config('request.jwt.claim.sub',platform_actor::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',platform_actor,'role','authenticated')::text,TRUE);
  RETURN NEXT ok(public.user_has_resource_capability_v1('ops_alerts','read'),'platform has explicit alert read capability');
  RETURN NEXT ok(public.user_has_resource_capability_v1('comms_attempts','read'),'platform has explicit communications read capability');
  result:=api.ui_get_resource_v1('ops_alerts',alert_a);
  RETURN NEXT ok(result IS NOT NULL AND (result->>'id')::uuid=alert_a
    AND (result->>'acknowledged_by_user_id')::uuid=actor
    AND (result->>'resolved_by_user_id')::uuid=actor AND result->>'resolution_notes'='owned closeout'
    AND (result->>'acknowledged_at')::timestamptz=now()
    AND (result->>'resolved_at')::timestamptz=now()
    AND result->>'source'=result->>'alert_type' AND result->>'alert_type'='f31_test',
    'platform alert closeout projection preserves exact fields');
  RETURN NEXT is(api.ui_get_resource_v1('ops_alerts',alert_f)->>'id',alert_f::text,'platform authority includes the other fixture organization');
  result:=api.ui_list_resource_v1('comms_attempts','{}'::jsonb,100,0,NULL);
  RETURN NEXT is((SELECT array_agg((x->>'id')::uuid ORDER BY (x->>'id')::uuid)
    FROM jsonb_array_elements(result->'items') x WHERE (x->>'id')::uuid=ANY(attempts)),
    (SELECT array_agg(x ORDER BY x) FROM unnest(attempts) x),'platform sees all four fixture attempts');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') x WHERE (x->>'id')::uuid=attempts[1]
    AND (x->>'shipment_id')::uuid=shipments[1] AND (x->>'provider_id')::uuid=provider
    AND x->>'channel'='whatsapp' AND x->>'template'='f31'),'platform communications lineage and aliases');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') x WHERE (x->>'id')::uuid=attempts[4]
    AND (x->>'shipment_id')::uuid=shipments[4] AND (x->>'provider_id')::uuid=foreign_provider),
    'platform foreign-fixture communications lineage remains exact');
  PERFORM set_config('request.jwt.claim.sub',denied::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',denied,'role','authenticated')::text,TRUE);
  FOREACH result IN ARRAY ARRAY['"route_runs"'::jsonb,'"ops_alerts"'::jsonb,'"comms_attempts"'::jsonb,'"kpi_rollup_directory"'::jsonb] LOOP
    RETURN NEXT ok(NOT public.user_has_resource_capability_v1(result#>>'{}','read'),'unassigned actor lacks '||(result#>>'{}'));
    RETURN NEXT throws_ok(format('SELECT api.ui_list_resource_v1(%L,''{}''::jsonb,100,0,NULL)',result#>>'{}'),
      '42501',NULL,'unassigned actor cannot read '||(result#>>'{}'));
  END LOOP;
  EXECUTE 'SET LOCAL ROLE postgres';
END;
$test$;
SELECT * FROM pg_temp.f31_dashboard();
SELECT * FROM finish();
ROLLBACK;
