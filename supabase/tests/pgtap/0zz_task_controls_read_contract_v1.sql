BEGIN;
SET search_path TO public,pgtap,extensions,pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(84);

SELECT ok(EXISTS (
 SELECT 1 FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
 WHERE r.ev_class='api.tasks_controls_v1'::regclass
   AND d.refclassid='pg_class'::regclass AND d.refobjid='public.route_stops'::regclass
), 'task planned-time read depends directly on narrow route-stop truth');

SELECT ok(EXISTS (
 SELECT 1 FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
 WHERE r.ev_class='api.tasks_controls_v1'::regclass
   AND d.refclassid='pg_class'::regclass AND d.refobjid='public.route_runs'::regclass
), 'task planned-time read depends directly on narrow route-run truth');

SELECT ok(NOT EXISTS (
 SELECT 1 FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
 WHERE r.ev_class='api.tasks_controls_v1'::regclass
   AND d.refclassid='pg_class'::regclass AND d.refobjid='public.route_stops_visible_v1'::regclass
), 'task planned-time read does not compose the heavyweight route-stop visibility view');

SELECT ok(NOT EXISTS (
 SELECT 1 FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
 WHERE r.ev_class='api.tasks_controls_v1'::regclass
   AND d.refclassid='pg_class'::regclass AND d.refobjid='public.route_runs_visible_v1'::regclass
), 'task planned-time read does not compose the heavyweight route-run visibility view');

SELECT ok(NOT EXISTS (
 SELECT 1 FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
 WHERE r.ev_class='api.tasks_controls_v1'::regclass
   AND d.refclassid='pg_class'::regclass AND d.refobjid='api.route_runs'::regclass
), 'task planned-time read does not compute unrelated route API manifest projections');

CREATE FUNCTION pg_temp.task_controls_contract() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
 org UUID; other_org UUID; actor UUID:=gen_random_uuid(); denied_actor UUID:=gen_random_uuid();
 fixture_prefix TEXT:=COALESCE(NULLIF(current_setting('test.fixture_prefix',true),''),'test');
 foreign_prefix TEXT:=COALESCE(NULLIF(current_setting('test.foreign_fixture_prefix',true),''),'test-foreign');
 client_one UUID; client_two UUID; sender_one UUID; sender_two UUID;
 unscoped_id UUID:=gen_random_uuid();
 prior_timezone TEXT:=current_setting('TimeZone'); zone_offset INTEGER;
 stop_id UUID:=gen_random_uuid(); shipment_id UUID; fallback_resource JSONB;
 access_policy JSONB; access_schema INTEGER;
 type_key TEXT:='controls_'||replace(gen_random_uuid()::text,'-','');
 type_id UUID:=gen_random_uuid(); other_type UUID:=gen_random_uuid();
 own_id UUID:=gen_random_uuid(); second_id UUID:=gen_random_uuid(); foreign_id UUID:=gen_random_uuid();
 branch_id UUID:=gen_random_uuid(); route_id UUID:=gen_random_uuid();
 filters JSONB; listed JSONB; metrics JSONB; registry JSONB; task_resource JSONB;
 filter_sql TEXT; count_plan JSONB; page_plan JSONB; search_ids UUID[];
 second_metadata JSONB; resolver_initplans INTEGER; query_filter_def JSONB;
BEGIN
 -- These exact names/slug relationships are owned by buildFixtureProfile and
 -- ensureIntegrationFixtures, not arbitrary pre-existing customer organizations.
 -- Bootstrap two profiles through the supported helper before this native pack.
 BEGIN
 SELECT o.id,c1.id,c2.id,s1.id,s2.id
 INTO STRICT org,client_one,client_two,sender_one,sender_two
 FROM public.organizations o
 JOIN public.clients c1 ON c1.organization_id=o.id AND c1.slug=fixture_prefix||'-client-1-1'
 JOIN public.clients c2 ON c2.organization_id=o.id AND c2.slug=fixture_prefix||'-client-1-2'
 JOIN public.senders s1 ON s1.client_id=c1.id AND s1.name='Test Client 1 Sender'
 JOIN public.senders s2 ON s2.client_id=c2.id AND s2.name='Test Client 2 Sender'
 WHERE o.slug=fixture_prefix||'-org-alpha' AND o.name='Test Organization Alpha';
 SELECT o.id INTO STRICT other_org FROM public.organizations o
 WHERE o.slug=foreign_prefix||'-org-alpha' AND o.name='Test Organization Alpha'
 AND EXISTS(SELECT 1 FROM public.clients c JOIN public.senders s ON s.client_id=c.id
   WHERE c.organization_id=o.id AND c.slug=foreign_prefix||'-client-1-1'
     AND s.name='Test Client 1 Sender');
 EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
   RAISE EXCEPTION 'F675 requires exact existing integration-fixture profiles % and %; run supported fixture bootstrap first',fixture_prefix,foreign_prefix;
 END;
 IF org=other_org THEN RAISE EXCEPTION 'task-controls requires two distinct owned fixture tenants'; END IF;
 INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
 VALUES(actor,org,'task-controls-'||actor||'@example.com','Task controls driver','driver','active','tenant');
 PERFORM public.provision_rbac_roles_from_templates_v1(org,ARRAY['driver'],actor);
 INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
 SELECT org,actor,r.id,actor,'{}'::jsonb FROM public.rbac_roles r
 WHERE r.organization_id=org AND r.key='driver' ON CONFLICT DO NOTHING;
 INSERT INTO public.task_types(id,organization_id,key,name,enabled,default_priority,default_queue_key)
 VALUES(type_id,org,type_key,'Controls contract',true,50,'default'),
       (other_type,other_org,type_key,'Controls contract',true,50,'default');
 INSERT INTO public.tasks(id,organization_id,task_type_id,status,priority,assigned_to,client_id,sender_id,metadata)
 VALUES(own_id,org,type_id,'pending',50,actor,client_one,sender_one,
   '{"title":"Parcel 100%_ready","customer":{"name":"Alice"},"reference":"CODE-ONE","address":{"city":"Riyadh"},"internal_secret":"not-searchable-token"}'),
 (second_id,org,type_id,'pending',10,NULL,client_two,sender_two,'{"title":"Parcel 100X-ready","customer":{"name":"Alice"},"address":{"city":"Jeddah"}}'),
 (foreign_id,other_org,other_type,'pending',50,NULL,NULL,NULL,'{"title":"Parcel 100%_ready","customer":{"name":"Alice"}}');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor,'organization_id',org,'access_scope_type','tenant')::text,true);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 registry:=public.resolve_settings_merged('ui_read_registry','tenant',org);
 EXECUTE 'SET LOCAL ROLE authenticated';
 SELECT value INTO task_resource FROM jsonb_array_elements(registry->'resources') WHERE value->>'key'='tasks';
 RETURN NEXT is(task_resource->>'relation','public.tasks','task generic-write identity remains the original table');
 RETURN NEXT is(task_resource->>'read_relation','api.tasks_controls_v1','canonical resource uses the scoped read projection');
 RETURN NEXT ok(task_resource->'select' ? 'stop_kind','canonical task registry exposes narrow stop kind');
 RETURN NEXT ok(NOT (task_resource->'select' ? 'metadata'),'task registry does not expose arbitrary metadata');
 RETURN NEXT is((SELECT count(*)::int FROM jsonb_array_elements(registry->'resources') r
   WHERE r->>'key' IN ('tasks_search','tasks_controls')),0,'no alternate task resource key introduced');
 filters:=jsonb_build_object('op','and','rules',jsonb_build_array(
   jsonb_build_object('key','task_type_key','value',type_key),
   jsonb_build_object('key','assigned_to','value','$current_user'),
   jsonb_build_object('key','query','value','Alice')));
 listed:=api.ui_list_resource_v1('tasks',filters,1,0,jsonb_build_object('key','smart_order','direction','asc'));
 metrics:=api.ui_resource_metrics_v1('tasks',filters,ARRAY['urgency_now','urgency_today','urgency_later']);
 RETURN NEXT is((listed->>'total')::int,1,'saved assignment AND query excludes other assignments and tenants');
 RETURN NEXT is((metrics->>'total')::int,(listed->>'total')::int,'list and metrics share the same full criteria');
 RETURN NEXT is((metrics#>>'{columns,urgency_later,sum}')::int,1,'missing planned time remains later');
 RETURN NEXT ok(NOT ((listed#>'{items,0}') ? 'search_text'),'list payload has no computed search haystack');
 RETURN NEXT is((SELECT count(*)::int FROM api.tasks_controls_v1 WHERE organization_id=other_org),0,'direct projection rejects foreign tenant');
 RETURN NEXT ok(own_id=ANY(public.ui_search_task_ids_v1('100%_ready')) AND NOT second_id=ANY(public.ui_search_task_ids_v1('100%_ready')) AND NOT foreign_id=ANY(public.ui_search_task_ids_v1('100%_ready')),'literal percent and underscore do not match another spelling or tenant');
 RETURN NEXT ok(NOT own_id=ANY(public.ui_search_task_ids_v1('not-searchable-token')),'undisplayed arbitrary metadata is not searched');
 RETURN NEXT is((api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key,'query','CODE-ONE'),NULL)->>'total')::int,1,'reference is searchable through canonical metrics');
 RETURN NEXT is((api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key,'query','Riyadh'),NULL)->>'total')::int,1,'displayed place is searchable');
 RETURN NEXT is((api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key,'query',own_id::text),NULL)->>'total')::int,1,'task ID is searchable');
 SELECT value INTO query_filter_def FROM jsonb_array_elements(task_resource->'filters') value
 WHERE value->>'key'='query';
 RETURN NEXT is(query_filter_def,'{"key":"query","column":"id","op":"eq","resolver":"task_text"}'::jsonb,
   'task query uses the exact finite task_text resolver contract before SQL generation');
 filter_sql:=public.ui_filter_tree_sql_v1(
   jsonb_build_object('key','query','value',own_id::text),task_resource->'filters');
 EXECUTE format('EXPLAIN (ANALYZE,VERBOSE,FORMAT JSON) SELECT COUNT(*) FROM api.tasks_controls_v1 WHERE %s',filter_sql)
 INTO count_plan;
 SELECT count(*) INTO resolver_initplans
 FROM jsonb_path_query(count_plan,'strict $.**') AS candidate(node)
 WHERE node->>'Parent Relationship'='InitPlan'
   AND COALESCE((node->>'Actual Loops')::numeric,0)=1
   AND (node->'Output')::text LIKE '%ui_search_task_ids_v1%';
 RETURN NEXT is(resolver_initplans,1,
   'task text count shape executes the exact resolver InitPlan once');
 EXECUTE format('EXPLAIN (ANALYZE,VERBOSE,FORMAT JSON) SELECT id FROM api.tasks_controls_v1 WHERE %s ORDER BY smart_order ASC LIMIT 50 OFFSET 0',filter_sql)
 INTO page_plan;
 SELECT count(*) INTO resolver_initplans
 FROM jsonb_path_query(page_plan,'strict $.**') AS candidate(node)
 WHERE node->>'Parent Relationship'='InitPlan'
   AND COALESCE((node->>'Actual Loops')::numeric,0)=1
   AND (node->'Output')::text LIKE '%ui_search_task_ids_v1%';
 RETURN NEXT is(resolver_initplans,1,
   'task text page shape executes the exact resolver InitPlan once');
 EXECUTE 'SET LOCAL ROLE postgres';
 SELECT metadata INTO second_metadata FROM public.tasks WHERE id=second_id FOR UPDATE;
 UPDATE public.tasks
 SET metadata=jsonb_set(metadata,'{reference}',to_jsonb(own_id::text),true)
 WHERE id=second_id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 listed:=api.ui_list_resource_v1('tasks',jsonb_build_object('op','and','rules',jsonb_build_array(
   jsonb_build_object('key','query','value',own_id::text))),50,0,NULL);
 SELECT array_agg((item->>'id')::uuid ORDER BY item->>'id') INTO search_ids
 FROM jsonb_array_elements(listed->'items') item;
 RETURN NEXT ok((listed->>'total')::int=2 AND cardinality(search_ids)=2
   AND own_id=ANY(search_ids) AND second_id=ANY(search_ids),
   'task query list preserves both the ID match and an allowed reference collision');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.tasks SET metadata=second_metadata WHERE id=second_id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT is(api.ui_get_resource_v1('tasks',own_id)->>'id',own_id::text,'canonical detail identity retained');
 RETURN NEXT ok(api.ui_get_resource_v1('tasks',foreign_id) IS NULL,'detail through definer reader rejects foreign tenant');
 RETURN NEXT ok(NOT (api.ui_get_resource_v1('tasks',own_id) ? 'search_text'),'detail payload has no search haystack');
 listed:=api.ui_list_resource_v1('tasks',jsonb_build_object('task_type_key',type_key,'query','Alice'),1,0,
   jsonb_build_object('key','sort_priority','direction','asc'));
 metrics:=api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key,'query','Alice'),ARRAY['urgency_later']);
 RETURN NEXT is((listed->>'total')::int,2,'one-row page retains exact two-row total');
 RETURN NEXT is((metrics#>>'{columns,urgency_later,sum}')::int,2,'KPI counts full filtered scope rather than page');
 RETURN NEXT is(listed#>>'{items,0,id}',own_id::text,'priority tuple sorts higher priority first');
 listed:=api.ui_list_resource_v1('tasks',jsonb_build_object('task_type_key',type_key,'query','Alice'),1,1,
   jsonb_build_object('key','sort_priority','direction','asc'));
 RETURN NEXT is(listed#>>'{items,0,id}',second_id::text,'next page has stable canonical identity');
 listed:=api.ui_list_resource_v1('tasks',jsonb_build_object('task_type_key',type_key,'query','Alice'),1,0,
   jsonb_build_object('key','sort_priority','direction','asc','group_key','area'));
 RETURN NEXT is(listed#>>'{items,0,id}',second_id::text,'server group ordering precedes priority across the full scope');
 RETURN NEXT ok(api.ui_filter_distinct_values_v1('tasks','urgency','later',25) ? 'later','distinct reader resolves projection columns');
 EXECUTE 'SET LOCAL ROLE postgres';
 INSERT INTO public.branches(id,organization_id,code,name,timezone)
 VALUES(branch_id,org,'controls','Controls branch','UTC');
 INSERT INTO public.route_runs(id,organization_id,branch_id,driver_user_id,status,planned_date,planned_start_at)
 VALUES(route_id,org,branch_id,actor,'planned',CURRENT_DATE,statement_timestamp()+interval '60 minutes');
 UPDATE public.tasks SET resource_type='route_run',resource_id=route_id WHERE id=own_id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT is((SELECT urgency FROM api.tasks_controls_v1 WHERE id=own_id),'now','exact sixty-minute route boundary is now');
 RETURN NEXT is((api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key,'query','Alice'),ARRAY['urgency_now'])#>>'{columns,urgency_now,sum}')::int,1,'KPI uses canonical route planned time');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.tasks SET sla_due_at=statement_timestamp()-interval '1 day',
   metadata=metadata||jsonb_build_object('route_run_id',route_id) WHERE id=second_id;
 UPDATE public.route_runs SET planned_start_at=(CURRENT_DATE+2)::timestamptz WHERE id=route_id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT is((SELECT urgency FROM api.tasks_controls_v1 WHERE id=own_id),'later','future-day route remains later');
 RETURN NEXT ok((SELECT planned_at IS NULL FROM api.tasks_controls_v1 WHERE id=second_id),'SLA and metadata route ID cannot supply planned time');
 RETURN NEXT is((SELECT urgency FROM api.tasks_controls_v1 WHERE id=second_id),'later','overdue SLA alone does not fabricate urgency');

 RETURN NEXT throws_ok(
   $sql$SELECT api.ui_list_resource_v1('tasks','{}'::jsonb,50,0,'{"key":"smart_order","group_key":"metadata;SELECT 1"}'::jsonb)$sql$,
   'P0001','ui_list_resource_v1 unconfigured group column metadata;SELECT 1','unknown group columns fail closed');
 EXECUTE 'SET LOCAL ROLE postgres';
 -- Shift the REAL statement clock to local noon; no fake time or production
 -- clock override. This guarantees +2h is today and outside the now window.
 zone_offset:=extract(hour FROM statement_timestamp() AT TIME ZONE 'UTC')::integer-12;
 PERFORM set_config('TimeZone','Etc/GMT'||CASE WHEN zone_offset>=0 THEN '+' ELSE '-' END||abs(zone_offset)::text,true);
 UPDATE public.route_runs SET planned_start_at=statement_timestamp()+interval '2 hours' WHERE id=route_id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT is((SELECT urgency FROM api.tasks_controls_v1 WHERE id=own_id),'today','two hours from deterministic local noon is today, not now');
 PERFORM set_config('TimeZone',prior_timezone,true);

 -- The supported integration fixture owns a baseline shipment under client-1-1.
 EXECUTE 'SET LOCAL ROLE postgres';
 SELECT id INTO shipment_id FROM public.shipments
 WHERE organization_id=org AND client_id=client_one AND sender_id=sender_one
 ORDER BY created_at DESC,id LIMIT 1;
 IF shipment_id IS NULL THEN RAISE EXCEPTION 'F675 owned baseline shipment prerequisite missing'; END IF;
 INSERT INTO public.route_stops(id,organization_id,route_run_id,client_id,shipment_id,stop_kind,sequence_order,planned_window_start_at)
 VALUES(stop_id,org,route_id,client_one,shipment_id,'delivery',1,statement_timestamp()+interval '30 minutes');
 UPDATE public.tasks SET resource_type='route_stop',resource_id=stop_id WHERE id=own_id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT is((SELECT planned_at FROM api.tasks_controls_v1 WHERE id=own_id),statement_timestamp()+interval '30 minutes','exact owned stop window supplies planned time');
 RETURN NEXT is((SELECT stop_kind FROM api.tasks_controls_v1 WHERE id=own_id),'delivery','authorized route stop exposes its exact delivery kind');
 RETURN NEXT is(api.ui_get_resource_v1('tasks',own_id)->>'stop_kind','delivery','authorized task detail exposes the same route-stop kind');
 RETURN NEXT is((api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key),ARRAY['urgency_now'])#>>'{columns,urgency_now,sum}')::int,1,'stop urgency reaches elevated metrics reader');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.route_stops SET planned_window_start_at=NULL WHERE id=stop_id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT ok((SELECT planned_at IS NULL FROM api.tasks_controls_v1 WHERE id=own_id),'missing stop window does not inherit a different route-run schedule');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.route_stops SET planned_window_start_at=statement_timestamp()+interval '30 minutes' WHERE id=stop_id;
 UPDATE public.route_runs SET driver_user_id=NULL WHERE id=route_id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT ok((SELECT planned_at IS NULL FROM api.tasks_controls_v1 WHERE id=own_id),'unassigned route stop cannot leak planned time through elevated task reader');
 RETURN NEXT ok((SELECT stop_kind IS NULL FROM api.tasks_controls_v1 WHERE id=own_id),'unassigned route stop cannot leak stop kind through elevated task reader');
 RETURN NEXT is((api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key),ARRAY['urgency_now'])#>>'{columns,urgency_now,sum}')::int,0,'hidden stop does not inflate now metrics');
 RETURN NEXT ok(own_id=ANY(public.ui_search_task_ids_v1('CODE-ONE')),'hidden route does not erase otherwise visible canonical task text');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.route_runs SET driver_user_id=actor WHERE id=route_id;
 UPDATE public.tasks SET priority=50,metadata=metadata||'{"reference":"CODE-ONE"}'::jsonb WHERE id=second_id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 listed:=api.ui_list_resource_v1('tasks',jsonb_build_object('task_type_key',type_key,'query','Alice'),1,0,
   '{"key":"sort_priority","direction":"asc"}'::jsonb);
 RETURN NEXT is(listed#>>'{items,0,id}',LEAST(own_id::text,second_id::text),'equal priority and reference use ID tie breaker on first page');
 listed:=api.ui_list_resource_v1('tasks',jsonb_build_object('task_type_key',type_key,'query','Alice'),1,1,
   '{"key":"sort_priority","direction":"asc"}'::jsonb);
 RETURN NEXT is(listed#>>'{items,0,id}',GREATEST(own_id::text,second_id::text),'equal tuple next page has no repeat or omission');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.tasks SET priority=10,metadata=metadata-'reference' WHERE id=second_id;

 EXECUTE 'SET LOCAL ROLE postgres';
 INSERT INTO public.tasks(id,organization_id,task_type_id,status,priority,client_id,metadata)
 VALUES(unscoped_id,org,type_id,'pending',5,client_one,'{"title":"Client-only task"}');
 UPDATE public.users SET access_scope_type='client',access_scope_id=client_one WHERE id=actor;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT is((api.ui_list_resource_v1('tasks',jsonb_build_object('task_type_key',type_key),50,0,NULL)->>'total')::int,2,'client reader excludes another client in the same tenant');
 RETURN NEXT is((api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key),NULL)->>'total')::int,2,'client metrics share caller scope');
 RETURN NEXT ok(api.ui_get_resource_v1('tasks',second_id) IS NULL,'client detail rejects other client');
 RETURN NEXT ok(NOT second_id=ANY(public.ui_search_task_ids_v1('Parcel')),'client search resolver excludes other client');
 RETURN NEXT ok(api.ui_filter_distinct_values_v1('tasks','query',second_id::text,25) = '[]'::jsonb,'client distinct reader excludes other client identity');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.users SET access_scope_type='sender',access_scope_id=sender_one WHERE id=actor;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT is((api.ui_list_resource_v1('tasks',jsonb_build_object('task_type_key',type_key),50,0,NULL)->>'total')::int,1,'sender reader excludes another sender and sender-null client task');
 RETURN NEXT is((api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key),NULL)->>'total')::int,1,'sender metrics share exact sender scope');
 RETURN NEXT ok(api.ui_get_resource_v1('tasks',unscoped_id) IS NULL,'sender detail rejects sender-null task in own client');
 RETURN NEXT ok(NOT second_id=ANY(public.ui_search_task_ids_v1('Parcel')),'sender search resolver excludes another sender');
 RETURN NEXT ok(api.ui_filter_distinct_values_v1('tasks','query',unscoped_id::text,25) = '[]'::jsonb,'sender distinct reader excludes sender-null identity');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.users SET access_scope_type='platform',access_scope_id=NULL WHERE id=actor;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT is((SELECT count(*)::int FROM api.tasks_controls_v1 WHERE id=ANY(ARRAY[own_id,second_id,unscoped_id,foreign_id])),4,'platform projection spans explicitly platform-visible tenants');
 RETURN NEXT is((api.ui_list_resource_v1('tasks',jsonb_build_object('task_type_key',type_key),50,0,NULL)->>'total')::int,4,'platform list retains capability-gated full scope');
 RETURN NEXT is((api.ui_resource_metrics_v1('tasks',jsonb_build_object('task_type_key',type_key),NULL)->>'total')::int,4,'platform metrics retain capability-gated full scope');
 RETURN NEXT is(api.ui_get_resource_v1('tasks',foreign_id)->>'id',foreign_id::text,'platform detail can read explicitly visible foreign tenant');
 RETURN NEXT ok(api.ui_filter_distinct_values_v1('tasks','query',foreign_id::text,25) ? foreign_id::text,'platform distinct reader retains explicit platform scope');
 EXECUTE 'SET LOCAL ROLE postgres';
 -- Tenant scope is carried by organization_id; lookup metadata forbids a scope ID.
 -- current_user_scope_id() resolves the tenant organization from that canonical field.
 UPDATE public.users SET access_scope_type='tenant',access_scope_id=NULL WHERE id=actor;
 -- An actual service-role test principal, not an authenticated permission bypass.
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','service_role','sub',actor)::text,true);
 EXECUTE 'SET LOCAL ROLE service_role';
 RETURN NEXT is((api.ui_list_resource_v1('tasks',jsonb_build_object('task_type_key',type_key),50,0,NULL)->>'total')::int,3,'service generic list retains the actor tenant filter');
 RETURN NEXT is((SELECT count(*)::int FROM api.tasks_controls_v1 WHERE id=ANY(ARRAY[own_id,second_id,unscoped_id,foreign_id])),4,'service canonical projection includes the foreign tenant task');
 RETURN NEXT ok(foreign_id=ANY(public.ui_search_task_ids_v1('Parcel')),'service search with real UID retains cross-tenant scope');
 registry:=public.resolve_settings_merged('ui_read_registry','tenant',org);
 SELECT value INTO fallback_resource FROM jsonb_array_elements(registry->'resources') WHERE value->>'key'='users';
 RETURN NEXT ok(fallback_resource IS NOT NULL AND NULLIF(fallback_resource->>'read_relation','') IS NULL,'unchanged users resource has no projection override');
 RETURN NEXT is((api.ui_list_resource_v1('users',jsonb_build_object('email','%'||actor::text||'%'),50,0,NULL)->>'total')::int,1,'non-task list falls back to original relation');
 RETURN NEXT is(api.ui_get_resource_v1('users',actor)->>'id',actor::text,'non-task detail falls back to original relation');
 RETURN NEXT is((api.ui_resource_metrics_v1('users',jsonb_build_object('email','%'||actor::text||'%'),NULL)->>'total')::int,1,'non-task metrics retain original relation');
 RETURN NEXT ok(api.ui_filter_distinct_values_v1('users','email',actor::text,25) ? ('task-controls-'||actor||'@example.com'),'non-task distinct reader retains original relation');
 RETURN NEXT matches(public.ui_filter_tree_sql_v1('{"key":"identifier","value":"UNCHANGED"}'::jsonb,
   '[{"key":"identifier","column":"id","op":"eq","resolver":"shipment_identifier"}]'::jsonb),
   'ui_search_shipment_identifier_ids_v1','existing shipment identifier resolver remains selected');
 RETURN NEXT throws_ok($sql$SELECT public.ui_filter_tree_sql_v1('{"key":"query","value":["bad"]}'::jsonb,
   '[{"key":"query","column":"id","op":"eq","resolver":"task_text"}]'::jsonb)$sql$,
   'P0001','ui_filter_tree_sql_v1 task text requires a string equality query','non-string task query is rejected');
 RETURN NEXT ok(NOT own_id=ANY(public.ui_search_task_ids_v1($query$' OR TRUE; --$query$)),'hostile query remains literal text');
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 RETURN NEXT throws_ok($sql$SELECT public.ui_search_task_ids_v1('Parcel')$sql$,
   'P0001','ui_search_task_ids_v1 requires authenticated user','ID resolver requires UID even for service caller');
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 EXECUTE 'SET LOCAL ROLE postgres';
 INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
 VALUES(denied_actor,org,'task-controls-denied-'||denied_actor||'@example.com','No task capability','driver','active','tenant');
 SELECT public.resolve_settings_merged('access_control_policy','tenant',org) INTO access_policy;
 SELECT version INTO STRICT access_schema FROM public.schema_registry
 WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
 -- Existing user-id role assignment contract: this owned actor has no roles.
 -- All other principals retain the original policy. The entire fixture rolls back.
 access_policy:=jsonb_set(access_policy,'{assignments}',
   COALESCE(access_policy->'assignments','{}'::jsonb)||jsonb_build_object('user_id',
     COALESCE(access_policy#>'{assignments,user_id}','{}'::jsonb)||jsonb_build_object(denied_actor::text,'[]'::jsonb)),true);
 PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',org,access_policy,access_schema,'F675 rollback-contained capability-negative actor');
 PERFORM set_config('request.jwt.claim.sub',denied_actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',denied_actor)::text,true);
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT is((SELECT count(*)::int FROM api.tasks_controls_v1 WHERE id=ANY(ARRAY[own_id,second_id,unscoped_id])),0,'direct API projection cannot bypass tasks.read capability');
 RETURN NEXT throws_ok(format('SELECT api.ui_get_resource_v1(%L,%L::uuid)','tasks',own_id),
   '42501','Capability denied: tasks.read','user without task capability cannot read detail');
 RETURN NEXT throws_ok($sql$SELECT api.ui_filter_distinct_values_v1('tasks','urgency',NULL,25)$sql$,
   '42501','Capability denied: tasks.read','user without task capability cannot inspect distinct values');
 RETURN NEXT throws_ok($sql$SELECT api.ui_list_resource_v1('tasks','{}'::jsonb,1,0,NULL)$sql$,
   '42501','Capability denied: tasks.read','user without task capability cannot list');
 RETURN NEXT throws_ok($sql$SELECT api.ui_resource_metrics_v1('tasks','{}'::jsonb,NULL)$sql$,
   '42501','Capability denied: tasks.read','user without task capability cannot count');
 RETURN NEXT throws_ok($sql$SELECT public.ui_search_task_ids_v1('Parcel')$sql$,
   '42501','Capability denied: tasks.read','user without task capability cannot search IDs');
END;
$test$;
SELECT * FROM pg_temp.task_controls_contract();
SELECT * FROM finish();
ROLLBACK;
