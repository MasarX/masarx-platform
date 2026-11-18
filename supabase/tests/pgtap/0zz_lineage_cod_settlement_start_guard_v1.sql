BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SELECT plan(38);
SELECT has_function('public','assert_cod_settlement_start_allowed_v1',ARRAY['uuid','jsonb'],'COD business-identity guard exists');
SELECT has_trigger('public','workflow_runs','workflow_runs_cod_settlement_start_guard','all real workflow starts invoke the guard');
SELECT ok(NOT has_function_privilege('authenticated','public.assert_cod_settlement_start_allowed_v1(uuid,jsonb)','EXECUTE'),
  'business guard is not an authenticated lookup oracle');

CREATE FUNCTION pg_temp.lineage_cod_start_cases() RETURNS SETOF text
LANGUAGE plpgsql AS $test$
DECLARE
  org uuid:=gen_random_uuid(); foreign_org uuid:=gen_random_uuid(); branch uuid:=gen_random_uuid(); second_branch uuid:=gen_random_uuid();
  client uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid(); client_actor uuid:=gen_random_uuid(); tenant_no_finance uuid:=gen_random_uuid();
  driver uuid:=gen_random_uuid(); other_driver uuid:=gen_random_uuid();
  template uuid; clone uuid; first_run uuid; ui_run uuid; retry_run uuid; terminal_run uuid; batch uuid;
  result jsonb; progress jsonb; input jsonb; normalized jsonb; window_start timestamptz:=now()-interval '8 hours'; window_end timestamptz:=now();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations(id,name,slug) VALUES
    (org,'Lineage COD start','lineage-cod-'||left(org::text,8)),
    (foreign_org,'Foreign COD start','lineage-cod-foreign-'||left(foreign_org::text,8));
  INSERT INTO public.branches(id,organization_id,code,name,is_active) VALUES
    (branch,org,'lineage-'||left(branch::text,8),'COD branch',TRUE),
    (second_branch,org,'lineage-'||left(second_branch::text,8),'Other COD branch',TRUE);
  INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES
    (client,org,'COD operator client','lineage-cod-client-'||left(client::text,8),'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type,access_scope_id) VALUES
    (client_actor,org,'lineage-cod-client-'||left(client_actor::text,8)||'@example.com','Client workflow operator','client_admin','client',client);
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type) VALUES
    (actor,org,'lineage-cod-finance-'||left(actor::text,8)||'@example.com','Tenant finance operator','ops_admin','tenant'),
    (tenant_no_finance,org,'lineage-cod-no-finance-'||left(tenant_no_finance::text,8)||'@example.com','Tenant without finance permission','ops_admin','tenant');
  PERFORM public.provision_rbac_roles_from_templates_v1(org,ARRAY['finance'],actor);
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
  SELECT org,actor,r.id,actor,'{"source":"lineage_cod_authorization_pgtap"}'::jsonb
  FROM public.rbac_roles r WHERE r.organization_id=org AND r.key='finance';
  INSERT INTO public.users(id,organization_id,email,full_name,access_scope_type) VALUES
    (driver,org,'lineage-driver-'||left(driver::text,8)||'@example.com','COD driver','tenant'),
    (other_driver,org,'lineage-driver-'||left(other_driver::text,8)||'@example.com','Other COD driver','tenant');
  SELECT id INTO STRICT template FROM public.workflow_templates WHERE name='cod_driver_shift_settlement_v2';
  clone:=public.clone_workflow_template_service_v1(template,'client',client,'lineage_cod_clone_'||left(client::text,8),'{}');
  input:=jsonb_build_object('organization_id',org,'kind','cod','scope_type','driver_shift',
    'branch_id',branch,'subject_type','driver','subject_id',driver,
    'window_start_at',window_start,'window_end_at',window_end);
  PERFORM set_config('request.jwt.claim.sub',client_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',client_actor,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(NOT public.user_has_permission_v1('finance.write',org)
    AND public.current_user_scope_type()='client','client_admin fixture lacks finance.write and has client scope');
  RETURN NEXT lives_ok($$SELECT public.assert_capability_v1('workflow_runs.write')$$,
    'client_admin has the workflow capability that previously exposed the financial writer');
  RETURN NEXT throws_ok(format('SELECT public.ui_start_workflow_run_v1(%L::uuid,%L::jsonb,TRUE)',template,input),
    '42501','COD settlement browser starts require tenant scope and finance.write',
    'client_admin cannot pre-start a driver window through the real browser RPC');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT count(*)::integer FROM public.workflow_runs WHERE workflow_template_id=template
    AND COALESCE(context->>'organization_id',context#>>'{payload,organization_id}')=org::text),
    0,'denied browser start persists no workflow reservation');
  RETURN NEXT is((SELECT count(*)::integer FROM public.settlement_batches WHERE organization_id=org),
    0,'denied browser start creates no financial batch');
  PERFORM set_config('request.jwt.claim.sub',tenant_no_finance::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',tenant_no_finance,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.current_user_scope_type()='tenant' AND NOT public.user_has_permission_v1('finance.write',org),
    'tenant-only fixture has no finance.write assignment');
  RETURN NEXT throws_ok(format('SELECT public.ui_start_workflow_run_v1(%L::uuid,%L::jsonb,TRUE)',template,input),
    '42501','COD settlement browser starts require tenant scope and finance.write','tenant scope alone cannot start financial work');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';
  first_run:=public.start_workflow_run(template,input);
  RETURN NEXT ok(first_run IS NOT NULL,'denied browser starts do not block the later real system start of that same window');
  RETURN NEXT ok((SELECT context->>'subject_id'=driver::text AND context->>'scope_type'='driver_shift'
    FROM public.workflow_runs WHERE id=first_run),'flat start persists actual driver-shift keys');
  RETURN NEXT throws_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,input),
    '23505','COD settlement workflow already exists for this driver-shift window','a second flat start cannot bypass business deduplication');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.current_user_scope_type()='tenant' AND public.user_has_permission_v1('finance.write',org),
    'allowed browser actor is tenant-scoped with a real finance.write role assignment');
  RETURN NEXT throws_ok(format('SELECT public.ui_start_workflow_run_v1(%L::uuid,%L::jsonb,TRUE)',template,input),
    '23505','COD settlement workflow already exists for this driver-shift window','real wrapped browser start collides with the flat system start');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT count(*)::integer FROM public.workflow_runs WHERE workflow_template_id=template
    AND context->>'subject_id'=driver::text),1,'duplicate starts leave a single persisted workflow');
  UPDATE public.workflow_runs SET workflow_status='continue' WHERE id=first_run;
  RETURN NEXT throws_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,input),
    '23505','COD settlement workflow already exists for this driver-shift window','continue is an active carrier status');
  PERFORM public.workflow_mark_run_stopped(first_run,'pgtap opt-out');
  EXECUTE 'SET LOCAL ROLE authenticated';
  result:=public.ui_start_workflow_run_v1(template,input,TRUE);ui_run:=(result->>'workflow_run_id')::uuid;
  RETURN NEXT ok(ui_run IS NOT NULL AND ui_run<>first_run,'stopped permits a fresh real browser start');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',clone,input),
    '23505','COD settlement workflow already exists for this driver-shift window','a real scoped clone shares the driver-shift business identity');
  progress:=public.progress_workflow_run(ui_run);
  SELECT NULLIF(context->>'settlement_batch_id','')::uuid INTO batch FROM public.workflow_runs WHERE id=ui_run;
  RETURN NEXT ok(batch IS NOT NULL AND EXISTS(SELECT 1 FROM public.settlement_batches WHERE id=batch
    AND organization_id=org AND scope_type='driver_shift' AND subject_id=driver
    AND window_start_at=window_start AND window_end_at=window_end),
    'the real wrapped start reaches the carrier batch-create handler with flat settlement inputs');
  PERFORM public.workflow_mark_run_stopped(ui_run,'pgtap batch restart probe');
  RETURN NEXT throws_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,input),
    '23505','COD settlement already exists for this driver-shift window','an existing open batch prevents duplicate work even after the run stops');
  PERFORM public.transition_settlement_batch_v1(jsonb_build_object('settlement_batch_id',batch,'to_status','canceled','actor_system','lineage_pgtap'));
  retry_run:=public.start_workflow_run(template,input);
  RETURN NEXT ok(retry_run IS NOT NULL AND retry_run<>ui_run,'canonical canceled batch allows a new start');
  normalized:=input||jsonb_build_object('subject_type','user','subject_id',upper(driver::text),
    'window_start_at',to_char(window_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00',
    'window_end_at',to_char(window_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00');
  RETURN NEXT throws_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,normalized),
    '23505','COD settlement workflow already exists for this driver-shift window','UUID case timestamp rendering and user/driver aliases cannot evade the same window');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.workflow_runs SET workflow_status='in_progress' WHERE id=retry_run;
  RETURN NEXT throws_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,input),
    '23505','COD settlement workflow already exists for this driver-shift window','in_progress remains active');
  UPDATE public.workflow_runs SET workflow_status='completed' WHERE id=retry_run;
  terminal_run:=public.start_workflow_run(template,input);
  RETURN NEXT ok(terminal_run IS NOT NULL AND terminal_run<>retry_run,'completed without a blocking batch permits restart');
  UPDATE public.workflow_runs SET workflow_status='failed' WHERE id=terminal_run;
  retry_run:=public.start_workflow_run(template,input);
  RETURN NEXT ok(retry_run IS NOT NULL AND retry_run<>terminal_run,'failed without a blocking batch permits restart');
  UPDATE public.workflow_runs SET workflow_status='cancelled' WHERE id=retry_run;
  terminal_run:=public.start_workflow_run(template,input);
  RETURN NEXT ok(terminal_run IS NOT NULL AND terminal_run<>retry_run,'carrier cancelled without a blocking batch permits restart');
  RETURN NEXT lives_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,
    input||jsonb_build_object('window_start_at',window_start+interval '1 day','window_end_at',window_end+interval '1 day')),
    'a distinct driver-shift window remains independent');
  RETURN NEXT lives_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,
    input||jsonb_build_object('subject_id',other_driver)),'a distinct driver remains independent');
  RETURN NEXT lives_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,
    input||jsonb_build_object('branch_id',second_branch)),'a distinct settlement branch remains independent');
  RETURN NEXT throws_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,input||'{"subject_id":"not-a-uuid"}'),
    '22023','COD driver-shift start requires a valid organization, subject and time window','invalid production identity is rejected');
  RETURN NEXT throws_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,input-'window_end_at'),
    '22023','COD driver-shift start requires a valid organization, subject and time window','missing window cannot silently bypass the guard');
  PERFORM set_config('request.jwt.claim.sub',actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,TRUE);
  RETURN NEXT throws_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,input||jsonb_build_object('organization_id',foreign_org)),
    '42501','COD settlement organization is outside caller scope','a foreign-organization identity is denied before any business lookup');
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT public.ui_start_workflow_run_v1(%L::uuid,%L::jsonb,TRUE)',template,input||jsonb_build_object('organization_id',foreign_org)),
    '22023','COD driver-shift start requires a valid organization, subject and time window','wrapped payload cannot contradict its authenticated outer organization');
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
  SELECT org,client_actor,r.id,actor,'{"source":"lineage_cod_scope_pgtap"}'::jsonb
  FROM public.rbac_roles r WHERE r.organization_id=org AND r.key='finance';
  PERFORM set_config('request.jwt.claim.sub',client_actor::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',client_actor,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.user_has_permission_v1('finance.write',org) AND public.current_user_scope_type()='client',
    'finance.write by itself does not widen a client actor to tenant scope');
  RETURN NEXT throws_ok(format('SELECT public.ui_start_workflow_run_v1(%L::uuid,%L::jsonb,TRUE)',template,input),
    '42501','COD settlement browser starts require tenant scope and finance.write',
    'client scope stays denied before duplicate discovery even with finance.write');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',client_actor,'role','service_role')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT lives_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,
    input||jsonb_build_object('window_start_at',window_start+interval '2 days','window_end_at',window_end+interval '2 days')),
    'trusted service-role starts retain their existing path even with an end-user subject');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
  PERFORM set_config('request.jwt.claim.role','',TRUE);
  PERFORM set_config('request.jwt.claims','{}',TRUE);
  RETURN NEXT lives_ok(format('SELECT public.start_workflow_run(%L::uuid,%L::jsonb)',template,
    input||jsonb_build_object('window_start_at',window_start+interval '3 days','window_end_at',window_end+interval '3 days')),
    'trusted flat database-system starts keep their existing no-user path');
END;
$test$;
SELECT * FROM pg_temp.lineage_cod_start_cases();
SELECT * FROM finish();
ROLLBACK;
