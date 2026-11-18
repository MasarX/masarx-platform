BEGIN;
SET search_path TO public,pgtap,extensions,pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);
SELECT ok(NOT has_function_privilege('anon','api.ui_get_task_completion_readback_v1(uuid,uuid)','EXECUTE'),'anonymous API execution is denied');
SELECT ok(has_function_privilege('authenticated','api.ui_get_task_completion_readback_v1(uuid,uuid)','EXECUTE'),'authenticated API wrapper is granted');
SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT throws_ok('SELECT public.ui_get_task_completion_readback_v1(gen_random_uuid(),gen_random_uuid())','42501','Authentication required','missing actor fails closed');

CREATE FUNCTION pg_temp.f546_scope_contract() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
 org UUID; foreign_org UUID; actor UUID:=gen_random_uuid();
 own_task UUID:=gen_random_uuid(); foreign_task UUID:=gen_random_uuid();
 client_one UUID; client_two UUID; sender_one UUID; sender_two UUID;
 denied_actor UUID:=gen_random_uuid(); access_policy JSONB; access_schema INTEGER;
 type_id UUID:=gen_random_uuid(); other_type UUID:=gen_random_uuid();
 prefix TEXT:=COALESCE(NULLIF(current_setting('test.fixture_prefix',true),''),'test');
 foreign_prefix TEXT:=COALESCE(NULLIF(current_setting('test.foreign_fixture_prefix',true),''),'test-foreign');
BEGIN
 SELECT id INTO STRICT org FROM public.organizations WHERE slug=prefix||'-org-alpha' AND name='Test Organization Alpha';
 SELECT id INTO STRICT foreign_org FROM public.organizations WHERE slug=foreign_prefix||'-org-alpha' AND name='Test Organization Alpha';
 SELECT c1.id,c2.id,s1.id,s2.id INTO STRICT client_one,client_two,sender_one,sender_two
 FROM public.clients c1 JOIN public.clients c2 ON c2.organization_id=c1.organization_id
 JOIN public.senders s1 ON s1.client_id=c1.id AND s1.name='Test Client 1 Sender'
 JOIN public.senders s2 ON s2.client_id=c2.id AND s2.name='Test Client 2 Sender'
 WHERE c1.organization_id=org AND c1.slug=prefix||'-client-1-1' AND c2.slug=prefix||'-client-1-2';
 IF org=foreign_org THEN RAISE EXCEPTION 'Distinct owned fixture tenants required'; END IF;
 INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
 VALUES(actor,org,'f546-'||actor||'@example.com','F546 fixture actor','driver','active','tenant');
 PERFORM public.provision_rbac_roles_from_templates_v1(org,ARRAY['driver'],actor);
 INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
 SELECT org,actor,id,actor,'{}'::jsonb FROM public.rbac_roles WHERE organization_id=org AND key='driver' ON CONFLICT DO NOTHING;
 INSERT INTO public.task_types(id,organization_id,key,name,enabled,default_priority,default_queue_key)
 VALUES(type_id,org,'f546_'||type_id,'F546 contract',true,50,'default'),
 (other_type,foreign_org,'f546_'||other_type,'F546 contract',true,50,'default');
 INSERT INTO public.tasks(id,organization_id,task_type_id,status,priority,assigned_to)
 VALUES(own_task,org,type_id,'pending',50,actor),(foreign_task,foreign_org,other_type,'pending',50,NULL);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor,'organization_id',org,'access_scope_type','tenant')::text,true);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT ok(api.ui_get_resource_v1('tasks',own_task) IS NOT NULL,'owned task prerequisite uses existing scoped reader');
 RETURN NEXT ok(api.ui_get_task_completion_readback_v1(own_task,gen_random_uuid()) IS NULL,'missing persisted event remains unverified');
 RETURN NEXT throws_ok(format('SELECT api.ui_get_task_completion_readback_v1(%L::uuid,gen_random_uuid())',foreign_task),'42501','Task not visible','foreign tenant task cannot expose event proof');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.tasks SET client_id=client_two,sender_id=sender_two WHERE id=own_task;
 UPDATE public.users SET access_scope_type='client',access_scope_id=client_one WHERE id=actor;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT throws_ok(format('SELECT api.ui_get_task_completion_readback_v1(%L::uuid,gen_random_uuid())',own_task),'42501','Task not visible','another client task cannot expose readback');
 EXECUTE 'SET LOCAL ROLE postgres';
 UPDATE public.tasks SET client_id=client_one,sender_id=NULL WHERE id=own_task;
 UPDATE public.users SET access_scope_type='sender',access_scope_id=sender_one WHERE id=actor;
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT throws_ok(format('SELECT api.ui_get_task_completion_readback_v1(%L::uuid,gen_random_uuid())',own_task),'42501','Task not visible','sender-null task cannot expose readback to sender actor');
 EXECUTE 'SET LOCAL ROLE postgres';
 INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
 VALUES(denied_actor,org,'f546-denied-'||denied_actor||'@example.com','F546 denied','driver','active','tenant');
 SELECT public.resolve_settings_merged('access_control_policy','tenant',org) INTO access_policy;
 SELECT version INTO STRICT access_schema FROM public.schema_registry WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
 access_policy:=jsonb_set(access_policy,'{assignments}',COALESCE(access_policy->'assignments','{}'::jsonb)||jsonb_build_object('user_id',
 COALESCE(access_policy#>'{assignments,user_id}','{}'::jsonb)||jsonb_build_object(denied_actor::text,'[]'::jsonb)),true);
 PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',org,access_policy,access_schema,'F546 rollback-contained capability-negative actor');
 PERFORM set_config('request.jwt.claim.sub',denied_actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',denied_actor)::text,true);
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT throws_ok(format('SELECT api.ui_get_task_completion_readback_v1(%L::uuid,gen_random_uuid())',own_task),'42501','Capability denied: tasks.read','readback cannot bypass task capability');
 EXECUTE 'SET LOCAL ROLE postgres';
END;
$test$;
SELECT * FROM pg_temp.f546_scope_contract();
SELECT * FROM finish();
ROLLBACK;
