-- pgTAP: F675 G15 route-stop reschedule proposal/acceptance lifecycle.
BEGIN;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(26);

SELECT has_function('public','ui_propose_route_stop_reschedule_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'],'public proposer exists');
SELECT has_function('api','ui_propose_route_stop_reschedule_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'],'api proposer exists');
SELECT has_function('public','ui_accept_route_stop_reschedule_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'],'public acceptor exists');
SELECT has_function('api','ui_accept_route_stop_reschedule_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'],'api acceptor exists');
SELECT has_function('public','ui_get_route_stop_reschedule_readback_v1',
  ARRAY['uuid','uuid','uuid'],'public readback exists');
SELECT has_function('api','ui_get_route_stop_reschedule_readback_v1',
  ARRAY['uuid','uuid','uuid'],'api readback exists');
SELECT ok(NOT has_function_privilege('anon',
  'api.ui_propose_route_stop_reschedule_v1(text,text,text[],text,integer,jsonb)','EXECUTE'),
  'anonymous proposer is denied');
SELECT ok(has_function_privilege('authenticated',
  'api.ui_propose_route_stop_reschedule_v1(text,text,text[],text,integer,jsonb)','EXECUTE'),
  'authenticated proposer is callable behind capability checks');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.transition_task_system_v1(uuid,text,text,jsonb,text,text)','EXECUTE'),
  'system completion helper remains private');

INSERT INTO public.workflow_templates(id,name,version,status,scope_type,scope_id)
VALUES('f6750000-0000-4000-8000-000000000001','pgtap_f675_reschedule',1,'active',
  public.get_root_scope_type_key_v1(),NULL);

-- Replace only the canonical reschedule dependency inside this rolled-back test
-- so wrapper authorization, locking, rollback, replay and evidence joins are deterministic.
CREATE OR REPLACE FUNCTION public.shipment_amend_cancel_v1(p_input JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp
AS $stub$
DECLARE
  v_template UUID;
  v_version INTEGER;
  v_run UUID:=gen_random_uuid();
  v_action UUID:=gen_random_uuid();
  v_shipment UUID:=(p_input->>'shipment_id')::uuid;
  v_organization UUID;
  v_client UUID;
BEGIN
  SELECT organization_id,client_id INTO STRICT v_organization,v_client
  FROM public.shipments WHERE id=v_shipment;
  SELECT id,version INTO STRICT v_template,v_version
  FROM public.workflow_templates
  WHERE id='f6750000-0000-4000-8000-000000000001' AND status='active';
  PERFORM set_config('app.workflow_run_id', v_run::text, true);
  INSERT INTO public.workflow_runs(
    id,workflow_template_id,workflow_template_version,entry_point,
    workflow_status,context,completed_at)
  VALUES(v_run,v_template,v_version,'manual','completed',
    jsonb_build_object('shipment_id',v_shipment,'organization_id',v_organization,
      'client_id',v_client,'slot_date',p_input->>'slot_date'),now());
  IF current_setting('pgtap.f675_amend_mode',true)='fail' THEN
    RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','fixture_rejected'));
  END IF;
  INSERT INTO public.shipment_actions(
    id,organization_id,client_id,shipment_id,action_type,action_category,action_data,
    performed_by_system,timestamp)
  VALUES(v_action,v_organization,v_client,v_shipment,'delivery_slot_reserved','operational',
    jsonb_build_object(
      'slot_date',p_input->>'slot_date',
      'idempotency_key',p_input->>'idempotency_key',
      'workflow_run_id',v_run),
    'pgtap_f675_reschedule_stub',now());
  RETURN jsonb_build_object(
    'ok',TRUE,'shipment_id',v_shipment,'operation','reschedule',
    'shipment_action_id',v_action,'workflow_run_id',v_run);
END;
$stub$;

CREATE OR REPLACE FUNCTION pg_temp.test_f675_route_stop_reschedule_v1()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $function$
DECLARE
  v_org UUID:=gen_random_uuid();
  v_branch UUID:=gen_random_uuid();
  v_client UUID:=gen_random_uuid();
  v_driver UUID:=gen_random_uuid();
  v_other UUID:=gen_random_uuid();
  v_operator UUID:=gen_random_uuid();
  v_shipment UUID:=gen_random_uuid();
  v_route RECORD;
  v_stop UUID;
  v_source UUID;
  v_result JSONB;
  v_replay JSONB;
  v_proposal UUID;
  v_proposed_event UUID;
  v_action UUID;
  v_workflow UUID;
  v_accept_event UUID;
  v_state TEXT;
  v_before_actions BIGINT;
  v_before_runs BIGINT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations(id,name,slug)
  VALUES(v_org,'F675 route reschedule org','f675-'||left(v_org::text,8));
  INSERT INTO public.branches(id,organization_id,code,name)
  VALUES(v_branch,v_org,'f675-'||left(v_branch::text,6),'F675 Branch');
  INSERT INTO public.clients(id,organization_id,name,slug,status)
  VALUES(v_client,v_org,'F675 Client','f675-'||left(v_client::text,8),'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
  VALUES
    (v_driver,v_org,'f675-driver-'||left(v_driver::text,8)||'@example.com','F675 Driver','driver','active','tenant'),
    (v_other,v_org,'f675-other-'||left(v_other::text,8)||'@example.com','F675 Other','driver','active','tenant'),
    (v_operator,v_org,'f675-ops-'||left(v_operator::text,8)||'@example.com','F675 Operator','ops_admin','active','tenant');
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org,ARRAY['driver','ops_admin'],v_operator);
  INSERT INTO public.rbac_user_role_assignments(
    organization_id,user_id,role_id,assigned_by_user_id,metadata)
  SELECT v_org,u.user_id,r.id,v_operator,'{"source":"pgtap"}'::jsonb
  FROM (VALUES(v_driver,'driver'),(v_other,'driver'),(v_operator,'ops_admin')) u(user_id,role_key)
  JOIN public.rbac_roles r ON r.organization_id=v_org AND r.key=u.role_key
  ON CONFLICT DO NOTHING;
  INSERT INTO public.shipments(id,organization_id,client_id,tracking_number,status,service_type)
  VALUES(v_shipment,v_org,v_client,'F675-'||upper(left(v_shipment::text,8)),'pending','delivery');
  SELECT * INTO v_route FROM public.create_route_run_v1(jsonb_build_object(
    'organization_id',v_org,'branch_id',v_branch,
    'stops',jsonb_build_array(jsonb_build_object(
      'client_id',v_client,'shipment_id',v_shipment,
      'stop_kind','delivery','sequence_order',1)))) LIMIT 1;
  SELECT id INTO STRICT v_stop FROM public.route_stops WHERE route_run_id=v_route.route_run_id;
  SELECT made.task_id INTO STRICT v_source FROM public.create_task_system_v1(jsonb_build_object(
    'task_type_key','route_stop_execute',
    'context',jsonb_build_object('organization_id',v_org,'client_id',v_client),
    'resource_type','route_stop','resource_id',v_stop,
    'idempotency_key','pgtap-f675-route-stop-task',
    'actor_system','pgtap')) made;
  UPDATE public.route_runs SET driver_user_id=v_driver WHERE id=v_route.route_run_id;
  PERFORM * FROM public.assign_task_system_v1(
    v_source,v_driver,'pgtap-f675-route-stop-assign','Assign fixture driver','pgtap');

  PERFORM set_config('request.jwt.claim.sub',v_driver::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub',v_driver,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result:=api.ui_propose_route_stop_reschedule_v1(
    'tasks.propose_route_stop_reschedule','tasks',ARRAY[v_source::text],v_source::text,1,
    jsonb_build_object('slot_date',current_date+1,'retry_key','f675-main'));
  v_proposal:=(v_result#>>'{proposal_task,id}')::uuid;
  v_proposed_event:=(v_result#>>'{proposal_task,task_event_id}')::uuid;
  RETURN NEXT ok(v_proposal IS NOT NULL AND v_proposed_event IS NOT NULL
    AND v_result#>>'{proposal,proposed_by_user_id}'=v_driver::text,
    'assigned driver proposes against the server-derived stop shipment');

  v_replay:=api.ui_propose_route_stop_reschedule_v1(
    'tasks.propose_route_stop_reschedule','tasks',ARRAY[v_source::text],v_source::text,1,
    jsonb_build_object('slot_date',current_date+1,'retry_key','f675-main'));
  RETURN NEXT ok(v_replay#>>'{proposal_task,id}'=v_proposal::text
    AND v_replay#>>'{proposal_task,task_event_id}'=v_proposed_event::text,
    'same actor and retry replay one proposal/event');
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_propose_route_stop_reschedule_v1(
      'tasks.propose_route_stop_reschedule','tasks',ARRAY[v_source::text],v_source::text,1,
      jsonb_build_object('slot_date',current_date+2,'retry_key','f675-main'));
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'23505','same retry with changed date conflicts');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_other::text,true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub',v_other,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_propose_route_stop_reschedule_v1(
      'tasks.propose_route_stop_reschedule','tasks',ARRAY[v_source::text],v_source::text,1,
      jsonb_build_object('slot_date',current_date+1,'retry_key','f675-denied'));
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','unassigned driver identity is denied');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_operator::text,true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub',v_operator,'role','authenticated')::text,true);
  UPDATE public.tasks SET assigned_to=v_other WHERE id=v_source;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_accept_route_stop_reschedule_v1(
      'tasks.accept_route_stop_reschedule','tasks',ARRAY[v_proposal::text],v_proposal::text,1,'{}');
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'23505','reassigned source is denied before shipment mutation');

  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.tasks SET assigned_to=v_driver,status='completed',completed_at=now() WHERE id=v_source;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_accept_route_stop_reschedule_v1(
      'tasks.accept_route_stop_reschedule','tasks',ARRAY[v_proposal::text],v_proposal::text,1,'{}');
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'23505','completed source is denied before shipment mutation');

  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.tasks SET assigned_to=v_driver,status='assigned',completed_at=NULL WHERE id=v_source;
  SELECT count(*) INTO v_before_actions FROM public.shipment_actions WHERE shipment_id=v_shipment;
  SELECT count(*) INTO v_before_runs FROM public.workflow_runs
  WHERE context->>'shipment_id'=v_shipment::text;
  PERFORM set_config('pgtap.f675_amend_mode','fail',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_accept_route_stop_reschedule_v1(
      'tasks.accept_route_stop_reschedule','tasks',ARRAY[v_proposal::text],v_proposal::text,1,'{}');
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'55000','failed canonical amend is surfaced');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok((SELECT status<>'completed' FROM public.tasks WHERE id=v_proposal),
    'failed amend does not complete proposal');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.task_events
    WHERE task_id=v_proposal AND event_type='status_changed' AND to_status='completed')
    AND (SELECT count(*) FROM public.shipment_actions WHERE shipment_id=v_shipment)=v_before_actions
    AND (SELECT count(*) FROM public.workflow_runs
      WHERE context->>'shipment_id'=v_shipment::text)=v_before_runs,
    'failed amend rolls back completion/action/workflow evidence');

  PERFORM set_config('pgtap.f675_amend_mode','success',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result:=api.ui_accept_route_stop_reschedule_v1(
    'tasks.accept_route_stop_reschedule','tasks',ARRAY[v_proposal::text],v_proposal::text,1,'{}');
  v_action:=(v_result#>>'{acceptance,shipment_action_id}')::uuid;
  v_workflow:=(v_result#>>'{acceptance,workflow_run_id}')::uuid;
  v_accept_event:=(v_result#>>'{acceptance,task_event_id}')::uuid;
  RETURN NEXT ok(v_action IS NOT NULL AND v_workflow IS NOT NULL AND v_accept_event IS NOT NULL
    AND v_result#>>'{acceptance,slot_date}'=(current_date+1)::text,
    'authorized operator receives exact action/workflow/date readback');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok((SELECT status='completed' AND completed_at IS NOT NULL
    FROM public.tasks WHERE id=v_proposal),'successful accept completes proposal');
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_replay:=api.ui_accept_route_stop_reschedule_v1(
    'tasks.accept_route_stop_reschedule','tasks',ARRAY[v_proposal::text],v_proposal::text,1,'{}');
  RETURN NEXT ok(v_replay#>>'{acceptance,task_event_id}'=v_accept_event::text
    AND v_replay#>>'{acceptance,shipment_action_id}'=v_action::text
    AND v_replay#>>'{acceptance,workflow_run_id}'=v_workflow::text,
    'double acceptance replays immutable completion evidence');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT count(*) FROM public.shipment_actions
    WHERE shipment_id=v_shipment AND action_data->>'idempotency_key'=
      'fieldops:route-stop-reschedule:accept:'||v_proposal),1::bigint,
    'double acceptance yields one shipment action');
  RETURN NEXT is((SELECT count(*) FROM public.workflow_runs
    WHERE id=v_workflow),1::bigint,'double acceptance yields one workflow');
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result:=api.ui_get_route_stop_reschedule_readback_v1(v_source,v_proposal,v_proposed_event);
  RETURN NEXT ok(v_result#>>'{acceptance,shipment_action_id}'=v_action::text,
    'operator with tasks.read and shipments.write can read terminal evidence');
  RETURN NEXT ok(current_setting('request.jwt.claim.sub',true)=v_operator::text
    AND current_setting('request.jwt.claim.role',true)='authenticated',
    'service transition restores operator claims');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_other::text,true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub',v_other,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_get_route_stop_reschedule_readback_v1(v_source,v_proposal,v_proposed_event);
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','non-owner without operator capabilities cannot read proposal');
END;
$function$;

SELECT * FROM pg_temp.test_f675_route_stop_reschedule_v1();
SELECT * FROM finish();
ROLLBACK;
