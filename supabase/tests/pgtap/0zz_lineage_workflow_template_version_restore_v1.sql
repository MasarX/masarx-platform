BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(27);
SELECT has_function('public','workflow_template_version_diff_v1',ARRAY['jsonb'],'canonical template diff exists');
SELECT has_function('public','restore_workflow_template_v1',ARRAY['jsonb'],'canonical template restore exists');
SELECT has_function('api','workflow_template_version_diff_v1',ARRAY['jsonb'],'API template diff exists');
SELECT has_function('api','restore_workflow_template_v1',ARRAY['jsonb'],'API template restore exists');
SELECT ok(NOT has_function_privilege('anon','public.restore_workflow_template_v1(jsonb)','EXECUTE')
  AND NOT has_function_privilege('anon','api.workflow_template_version_diff_v1(jsonb)','EXECUTE'),
  'anonymous execution is revoked on both schemas');
SELECT has_trigger('public','workflow_runs','workflow_runs_lock_restored_template_v1','starts serialize with restore');

CREATE FUNCTION pg_temp.lineage_template_version_behavior_v1() RETURNS SETOF text
LANGUAGE plpgsql AS $test$
DECLARE
  v_org uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_foreign_client uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_denied uuid := gen_random_uuid();
  v_source uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_foreign uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_stale_run uuid := gen_random_uuid();
  v_old_step uuid;
  v_stopped_run uuid;
  v_prior_version integer;
  v_seed public.workflow_template_steps%ROWTYPE;
  v_args jsonb;
  v_diff jsonb;
  v_result jsonb;
  v_checksum text;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations(id,name,slug) VALUES
    (v_org,'Lineage workflow versions','lineage-workflow-'||left(v_org::text,8));
  INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES
    (v_client,v_org,'Workflow client','lineage-workflow-client-'||left(v_client::text,8),'active'),
    (v_foreign_client,v_org,'Foreign workflow client','lineage-workflow-foreign-'||left(v_foreign_client::text,8),'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type,access_scope_id) VALUES
    (v_actor,v_org,'lineage-workflow-'||left(v_actor::text,8)||'@example.com','Workflow editor','client_admin','client',v_client),
    (v_denied,v_org,'lineage-denied-'||left(v_denied::text,8)||'@example.com','Denied workflow editor','sender_user','client',v_client);
  INSERT INTO public.workflow_templates(id,name,description,version,status,scope_type,scope_id,created_by) VALUES
    (v_source,'lineage_source_'||left(v_source::text,8),'Source',1,'draft','client',v_client,v_actor),
    (v_target,'lineage_target_'||left(v_target::text,8),'Target',1,'draft','client',v_client,v_actor),
    (v_foreign,'lineage_foreign_'||left(v_foreign::text,8),'Foreign',1,'draft','client',v_foreign_client,v_actor);
  SELECT * INTO STRICT v_seed FROM public.workflow_template_steps WHERE enabled ORDER BY id LIMIT 1;
  INSERT INTO public.workflow_template_steps(workflow_template_id,sequence_order,operation_name,
    operation_settings_category,transition_condition,condition_jsonlogic,next_operation_name,
    next_operation_priority,next_operation_delay_seconds,manual_action_required,metadata,enabled,handler_key,handler_version)
  SELECT fixture.template_id,fixture.sequence_order,v_seed.operation_name,
    v_seed.operation_settings_category,v_seed.transition_condition,v_seed.condition_jsonlogic,v_seed.next_operation_name,
    v_seed.next_operation_priority,v_seed.next_operation_delay_seconds,v_seed.manual_action_required,
    jsonb_build_object('label',fixture.label),TRUE,v_seed.handler_key,v_seed.handler_version
  FROM (VALUES (v_source,1,'source one'),(v_source,2,'source two'),
    (v_target,1,'target one'),(v_target,3,'target three'),(v_foreign,1,'foreign one'))
    AS fixture(template_id,sequence_order,label);
  SELECT id INTO STRICT v_old_step FROM public.workflow_template_steps
    WHERE workflow_template_id=v_target AND sequence_order=1 AND enabled;
  SELECT version INTO STRICT v_prior_version FROM public.workflow_templates WHERE id=v_target;
  PERFORM set_config('app.workflow_run_id',v_run::text,TRUE);
  INSERT INTO public.workflow_runs(id,workflow_template_id,workflow_template_version,entry_point,
    workflow_status,current_step_id,context) VALUES
    (v_run,v_target,v_prior_version,'manual','pending',v_old_step,jsonb_build_object('organization_id',v_org,'client_id',v_client));
  v_args := jsonb_build_object('workflow_template_id',v_target,'source_workflow_template_id',v_source,'reason','restore tested source');
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(format('SELECT api.workflow_template_version_diff_v1(%L::jsonb)',
    (v_args||jsonb_build_object('source_workflow_template_id',v_foreign))::text),
    '42501',NULL,'diff refuses a foreign client source');
  RETURN NEXT throws_ok(format('SELECT api.restore_workflow_template_v1(%L::jsonb)',
    (v_args||jsonb_build_object('source_workflow_template_id',v_foreign))::text),
    '42501',NULL,'restore refuses a foreign client source');
  v_diff := api.workflow_template_version_diff_v1(v_args);
  RETURN NEXT is(jsonb_array_length(v_diff->'added_steps'),1,'diff reports target-only sequence');
  RETURN NEXT is(jsonb_array_length(v_diff->'removed_steps'),1,'diff reports source-only sequence');
  RETURN NEXT is(jsonb_array_length(v_diff->'modified_steps'),1,'diff reports changed shared sequence');
  RETURN NEXT throws_ok(format('SELECT api.restore_workflow_template_v1(%L::jsonb)',v_args::text),
    '23514','restore_workflow_template_v1 template has active runs','active execution prevents graph replacement');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT count(*)::integer FROM public.workflow_template_steps WHERE workflow_template_id=v_target AND enabled),
    2,'blocked restore leaves target graph unchanged');
  UPDATE public.workflow_runs SET workflow_status='continue' WHERE id=v_run;
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.restore_workflow_template_v1(%L::jsonb)',v_args::text),
    '23514','restore_workflow_template_v1 template has active runs','continue cannot be mistaken for a terminal workflow');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.workflow_runs SET workflow_status='completed',completed_at=now() WHERE id=v_run;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_stopped_run := (public.ui_start_workflow_run_v1(v_target,'{}'::jsonb,FALSE)->>'workflow_run_id')::uuid;
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.workflow_mark_run_stopped(v_stopped_run,'lineage restore stop');
  RETURN NEXT is((SELECT workflow_status FROM public.workflow_runs WHERE id=v_stopped_run),'stopped',
    'real browser preview and canonical stop produce the carrier terminal status');
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.restore_workflow_template_v1(v_args);
  RETURN NEXT ok((v_result->>'ok')::boolean,'canonical restore succeeds after execution completes');
  RETURN NEXT is((v_result->>'current_version')::integer,v_prior_version+1,'restore advances exactly one version');
  v_diff := public.workflow_template_version_diff_v1(v_args);
  RETURN NEXT is(jsonb_array_length(v_diff->'modified_steps'),0,'restore lineage does not create a false graph difference');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT count(*)::integer FROM public.workflow_template_steps WHERE workflow_template_id=v_target AND enabled),
    2,'source active steps are materialized');
  RETURN NEXT is((SELECT count(*)::integer FROM public.workflow_template_steps WHERE workflow_template_id=v_target AND NOT enabled),
    2,'previous steps remain as disabled history');
  RETURN NEXT ok((SELECT current_step_id=v_old_step FROM public.workflow_runs WHERE id=v_run)
    AND EXISTS(SELECT 1 FROM public.workflow_template_steps WHERE id=v_old_step),'historical run step reference survives restore');
  v_checksum := public.workflow_refresh_steps_checksum(v_target,FALSE);
  RETURN NEXT is(v_result->>'steps_checksum',v_checksum,'restore uses the carrier checksum implementation');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.workflow_run_steps WHERE workflow_run_id=v_stopped_run
    AND workflow_template_step_id=v_old_step),'real stopped run step history still references the retained original step');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.decision_log WHERE resource_id=v_target
    AND correlation_id=(v_result->>'correlation_id')::uuid AND decision_outcome='restored'
    AND decision_reason='restore tested source' AND decision_inputs->>'actor_user_id'=v_actor::text)
    AND EXISTS(SELECT 1 FROM public.domain_events WHERE resource_id=v_target
      AND correlation_id=(v_result->>'correlation_id')::uuid AND event_type='workflow_template.restored'),
    'restore records actor reason and correlated decision/event lineage');
  PERFORM set_config('app.workflow_run_id',v_stale_run::text,TRUE);
  RETURN NEXT throws_ok(format('INSERT INTO public.workflow_runs(id,workflow_template_id,workflow_template_version,entry_point,workflow_status) VALUES (%L::uuid,%L::uuid,%s,%L,%L)',
    v_stale_run,v_target,v_prior_version,'manual','pending'),
    '40001','Workflow template changed during start; restart the transaction','a start using the pre-restore version is rejected');
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
  PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT public.restore_workflow_template_v1(%L::jsonb)',v_args::text),
    '42501','restore_workflow_template_v1 requires authenticated user','service wrappers cannot bypass the user requirement');
  PERFORM set_config('request.jwt.claim.sub',v_denied::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_denied,'role','authenticated')::text,TRUE);
  RETURN NEXT throws_ok(format('SELECT api.restore_workflow_template_v1(%L::jsonb)',v_args::text),
    '42501','Capability denied: workflow_runs.write','restore retains the current capability boundary');
  EXECUTE 'SET LOCAL ROLE postgres';
END;
$test$;
SELECT * FROM pg_temp.lineage_template_version_behavior_v1();
SELECT * FROM finish();
ROLLBACK;
