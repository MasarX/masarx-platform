BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SELECT plan(17);
SELECT has_function('public','prevent_stale_settlement_task_completion_v1',ARRAY[]::text[],'settlement task guard exists');
SELECT has_trigger('public','tasks','tasks_prevent_stale_settlement_task_completion','canonical task transitions invoke the guard');
SELECT ok(NOT has_function_privilege('authenticated','public.prevent_stale_settlement_task_completion_v1()','EXECUTE'),
  'trigger helper is not an authenticated RPC');

CREATE FUNCTION pg_temp.lineage_settlement_task_cases() RETURNS SETOF text
LANGUAGE plpgsql AS $test$
DECLARE
  org uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid(); branch uuid:=gen_random_uuid();
  cashier uuid:=gen_random_uuid(); manager uuid:=gen_random_uuid(); override_type uuid:=gen_random_uuid();
  open_batch uuid; locked_batch uuid; approved_batch uuid;
  stale uuid:=gen_random_uuid(); valid uuid:=gen_random_uuid(); cancel_task uuid:=gen_random_uuid();
  manager_open uuid:=gen_random_uuid(); manager_locked uuid:=gen_random_uuid(); manager_approved uuid:=gen_random_uuid();
  override_task uuid:=gen_random_uuid(); malformed_task uuid:=gen_random_uuid();
  session_id uuid; payload jsonb; base jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations(id,name,slug) VALUES(org,'Lineage task windows','lineage-task-'||left(org::text,8));
  INSERT INTO public.branches(id,organization_id,code,name,is_active) VALUES(branch,org,'lineage-'||left(branch::text,8),'Lineage branch',TRUE);
  INSERT INTO public.users(id,organization_id,email,full_name,access_scope_type) VALUES
    (actor,org,'lineage-task-'||left(actor::text,8)||'@example.com','Settlement operator','tenant');
  PERFORM public.provision_rbac_roles_from_templates_v1(org,ARRAY['ops_admin'],actor);
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
  SELECT org,actor,r.id,actor,'{"source":"lineage_pgtap"}'::jsonb FROM public.rbac_roles r WHERE r.organization_id=org AND r.key='ops_admin';
  -- These are real canonical keys created after migration: empty metadata proves lazy-type defaults.
  INSERT INTO public.task_types(id,organization_id,key,name,metadata) VALUES
    (cashier,org,'cod_cashier_count','COD cashier count','{}'),
    (manager,org,'cod_manager_approval','COD manager approval','{}'),
    (override_type,org,'bank_deposit_slip_create','Deposit slip','{"settlement_batch_action_statuses":["locked"]}');
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',TRUE);
  base:=jsonb_build_object('organization_id',org,'branch_id',branch,'kind','cod','scope_type','driver_shift',
    'subject_type','user','subject_id',actor,'window_start_at',now()-interval '8 hours','window_end_at',now(),'actor_system','lineage_pgtap');
  SELECT settlement_batch_id INTO STRICT open_batch FROM public.create_settlement_batch_v1(base||'{"idempotency_key":"lineage-open"}');
  SELECT settlement_batch_id INTO STRICT locked_batch FROM public.create_settlement_batch_v1(base||'{"idempotency_key":"lineage-locked"}');
  SELECT settlement_batch_id INTO STRICT approved_batch FROM public.create_settlement_batch_v1(base||'{"idempotency_key":"lineage-approved"}');
  PERFORM public.transition_settlement_batch_v1(jsonb_build_object('settlement_batch_id',locked_batch,'to_status','locked','actor_system','lineage_pgtap'));
  PERFORM public.transition_settlement_batch_v1(jsonb_build_object('settlement_batch_id',approved_batch,'to_status','locked','actor_system','lineage_pgtap'));
  PERFORM public.transition_settlement_batch_v1(jsonb_build_object('settlement_batch_id',approved_batch,'to_status','approved','actor_system','lineage_pgtap'));
  INSERT INTO public.tasks(id,organization_id,task_type_id,resource_type,resource_id,status,priority) VALUES
    (stale,org,cashier,'settlement_batch',approved_batch,'open',50),
    (valid,org,cashier,'settlement_batch',open_batch,'open',50),
    (cancel_task,org,cashier,'settlement_batch',approved_batch,'open',50),
    (manager_open,org,manager,'settlement_batch',open_batch,'open',50),
    (manager_locked,org,manager,'settlement_batch',locked_batch,'open',50),
    (manager_approved,org,manager,'settlement_batch',approved_batch,'open',50),
    (override_task,org,override_type,'settlement_batch',locked_batch,'open',50),
    (malformed_task,org,override_type,'settlement_batch',locked_batch,'open',50);
  PERFORM set_config('request.jwt.claim.sub',actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT ops_session_id INTO STRICT session_id FROM public.open_ops_session_v1(jsonb_build_object(
    'session_type','branch_cash_drawer','branch_id',branch,'idempotency_key','lineage-task-session'));
  payload:=jsonb_build_object('ops_session_id',session_id,'amount',10,'currency','SAR');
  RETURN NEXT ok(public.user_has_permission_v1('tasks.complete',org),'fixture uses a permitted real tenant operator');
  RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,%L,NULL,%L::jsonb,%L)',stale,'completed',payload,'lineage-stale'),
    '23514',NULL,'canonical RPC rejects cashier completion after batch approval');
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id=stale),'open','rejected completion keeps the task open');
  RETURN NEXT is((SELECT count(*)::integer FROM public.task_events WHERE task_id=stale),0,'rejected completion writes no task event');
  RETURN NEXT lives_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,%L,NULL,%L::jsonb,%L)',valid,'completed',payload,'lineage-valid'),
    'canonical RPC permits cashier completion on an open batch without lookup metadata');
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id=valid),'completed','allowed canonical completion persists');
  RETURN NEXT lives_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,%L,NULL,%L::jsonb,%L)',cancel_task,'canceled','{}','lineage-cancel'),
    'canonical stale-task cancellation stays available');
  RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,%L,NULL,%L::jsonb,%L)',manager_open,'completed',payload,'lineage-manager-open'),
    '23514',NULL,'manager completion is rejected before batch lock');
  RETURN NEXT lives_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,%L,NULL,%L::jsonb,%L)',manager_locked,'completed',payload,'lineage-manager-locked'),
    'manager completion succeeds on a locked batch');
  RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,%L,NULL,%L::jsonb,%L)',manager_approved,'completed',payload,'lineage-manager-approved'),
    '23514',NULL,'manager completion is rejected after approval');
  RETURN NEXT lives_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,%L,NULL,%L::jsonb,%L)',override_task,'completed',payload,'lineage-override'),
    'an explicit task-type action window overrides the key default');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.task_types SET metadata='{"settlement_batch_action_statuses":"locked"}' WHERE id=override_type;
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,%L,NULL,%L::jsonb,%L)',malformed_task,'completed',payload,'lineage-malformed'),
    '23514','Invalid settlement task action window','malformed explicit policy fails closed without a lookup dependency');
  RETURN NEXT lives_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,%L,NULL,%L::jsonb,%L)',stale,'open','{}','lineage-still-open'),
    'a canonical non-completion same-status action stays available');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT metadata->'settlement_batch_action_statuses' FROM public.task_types WHERE id=cashier),
    NULL::jsonb,'late-created task type exercised the key fallback without hidden fixture policy');
END;
$test$;
SELECT * FROM pg_temp.lineage_settlement_task_cases();
SELECT * FROM finish();
ROLLBACK;
