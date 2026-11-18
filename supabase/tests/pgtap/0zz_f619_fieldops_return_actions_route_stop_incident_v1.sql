-- pgTAP: F619 returned-to-branch action and route-stop incident boundaries.
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(49);

SELECT has_function('public','ui_execute_return_to_branch_action_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'],'public return action exists');
SELECT has_function('api','ui_execute_return_to_branch_action_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'],'api return action exists');
SELECT has_function('public','ui_report_route_stop_incident_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'],'public incident producer exists');
SELECT has_function('api','ui_report_route_stop_incident_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'],'api incident producer exists');
SELECT has_function('public','ui_get_route_stop_incident_readback_v1',
  ARRAY['uuid','uuid','uuid'],'public incident readback exists');
SELECT has_function('api','ui_get_route_stop_incident_readback_v1',
  ARRAY['uuid','uuid','uuid'],'api incident readback exists');

SELECT throws_ok(
  $$SELECT public.ui_execute_return_to_branch_action_v1(
    'return_to_branch.otp_pickup_release','return_to_branch_scan',
    ARRAY[gen_random_uuid()::text],gen_random_uuid()::text,1,'{}'::jsonb)$$,
  '55000','otp_issuer_verifier_authority_unavailable',
  'OTP release fails before actor or DML admission');
SELECT throws_ok(
  $$SELECT public.ui_execute_return_to_branch_action_v1(
    'return_to_branch.discard','return_to_branch_scan',
    ARRAY[gen_random_uuid()::text],gen_random_uuid()::text,1,'{}'::jsonb)$$,
  '55000','physical_discard_custody_finance_policy_unavailable',
  'discard fails before actor or DML admission');
SELECT throws_ok(
  $$SELECT public.ui_report_route_stop_incident_v1(
    'tasks.report_incident','tasks',ARRAY[gen_random_uuid()::text],
    gen_random_uuid()::text,1,
    '{"incident_type":"other","summary":"Observed","retry_key":"r1","artifact_ids":["00000000-0000-0000-0000-000000000001"]}'::jsonb)$$,
  '42501','route_stop_incident_forbidden',
  'incident producer requires an authenticated actor');
SELECT ok(EXISTS(
  SELECT 1 FROM public.settings s,
    LATERAL jsonb_array_elements(s.cached_value->'task_types') e
  WHERE s.category='task_type_catalog' AND s.scope_type='global'
    AND e->>'key'='route_stop_incident_review'),
  'incident task type is present in the row-driven catalog');


CREATE OR REPLACE FUNCTION pg_temp.test_f619_incident_behavior_v1()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $function$
DECLARE
  v_org UUID:=gen_random_uuid(); v_other_org UUID:=gen_random_uuid();
  v_branch UUID:=gen_random_uuid(); v_client UUID:=gen_random_uuid();
  v_driver UUID:=gen_random_uuid(); v_other UUID:=gen_random_uuid(); v_foreign UUID:=gen_random_uuid();
  v_shipment UUID:=gen_random_uuid(); v_owned UUID:=gen_random_uuid();
  v_other_artifact UUID:=gen_random_uuid(); v_foreign_artifact UUID:=gen_random_uuid();
  v_route RECORD; v_stop UUID; v_source UUID; v_result JSONB; v_replay JSONB;
  v_incident UUID; v_event UUID; v_error TEXT; v_state TEXT;
  v_status TEXT; v_version INTEGER; v_actions BIGINT; v_counts BIGINT[];
  v_review_status TEXT; v_review_version INTEGER; v_review_events BIGINT;
  v_blocked_id UUID:=gen_random_uuid(); v_ordinary_id UUID:=gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations(id,name,slug) VALUES
    (v_org,'F619 incident org','f619-'||left(v_org::text,8)),
    (v_other_org,'F619 foreign org','f619-'||left(v_other_org::text,8));
  INSERT INTO public.branches(id,organization_id,code,name)
  VALUES(v_branch,v_org,'f619-'||left(v_branch::text,6),'F619 Branch');
  INSERT INTO public.clients(id,organization_id,name,slug,status)
  VALUES(v_client,v_org,'F619 Client','f619-'||left(v_client::text,8),'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
  VALUES
    (v_driver,v_org,'f619-driver-'||left(v_driver::text,8)||'@example.com','F619 Driver','driver','active','tenant'),
    (v_other,v_org,'f619-other-'||left(v_other::text,8)||'@example.com','F619 Other','driver','active','tenant'),
    (v_foreign,v_other_org,'f619-foreign-'||left(v_foreign::text,8)||'@example.com','F619 Foreign','driver','active','tenant');
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org,ARRAY['driver'],v_driver);
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
    SELECT v_org,v_driver,r.id,v_driver,jsonb_build_object('seed',TRUE,'source','pgtap')
    FROM public.rbac_roles r WHERE r.organization_id=v_org AND r.key='driver'
    ON CONFLICT DO NOTHING;
  INSERT INTO public.shipments(id,organization_id,client_id,tracking_number,status,service_type)
  VALUES(v_shipment,v_org,v_client,'F619-'||upper(left(v_shipment::text,8)),'pending','delivery');
  SELECT * INTO v_route FROM public.create_route_run_v1(jsonb_build_object(
    'organization_id',v_org,'branch_id',v_branch,
    'stops',jsonb_build_array(jsonb_build_object(
      'client_id',v_client,'shipment_id',v_shipment,'stop_kind','delivery','sequence_order',1)))) LIMIT 1;
  SELECT id INTO STRICT v_stop FROM public.route_stops WHERE route_run_id=v_route.route_run_id;
  SELECT made.task_id INTO STRICT v_source FROM public.create_task_system_v1(jsonb_build_object(
    'task_type_key','route_stop_execute',
    'context',jsonb_build_object('organization_id',v_org,'client_id',v_client),
    'resource_type','route_stop','resource_id',v_stop,
    'idempotency_key','pgtap-f619-route-stop-task',
    'actor_system','pgtap')) made;
  UPDATE public.route_runs SET driver_user_id=v_driver WHERE id=v_route.route_run_id;
  PERFORM * FROM public.assign_task_system_v1(
    v_source,v_driver,'pgtap-f619-route-stop-assign','Assign fixture driver','pgtap');
  SELECT status,version INTO v_status,v_version FROM public.tasks WHERE id=v_source;
  SELECT count(*) INTO v_actions FROM public.shipment_actions WHERE shipment_id=v_shipment;
  INSERT INTO public.artifacts(id,organization_id,storage_bucket,storage_key,created_by_user_id) VALUES
    (v_owned,v_org,'fieldops-evidence','f619/'||v_owned,v_driver),
    (v_other_artifact,v_org,'fieldops-evidence','f619/'||v_other_artifact,v_other),
    (v_foreign_artifact,v_other_org,'fieldops-evidence','f619/'||v_foreign_artifact,v_foreign);

  RETURN NEXT ok(
    public.is_active_lookup_value_v1('route_stop_incident_type','incident',TRUE)
    AND public.is_active_lookup_value_v1('route_stop_incident_type','package_damage',TRUE),
    'dedicated incident lookup contains canonical values');

  PERFORM set_config('request.jwt.claim.sub',v_driver::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_driver,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result:=api.ui_report_route_stop_incident_v1(
    'tasks.report_incident','tasks',ARRAY[v_source::text],v_source::text,1,
    jsonb_build_object('incident_type','package_damage','summary','Package corner crushed',
      'retry_key','f619-retry','artifact_ids',jsonb_build_array(v_owned)));
  v_incident:=(v_result#>>'{incident_task,id}')::uuid;
  v_event:=(v_result#>>'{incident_task,task_event_id}')::uuid;
  RETURN NEXT ok(v_incident IS NOT NULL AND v_event IS NOT NULL
    AND v_result#>>'{incident,reported_by_user_id}'=v_driver::text,
    'authenticated driver creates actor-attributed incident task and event');
  RETURN NEXT ok(
    current_setting('request.jwt.claim.sub',true)=v_driver::text
    AND current_setting('request.jwt.claim.role',true)='authenticated'
    AND current_setting('request.jwt.claims',true)::jsonb->>'sub'=v_driver::text,
    'system task claim elevation restores caller claims');
  v_replay:=api.ui_report_route_stop_incident_v1(
    'tasks.report_incident','tasks',ARRAY[v_source::text],v_source::text,1,
    jsonb_build_object('incident_type','package_damage','summary','Package corner crushed',
      'retry_key','f619-retry','artifact_ids',jsonb_build_array(v_owned)));
  RETURN NEXT ok(v_replay#>>'{incident_task,id}'=v_incident::text
    AND v_replay#>>'{incident_task,task_event_id}'=v_event::text,
    'same actor retry converges on one task and event');

  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT status,version INTO v_review_status,v_review_version
  FROM public.tasks WHERE id=v_incident;
  SELECT count(*) INTO v_review_events FROM public.task_events WHERE task_id=v_incident;
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_state:=NULL; v_error:=NULL;
  BEGIN
    PERFORM * FROM api.transition_task_v1(v_incident,'completed',NULL,'{}'::jsonb,'f619-guard-direct');
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; v_error:=SQLERRM; END;
  RETURN NEXT ok(v_state='55000' AND v_error='route_stop_incident_resolution_unavailable',
    'direct API cannot close incident review without resolution authority');

  v_state:=NULL; v_error:=NULL;
  BEGIN
    PERFORM public.ui_execute_command_v1(
      'tasks.complete','tasks',ARRAY[v_incident::text],v_incident::text,1,'{}'::jsonb);
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; v_error:=SQLERRM; END;
  RETURN NEXT ok(v_state='55000' AND v_error='route_stop_incident_resolution_unavailable',
    'generic task command cannot close incident review');

  EXECUTE 'SET LOCAL ROLE postgres';
  v_state:=NULL; v_error:=NULL;
  BEGIN
    INSERT INTO public.tasks(id,organization_id,task_type_id,status,priority)
    SELECT v_blocked_id,v_org,t.task_type_id,'completed',50
    FROM public.tasks t WHERE t.id=v_incident;
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; v_error:=SQLERRM; END;
  RETURN NEXT ok(v_state='55000' AND v_error='route_stop_incident_resolution_unavailable',
    'incident review cannot be inserted already closed');
  RETURN NEXT ok(
    (SELECT status=v_review_status AND version=v_review_version FROM public.tasks WHERE id=v_incident)
    AND (SELECT count(*)=v_review_events FROM public.task_events WHERE task_id=v_incident)
    AND NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=v_blocked_id),
    'denied closure leaves incident task and ledger unchanged');

  UPDATE public.tasks SET status='in_progress' WHERE id=v_incident;
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id=v_incident),'in_progress',
    'incident review may advance within actionable states');
  UPDATE public.tasks SET status=status,metadata=metadata||'{"guard_probe":true}'::jsonb
  WHERE id=v_incident;
  RETURN NEXT ok((SELECT metadata->>'guard_probe'='true' FROM public.tasks WHERE id=v_incident),
    'same-status metadata update remains allowed');

  v_state:=NULL; v_error:=NULL;
  BEGIN UPDATE public.tasks SET status='resolved' WHERE id=v_incident;
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; v_error:=SQLERRM; END;
  RETURN NEXT ok(v_state='55000' AND v_error='route_stop_incident_resolution_unavailable',
    'unknown incident review closure state fails closed');

  v_state:=NULL; v_error:=NULL;
  BEGIN
    UPDATE public.tasks
    SET task_type_id=(SELECT task_type_id FROM public.tasks WHERE id=v_source),status='completed'
    WHERE id=v_incident;
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; v_error:=SQLERRM; END;
  RETURN NEXT ok(v_state='55000' AND v_error='route_stop_incident_resolution_unavailable',
    'review cannot be retyped and closed in one update');

  v_state:=NULL; v_error:=NULL;
  BEGIN
    UPDATE public.tasks
    SET task_type_id=(SELECT task_type_id FROM public.tasks WHERE id=v_source),status='in_progress'
    WHERE id=v_incident;
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; v_error:=SQLERRM; END;
  RETURN NEXT ok(v_state='55000' AND v_error='route_stop_incident_resolution_unavailable',
    'review cannot be retyped while actionable to bypass later closure');

  INSERT INTO public.tasks(id,organization_id,task_type_id,status,priority)
  SELECT v_ordinary_id,v_org,t.task_type_id,'open',50
  FROM public.tasks t WHERE t.id=v_source;
  UPDATE public.tasks SET status='completed' WHERE id=v_ordinary_id;
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id=v_ordinary_id),'completed',
    'ordinary task creation and completion remain allowed');

  v_state:=NULL;
  BEGIN
    PERFORM api.ui_report_route_stop_incident_v1(
      'tasks.report_incident','tasks',ARRAY[v_source::text],v_source::text,1,
      jsonb_build_object('incident_type','incident','summary','Different claim',
        'retry_key','f619-retry','artifact_ids',jsonb_build_array(v_owned)));
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'23505','same retry with different facts conflicts');

  v_state:=NULL;
  BEGIN
    PERFORM api.ui_report_route_stop_incident_v1(
      'tasks.report_incident','tasks',ARRAY[v_source::text],v_source::text,1,
      jsonb_build_object('incident_type','incident','summary','Not owned',
        'retry_key','f619-artifact','artifact_ids',jsonb_build_array(v_other_artifact)));
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','caller cannot attach another actor artifact');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_other::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_other,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_report_route_stop_incident_v1(
      'tasks.report_incident','tasks',ARRAY[v_source::text],v_source::text,1,
      jsonb_build_object('incident_type','incident','summary','Wrong actor',
        'retry_key','f619-actor','artifact_ids',jsonb_build_array(v_other_artifact)));
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','unassigned actor cannot report against source task');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_foreign::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_foreign,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_state:=NULL;
  BEGIN PERFORM api.ui_get_route_stop_incident_readback_v1(v_source,v_incident,v_event);
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','cross-organization incident readback is denied');

  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT ARRAY[(SELECT count(*) FROM public.tasks WHERE organization_id=v_org),
    (SELECT count(*) FROM public.task_events WHERE organization_id=v_org),
    (SELECT count(*) FROM public.artifact_links WHERE organization_id=v_org)] INTO v_counts;
  PERFORM set_config('request.jwt.claim.sub',v_driver::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_driver,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM api.ui_execute_return_to_branch_action_v1(
    'return_to_branch.otp_pickup_release','return_to_branch_scan',ARRAY[v_owned::text],v_owned::text,1,'{}');
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN PERFORM api.ui_execute_return_to_branch_action_v1(
    'return_to_branch.discard','return_to_branch_scan',ARRAY[v_owned::text],v_owned::text,1,'{}');
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(v_counts=ARRAY[(SELECT count(*) FROM public.tasks WHERE organization_id=v_org),
    (SELECT count(*) FROM public.task_events WHERE organization_id=v_org),
    (SELECT count(*) FROM public.artifact_links WHERE organization_id=v_org)],
    'unavailable return actions perform zero task or evidence DML');
  RETURN NEXT ok((SELECT status=v_status AND version=v_version FROM public.tasks WHERE id=v_source),
    'incident reporting leaves source task status and version unchanged');
  RETURN NEXT is((SELECT count(*) FROM public.shipment_actions WHERE shipment_id=v_shipment),v_actions,
    'incident reporting creates no shipment action');
  RETURN NEXT is((SELECT count(*) FROM public.artifact_links
    WHERE resource_type='task_event' AND resource_id=v_event AND relation_type='incident_evidence'),1::bigint,
    'incident event links the caller-owned artifact once');
  RETURN NEXT ok((SELECT metadata->>'reported_by_user_id'=v_driver::text FROM public.tasks WHERE id=v_incident),
    'incident task preserves reporter identity in immutable metadata');
END;
$function$;

SELECT * FROM pg_temp.test_f619_incident_behavior_v1();

CREATE OR REPLACE FUNCTION pg_temp.test_f619_return_action_behavior_v1()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $function$
DECLARE
  v_org UUID:=gen_random_uuid(); v_foreign_org UUID:=gen_random_uuid();
  v_branch UUID:=gen_random_uuid(); v_location UUID:=gen_random_uuid();
  v_client UUID:=gen_random_uuid(); v_sender UUID:=gen_random_uuid();
  v_actor UUID:=gen_random_uuid(); v_peer UUID:=gen_random_uuid(); v_foreign UUID:=gen_random_uuid();
  v_shipment UUID:=gen_random_uuid(); v_tracking TEXT:='F619-RETURN-'||left(v_shipment::text,8);
  v_device RECORD; v_scan RECORD; v_receipt JSONB; v_result JSONB;
  v_review UUID; v_state TEXT; v_followups BIGINT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations(id,name,slug) VALUES
    (v_org,'F619 return org','f619-return-'||left(v_org::text,8)),
    (v_foreign_org,'F619 foreign return org','f619-return-'||left(v_foreign_org::text,8));
  INSERT INTO public.branches(id,organization_id,code,name)
    VALUES(v_branch,v_org,'f619-'||left(v_branch::text,6),'F619 Return Branch');
  INSERT INTO public.warehouse_locations(id,organization_id,branch_id,code,name,location_type,is_active)
    VALUES(v_location,v_org,v_branch,'f619-'||left(v_location::text,6),'F619 Return Location','stage',TRUE);
  INSERT INTO public.clients(id,organization_id,name,slug,status)
    VALUES(v_client,v_org,'F619 Return Client','f619-return-'||left(v_client::text,8),'active');
  INSERT INTO public.senders(id,client_id,name,brand_name,auto_provisioned,status)
    VALUES(v_sender,v_client,'F619 Return Sender','F619 Return Sender',TRUE,'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type)
    VALUES
    (v_actor,v_org,'f619-return-'||left(v_actor::text,8)||'@example.com','F619 Actor','ops_admin','active','tenant'),
    (v_peer,v_org,'f619-peer-'||left(v_peer::text,8)||'@example.com','F619 Peer','ops_admin','active','tenant'),
    (v_foreign,v_foreign_org,'f619-foreign-return-'||left(v_foreign::text,8)||'@example.com','F619 Foreign','ops_admin','active','tenant');
  INSERT INTO public.shipments(id,organization_id,client_id,sender_id,tracking_number,status,service_type)
    VALUES(v_shipment,v_org,v_client,v_sender,v_tracking,'pending','delivery');
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org,ARRAY['ops_admin'],v_actor);
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
    SELECT v_org,v_actor,r.id,v_actor,jsonb_build_object('seed',TRUE,'source','pgtap')
    FROM public.rbac_roles r WHERE r.organization_id=v_org AND r.key='ops_admin'
    ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT * INTO STRICT v_device FROM public.register_user_device_v1(jsonb_build_object(
    'device_platform','android','device_identifier_sha256','f619-return-'||v_actor::text));
  SELECT * INTO STRICT v_scan FROM public.record_scan_event_v1(jsonb_build_object(
    'idempotency_key','f619-return:'||v_shipment,'device_id',v_device.device_id,
    'branch_id',v_branch,'client_id',v_client,'shipment_id',v_shipment,
    'scan_type','return_to_branch_intake','barcode',v_tracking,'captured_at',now()));
  v_receipt:=api.ui_get_return_to_branch_scan_readback_v1(v_scan.scan_event_id);
  RETURN NEXT ok(v_scan.created AND v_receipt->>'scan_event_id'=v_scan.scan_event_id::text
    AND v_receipt->>'inventory_movement_id' IS NOT NULL AND v_receipt->>'shipment_action_id' IS NOT NULL,
    'actor receives accepted scan with canonical inventory and shipment-action receipt');
  v_result:=api.ui_get_return_to_branch_scan_by_idempotency_v1('f619-return:'||v_shipment);
  RETURN NEXT ok(v_result->>'scan_event_id'=v_scan.scan_event_id::text
    AND v_result->>'barcode'=v_tracking AND v_result->'receipt'=v_receipt,
    'actor recovers exact accepted scan by durable queue key');
  RETURN NEXT is(api.ui_get_return_to_branch_scan_by_idempotency_v1('missing-key'),NULL::jsonb,
    'unknown key reveals no scan');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_peer::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_peer,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.ui_get_return_to_branch_scan_readback_v1(v_scan.scan_event_id),NULL::jsonb,
    'same-org peer cannot read actor scan receipt');
  RETURN NEXT is(api.ui_get_return_to_branch_scan_by_idempotency_v1('f619-return:'||v_shipment),NULL::jsonb,
    'same-org peer cannot recover actor scan by key');
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_execute_return_to_branch_action_v1('return_to_branch.escalate','return_to_branch_scan',
      ARRAY[v_scan.scan_event_id::text],v_scan.scan_event_id::text,1,'{}');
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','same-org peer cannot escalate actor scan');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_foreign::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_foreign,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.ui_get_return_to_branch_scan_readback_v1(v_scan.scan_event_id),NULL::jsonb,
    'foreign actor cannot read scan receipt');
  RETURN NEXT is(api.ui_get_return_to_branch_scan_by_idempotency_v1('f619-return:'||v_shipment),NULL::jsonb,
    'foreign actor cannot recover scan by key');
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_execute_return_to_branch_action_v1('return_to_branch.escalate','return_to_branch_scan',
      ARRAY[v_scan.scan_event_id::text],v_scan.scan_event_id::text,1,'{}');
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','foreign actor cannot escalate actor scan');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result:=api.ui_execute_return_to_branch_action_v1('return_to_branch.escalate','return_to_branch_scan',
    ARRAY[v_scan.scan_event_id::text],v_scan.scan_event_id::text,1,'{"summary":"Return requires review"}'::jsonb);
  RETURN NEXT is(v_result->>'status','escalated','actor escalates accepted return');
  RETURN NEXT ok(current_setting('request.jwt.claim.sub',TRUE)=v_actor::text
    AND current_setting('request.jwt.claim.role',TRUE)='authenticated'
    AND current_setting('request.jwt.claims',TRUE)::jsonb->>'sub'=v_actor::text,
    'escalation restores actor claims after system task creation');
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT t.id INTO STRICT v_review FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id WHERE t.organization_id=v_org
    AND t.resource_type='shipment' AND t.resource_id=v_shipment
    AND tt.key='dispatch_exception_review'
    AND t.metadata->>'return_to_branch_scan_event_id'=v_scan.scan_event_id::text;
  RETURN NEXT ok(v_review IS NOT NULL,'escalation creates scan-bound dispatch review');
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM api.ui_execute_return_to_branch_action_v1('return_to_branch.escalate','return_to_branch_scan',
    ARRAY[v_scan.scan_event_id::text],v_scan.scan_event_id::text,1,'{}');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT count(*) FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id WHERE t.organization_id=v_org
    AND t.resource_id=v_shipment AND tt.key='dispatch_exception_review'
    AND t.metadata->>'return_to_branch_scan_event_id'=v_scan.scan_event_id::text),
    1::bigint,'escalation replay reuses the same review');
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result:=api.ui_execute_return_to_branch_action_v1('return_to_branch.reinduct','return_to_branch_scan',
    ARRAY[v_scan.scan_event_id::text],v_scan.scan_event_id::text,1,
    '{"resolution_notes":"Reattempt after branch intake"}'::jsonb);
  RETURN NEXT ok(v_result->>'status' IN ('scheduled','completed')
    AND v_result#>>'{items,0,task_id}'=v_review::text,
    'reinduct delegates scan-bound review to canonical NDR reattempt');
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT count(*) INTO v_followups FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id WHERE t.organization_id=v_org
    AND t.resource_id=v_shipment AND tt.key='dispatch_reattempt_delivery';
  RETURN NEXT is(v_followups,1::bigint,'NDR reattempt creates one follow-up');
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_state:=NULL;
  BEGIN
    PERFORM api.ui_execute_return_to_branch_action_v1('return_to_branch.reinduct','return_to_branch_scan',
      ARRAY[v_scan.scan_event_id::text],v_scan.scan_event_id::text,1,'{}');
  EXCEPTION WHEN others THEN v_state:=SQLSTATE; END;
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(v_state='55000' AND (SELECT count(*) FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
    WHERE t.organization_id=v_org AND t.resource_id=v_shipment
      AND tt.key='dispatch_reattempt_delivery')=v_followups,
    'reinduct replay cannot create a duplicate follow-up');
END;
$function$;

SELECT * FROM pg_temp.test_f619_return_action_behavior_v1();
SELECT * FROM finish();
ROLLBACK;
