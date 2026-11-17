-- F675 G15: driver proposal and authorized acceptance of route-stop rescheduling.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260914004000_fieldops_route_stop_reschedule_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_get_route_stop_reschedule_readback_v1(
  p_source_task_id UUID,p_proposal_task_id UUID,p_proposal_task_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security TO on
AS $function$
DECLARE
  v_actor UUID:=auth.uid();
  v_org UUID:=public.current_user_org_id();
  v_scope_type TEXT:=public.current_user_scope_type();
  v_scope_id UUID:=public.current_user_scope_id();
  v_source_visible BOOLEAN:=FALSE;
  v_operator_visible BOOLEAN:=FALSE;
  v_result JSONB;
BEGIN
  IF v_actor IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_readback_forbidden' USING ERRCODE='42501';
  END IF;
  v_source_visible:=public.ui_get_resource_v1('tasks',p_source_task_id) IS NOT NULL;
  BEGIN
    PERFORM public.assert_capability_v1('tasks.read',v_scope_type,v_scope_id);
    PERFORM public.assert_capability_v1('shipments.write',v_scope_type,v_scope_id);
    v_operator_visible:=public.ui_get_resource_v1('tasks',p_proposal_task_id) IS NOT NULL;
  EXCEPTION WHEN others THEN
    v_operator_visible:=FALSE;
  END;
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'source_task',jsonb_build_object('id',src.id,'status',src.status),
    'proposal_task',jsonb_build_object(
      'id',proposal.id,'status',proposal.status,'assigned_to',proposal.assigned_to,
      'queue_key',proposal.queue_key,'task_event_id',proposed.id),
    'proposal',jsonb_build_object(
      'route_stop_id',rs.id,'route_run_id',rs.route_run_id,
      'shipment_id',rs.shipment_id,
      'slot_date',(proposal.metadata->>'proposed_slot_date')::date,
      'proposed_by_user_id',(proposal.metadata->>'reported_by_user_id')::uuid),
    'acceptance',CASE WHEN accepted.id IS NULL THEN NULL ELSE jsonb_build_object(
      'task_event_id',accepted.id,'accepted_by_user_id',(accepted.payload->>'accepted_by_user_id')::uuid,
      'shipment_action_id',sa.id,'workflow_run_id',wr.id,
      'slot_date',(accepted.payload->>'slot_date')::date) END))
  INTO v_result
  FROM public.tasks src
  JOIN public.tasks proposal ON proposal.id=p_proposal_task_id
    AND proposal.organization_id=src.organization_id
    AND proposal.resource_type='shipment'
    AND proposal.resource_id=(proposal.metadata->>'shipment_id')::uuid
    AND proposal.metadata->>'proposal_kind'='route_stop_reschedule_v1'
    AND proposal.metadata->>'source_task_id'=src.id::text
  JOIN public.task_types pt ON pt.id=proposal.task_type_id
    AND pt.key='dispatch_reschedule_delivery'
  JOIN public.task_events proposed ON proposed.id=p_proposal_task_event_id
    AND proposed.task_id=proposal.id
    AND proposed.organization_id=proposal.organization_id
    AND proposed.event_type='reschedule_proposed'
    AND proposed.actor_user_id=(proposal.metadata->>'reported_by_user_id')::uuid
    AND proposed.payload->>'source_task_id'=src.id::text
    AND proposed.payload->>'route_stop_id'=proposal.metadata->>'route_stop_id'
    AND proposed.payload->>'shipment_id'=proposal.metadata->>'shipment_id'
    AND proposed.payload->>'slot_date'=proposal.metadata->>'proposed_slot_date'
  JOIN public.route_stops_visible_v1 rs ON rs.id=src.resource_id
    AND rs.organization_id=src.organization_id
    AND rs.id=(proposal.metadata->>'route_stop_id')::uuid
    AND rs.shipment_id=proposal.resource_id
  LEFT JOIN LATERAL (
    SELECT ev.* FROM public.task_events ev
    WHERE ev.task_id=proposal.id AND ev.organization_id=proposal.organization_id
      AND ev.event_type='status_changed' AND ev.to_status='completed'
      AND ev.payload->>'status_reason'='route_stop_reschedule_accepted'
      AND ev.payload->>'proposal_task_id'=proposal.id::text
      AND ev.payload->>'source_task_id'=src.id::text
      AND ev.payload->>'route_stop_id'=rs.id::text
      AND ev.payload->>'shipment_id'=rs.shipment_id::text
      AND ev.payload->>'slot_date'=proposal.metadata->>'proposed_slot_date'
      AND ev.idempotency_key='fieldops:route-stop-reschedule:accept:'||proposal.id||':accepted'
    ORDER BY ev.created_at DESC,ev.id DESC LIMIT 1
  ) accepted ON TRUE
  LEFT JOIN public.shipment_actions sa ON accepted.id IS NOT NULL
    AND sa.id=(accepted.payload->>'shipment_action_id')::uuid
    AND sa.shipment_id=rs.shipment_id
    AND sa.action_type='delivery_slot_reserved'
    AND sa.action_data->>'slot_date'=proposal.metadata->>'proposed_slot_date'
    AND sa.action_data->>'idempotency_key'='fieldops:route-stop-reschedule:accept:'||proposal.id
  LEFT JOIN public.workflow_runs wr ON accepted.id IS NOT NULL
    AND wr.id=(accepted.payload->>'workflow_run_id')::uuid
    AND wr.id::text=sa.action_data->>'workflow_run_id'
  WHERE src.id=p_source_task_id AND src.organization_id=v_org
    AND src.resource_type='route_stop'
    AND ((v_source_visible AND src.assigned_to=v_actor
      AND lower(src.status) IN ('open','pending','assigned','in_progress')
      AND src.completed_at IS NULL AND src.canceled_at IS NULL)
      OR v_operator_visible)
    AND (accepted.id IS NULL OR (sa.id IS NOT NULL AND wr.id IS NOT NULL));
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_readback_forbidden' USING ERRCODE='42501';
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_propose_route_stop_reschedule_v1(
  p_action_key TEXT,p_resource_key TEXT,p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security TO on
AS $function$
DECLARE
  v_actor UUID:=auth.uid();
  v_org UUID:=public.current_user_org_id();
  v_scope_type TEXT:=public.current_user_scope_type();
  v_scope_id UUID:=public.current_user_scope_id();
  v_registry JSONB;
  v_command JSONB;
  v_source_task_id UUID;
  v_source public.tasks%ROWTYPE;
  v_stop public.route_stops_visible_v1%ROWTYPE;
  v_slot_date DATE;
  v_retry TEXT:=NULLIF(btrim(COALESCE(p_params->>'retry_key','')),'');
  v_key TEXT;
  v_created RECORD;
  v_proposal public.tasks%ROWTYPE;
  v_event_id UUID;
  v_assignee UUID;
  v_claims JSONB;
  v_prev_claims TEXT;
  v_prev_role TEXT;
  v_prev_sub TEXT;
  v_service_claims JSONB;
BEGIN
  IF v_actor IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_forbidden' USING ERRCODE='42501';
  END IF;
  v_registry:=public.resolve_settings_merged('ui_command_registry',v_scope_type,v_scope_id);
  SELECT value INTO v_command FROM jsonb_array_elements(COALESCE(v_registry->'commands','[]'::jsonb))
  WHERE value->>'key'=p_action_key LIMIT 1;
  IF v_command IS NULL
    OR COALESCE((v_command->>'available')::boolean,FALSE) IS NOT TRUE
    OR v_command->>'capability' IS DISTINCT FROM 'tasks.complete'
    OR v_command#>>'{execution,rpc}' IS DISTINCT FROM 'ui_propose_route_stop_reschedule_v1' THEN
    RAISE EXCEPTION 'route_stop_reschedule_invalid_command' USING ERRCODE='22023';
  END IF;
  PERFORM public.assert_capability_v1('tasks.read',v_scope_type,v_scope_id);
  PERFORM public.assert_capability_v1('tasks.complete',v_scope_type,v_scope_id);
  IF p_action_key IS DISTINCT FROM 'tasks.propose_route_stop_reschedule'
    OR p_resource_key IS DISTINCT FROM 'tasks'
    OR COALESCE(p_selection_count,0)<>1
    OR COALESCE(cardinality(p_selection_ids),0)<>1
    OR NULLIF(btrim(COALESCE(p_selection_id,'')),'') IS NULL
    OR p_selection_ids[1] IS DISTINCT FROM p_selection_id
    OR jsonb_typeof(COALESCE(p_params,'{}'::jsonb)) IS DISTINCT FROM 'object'
    OR v_retry IS NULL OR length(v_retry)>200 THEN
    RAISE EXCEPTION 'route_stop_reschedule_invalid_request' USING ERRCODE='22023';
  END IF;
  BEGIN
    v_source_task_id:=p_selection_id::uuid;
    v_slot_date:=NULLIF(p_params->>'slot_date','')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'route_stop_reschedule_invalid_request' USING ERRCODE='22023';
  END;
  IF v_slot_date IS NULL OR v_slot_date<current_date THEN
    RAISE EXCEPTION 'route_stop_reschedule_invalid_date' USING ERRCODE='22023';
  END IF;
  IF public.ui_get_resource_v1('tasks',v_source_task_id) IS NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_forbidden' USING ERRCODE='42501';
  END IF;
  SELECT t.* INTO v_source
  FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE t.id=v_source_task_id AND t.organization_id=v_org
    AND tt.key='route_stop_execute' AND t.resource_type='route_stop'
    AND t.assigned_to=v_actor
    AND lower(t.status) IN ('open','pending','assigned','in_progress')
    AND t.completed_at IS NULL AND t.canceled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_stop_reschedule_forbidden' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_stop FROM public.route_stops_visible_v1 rs
  WHERE rs.id=v_source.resource_id AND rs.organization_id=v_org
    AND rs.shipment_id IS NOT NULL
    AND (v_source.client_id IS NULL OR rs.client_id=v_source.client_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_stop_reschedule_forbidden' USING ERRCODE='42501';
  END IF;
  v_key:='fieldops:route-stop-reschedule:propose:'||v_actor||':'||v_retry;
  v_prev_claims:=COALESCE(current_setting('request.jwt.claims',true),'');
  v_prev_role:=COALESCE(current_setting('request.jwt.claim.role',true),'');
  v_prev_sub:=COALESCE(current_setting('request.jwt.claim.sub',true),'');
  BEGIN v_claims:=NULLIF(v_prev_claims,'')::jsonb;
  EXCEPTION WHEN others THEN v_claims:='{}'::jsonb; END;
  v_service_claims:=(COALESCE(v_claims,'{}'::jsonb)-'sub')||jsonb_build_object('role','service_role');
  PERFORM set_config('request.jwt.claims',v_service_claims::text,true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  BEGIN
    SELECT * INTO v_created FROM public.create_task_system_v1(jsonb_build_object(
      'task_type_key','dispatch_reschedule_delivery',
      'resource_type','shipment','resource_id',v_stop.shipment_id,
      'idempotency_key',v_key,'actor_system','fieldops_route_stop_reschedule',
      'context',jsonb_strip_nulls(jsonb_build_object(
        'organization_id',v_org,'client_id',v_source.client_id,
        'sender_id',v_source.sender_id,'shipment_id',v_stop.shipment_id,
        'route_stop_id',v_stop.id,'route_run_id',v_stop.route_run_id,
        'branch_id',v_stop.branch_id)),
      'metadata',jsonb_build_object(
        'proposal_kind','route_stop_reschedule_v1',
        'source_task_id',v_source.id,'route_stop_id',v_stop.id,
        'route_run_id',v_stop.route_run_id,'shipment_id',v_stop.shipment_id,
        'proposed_slot_date',v_slot_date,'reported_by_user_id',v_actor)));
  EXCEPTION WHEN others THEN
    PERFORM set_config('request.jwt.claims',v_prev_claims,true);
    PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
    PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
    RAISE;
  END;
  PERFORM set_config('request.jwt.claims',v_prev_claims,true);
  PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
  PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
  SELECT * INTO STRICT v_proposal FROM public.tasks WHERE id=v_created.task_id FOR UPDATE;
  IF v_proposal.organization_id IS DISTINCT FROM v_org
    OR v_proposal.resource_type IS DISTINCT FROM 'shipment'
    OR v_proposal.resource_id IS DISTINCT FROM v_stop.shipment_id
    OR v_proposal.metadata->>'proposal_kind' IS DISTINCT FROM 'route_stop_reschedule_v1'
    OR v_proposal.metadata->>'source_task_id' IS DISTINCT FROM v_source.id::text
    OR v_proposal.metadata->>'route_stop_id' IS DISTINCT FROM v_stop.id::text
    OR v_proposal.metadata->>'shipment_id' IS DISTINCT FROM v_stop.shipment_id::text
    OR v_proposal.metadata->>'proposed_slot_date' IS DISTINCT FROM v_slot_date::text
    OR v_proposal.metadata->>'reported_by_user_id' IS DISTINCT FROM v_actor::text THEN
    RAISE EXCEPTION 'route_stop_reschedule_idempotency_conflict' USING ERRCODE='23505';
  END IF;
  SELECT ev.id INTO v_event_id FROM public.task_events ev
  WHERE ev.task_id=v_proposal.id AND ev.event_type='reschedule_proposed'
    AND ev.actor_user_id=v_actor AND ev.idempotency_key=v_key||':proposed';
  IF v_event_id IS NULL THEN
    UPDATE public.tasks SET version=version+1,updated_at=now()
    WHERE id=v_proposal.id RETURNING version INTO v_proposal.version;
    INSERT INTO public.task_events(
      task_id,organization_id,event_type,from_status,to_status,actor_user_id,
      actor_system,payload,idempotency_key,task_version,created_at)
    VALUES(
      v_proposal.id,v_org,'reschedule_proposed',v_proposal.status,v_proposal.status,
      v_actor,'fieldops_route_stop_reschedule',
      jsonb_build_object(
        'proposal_task_id',v_proposal.id,'source_task_id',v_source.id,
        'route_stop_id',v_stop.id,'route_run_id',v_stop.route_run_id,
        'shipment_id',v_stop.shipment_id,'slot_date',v_slot_date),
      v_key||':proposed',v_proposal.version,now())
    RETURNING id INTO v_event_id;
  END IF;
  IF v_proposal.assigned_to IS NULL THEN
    v_assignee:=public.resolve_task_assignee_user_v1(
      v_org,v_stop.branch_id,COALESCE(v_proposal.metadata->'assignment_defaults','{}'::jsonb));
    IF v_assignee IS NOT NULL THEN
      PERFORM set_config('request.jwt.claims',v_service_claims::text,true);
      PERFORM set_config('request.jwt.claim.role','service_role',true);
      PERFORM set_config('request.jwt.claim.sub','',true);
      BEGIN
        PERFORM * FROM public.assign_task_system_v1(
          v_proposal.id,v_assignee,v_key||':assign',
          'Assigned from task type defaults','fieldops_route_stop_reschedule');
      EXCEPTION WHEN others THEN
        PERFORM set_config('request.jwt.claims',v_prev_claims,true);
        PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
        PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
        RAISE;
      END;
      PERFORM set_config('request.jwt.claims',v_prev_claims,true);
      PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
      PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
    END IF;
  END IF;
  RETURN public.ui_get_route_stop_reschedule_readback_v1(v_source.id,v_proposal.id,v_event_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_accept_route_stop_reschedule_v1(
  p_action_key TEXT,p_resource_key TEXT,p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security TO on
AS $function$
DECLARE
  v_actor UUID:=auth.uid();
  v_org UUID:=public.current_user_org_id();
  v_scope_type TEXT:=public.current_user_scope_type();
  v_scope_id UUID:=public.current_user_scope_id();
  v_registry JSONB;
  v_command JSONB;
  v_proposal_id UUID;
  v_proposal public.tasks%ROWTYPE;
  v_source public.tasks%ROWTYPE;
  v_stop public.route_stops_visible_v1%ROWTYPE;
  v_proposal_event_id UUID;
  v_accepted_event_id UUID;
  v_slot_date DATE;
  v_shipment_id UUID;
  v_action_id UUID;
  v_workflow_run_id UUID;
  v_amend JSONB;
  v_transition JSONB;
  v_claims JSONB;
  v_prev_claims TEXT;
  v_prev_role TEXT;
  v_prev_sub TEXT;
  v_service_claims JSONB;
BEGIN
  IF v_actor IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_forbidden' USING ERRCODE='42501';
  END IF;
  v_registry:=public.resolve_settings_merged('ui_command_registry',v_scope_type,v_scope_id);
  SELECT value INTO v_command FROM jsonb_array_elements(COALESCE(v_registry->'commands','[]'::jsonb))
  WHERE value->>'key'=p_action_key LIMIT 1;
  IF v_command IS NULL
    OR COALESCE((v_command->>'available')::boolean,FALSE) IS NOT TRUE
    OR v_command->>'capability' IS DISTINCT FROM 'shipments.write'
    OR v_command#>>'{execution,rpc}' IS DISTINCT FROM 'ui_accept_route_stop_reschedule_v1' THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_invalid_command' USING ERRCODE='22023';
  END IF;
  PERFORM public.assert_capability_v1('tasks.read',v_scope_type,v_scope_id);
  PERFORM public.assert_capability_v1('shipments.write',v_scope_type,v_scope_id);
  IF p_action_key IS DISTINCT FROM 'tasks.accept_route_stop_reschedule'
    OR p_resource_key IS DISTINCT FROM 'tasks'
    OR COALESCE(p_selection_count,0)<>1
    OR COALESCE(cardinality(p_selection_ids),0)<>1
    OR NULLIF(btrim(COALESCE(p_selection_id,'')),'') IS NULL
    OR p_selection_ids[1] IS DISTINCT FROM p_selection_id
    OR jsonb_typeof(COALESCE(p_params,'{}'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_invalid_request' USING ERRCODE='22023';
  END IF;
  BEGIN v_proposal_id:=p_selection_id::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_invalid_request' USING ERRCODE='22023';
  END;
  IF public.ui_get_resource_v1('tasks',v_proposal_id) IS NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_forbidden' USING ERRCODE='42501';
  END IF;
  SELECT p.* INTO v_proposal
  FROM public.tasks p JOIN public.task_types pt ON pt.id=p.task_type_id
  WHERE p.id=v_proposal_id AND p.organization_id=v_org
    AND pt.key='dispatch_reschedule_delivery'
    AND p.resource_type='shipment'
    AND p.metadata->>'proposal_kind'='route_stop_reschedule_v1'
    AND (lower(p.status) IN ('open','pending','assigned','in_progress')
      OR (lower(p.status)='completed' AND p.completed_at IS NOT NULL))
    AND p.canceled_at IS NULL
  FOR UPDATE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_forbidden' USING ERRCODE='42501';
  END IF;
  BEGIN
    v_slot_date:=NULLIF(v_proposal.metadata->>'proposed_slot_date','')::date;
    v_shipment_id:=NULLIF(v_proposal.metadata->>'shipment_id','')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_conflict' USING ERRCODE='23505';
  END;
  SELECT ev.id INTO v_proposal_event_id FROM public.task_events ev
  WHERE ev.task_id=v_proposal.id AND ev.organization_id=v_org
    AND ev.event_type='reschedule_proposed'
    AND ev.actor_user_id=(v_proposal.metadata->>'reported_by_user_id')::uuid
    AND ev.payload->>'proposal_task_id'=v_proposal.id::text
    AND ev.payload->>'source_task_id'=v_proposal.metadata->>'source_task_id'
    AND ev.payload->>'route_stop_id'=v_proposal.metadata->>'route_stop_id'
    AND ev.payload->>'shipment_id'=v_shipment_id::text
    AND ev.payload->>'slot_date'=v_slot_date::text
  ORDER BY ev.created_at,ev.id LIMIT 1;
  IF v_proposal_event_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_conflict' USING ERRCODE='23505';
  END IF;
  SELECT ev.id INTO v_accepted_event_id FROM public.task_events ev
  WHERE ev.task_id=v_proposal.id AND ev.organization_id=v_org
    AND ev.event_type='status_changed' AND ev.to_status='completed'
    AND ev.payload->>'status_reason'='route_stop_reschedule_accepted'
    AND ev.payload->>'proposal_task_id'=v_proposal.id::text
    AND ev.payload->>'source_task_id'=v_proposal.metadata->>'source_task_id'
    AND ev.payload->>'route_stop_id'=v_proposal.metadata->>'route_stop_id'
    AND ev.payload->>'shipment_id'=v_shipment_id::text
    AND ev.payload->>'slot_date'=v_slot_date::text
    AND ev.idempotency_key='fieldops:route-stop-reschedule:accept:'||v_proposal.id||':accepted'
  ORDER BY ev.created_at DESC,ev.id DESC LIMIT 1;
  IF v_accepted_event_id IS NOT NULL THEN
    IF lower(v_proposal.status)<>'completed' OR v_proposal.completed_at IS NULL THEN
      RAISE EXCEPTION 'route_stop_reschedule_accept_conflict' USING ERRCODE='23505';
    END IF;
    BEGIN
      SELECT t.* INTO STRICT v_source FROM public.tasks t
      WHERE t.id=(v_proposal.metadata->>'source_task_id')::uuid
        AND t.organization_id=v_org AND t.resource_type='route_stop';
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'route_stop_reschedule_accept_conflict' USING ERRCODE='23505';
    END;
    RETURN public.ui_get_route_stop_reschedule_readback_v1(
      v_source.id,v_proposal.id,v_proposal_event_id);
  END IF;
  IF lower(v_proposal.status) NOT IN ('open','pending','assigned','in_progress')
    OR v_proposal.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_conflict' USING ERRCODE='23505';
  END IF;
  BEGIN
    SELECT t.* INTO STRICT v_source
    FROM public.tasks t JOIN public.task_types st ON st.id=t.task_type_id
    WHERE t.id=(v_proposal.metadata->>'source_task_id')::uuid
      AND t.organization_id=v_org AND st.key='route_stop_execute'
      AND t.resource_type='route_stop'
      AND t.assigned_to=(v_proposal.metadata->>'reported_by_user_id')::uuid
      AND lower(t.status) IN ('open','pending','assigned','in_progress')
      AND t.completed_at IS NULL AND t.canceled_at IS NULL
    FOR UPDATE OF t;
    SELECT * INTO STRICT v_stop FROM public.route_stops_visible_v1 rs
    WHERE rs.id=(v_proposal.metadata->>'route_stop_id')::uuid
      AND rs.id=v_source.resource_id AND rs.organization_id=v_org
      AND rs.shipment_id=v_shipment_id AND v_proposal.resource_id=v_shipment_id;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_conflict' USING ERRCODE='23505';
  END;
  v_amend:=public.shipment_amend_cancel_v1(jsonb_build_object(
    'shipment_id',v_shipment_id,'operation','reschedule','surface','console',
    'slot_date',v_slot_date,
    'idempotency_key','fieldops:route-stop-reschedule:accept:'||v_proposal.id));
  IF COALESCE((v_amend->>'ok')::boolean,FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_failed: %',
      COALESCE(v_amend#>>'{error,code}','shipment_reschedule_failed') USING ERRCODE='55000';
  END IF;
  BEGIN v_action_id:=NULLIF(v_amend->>'shipment_action_id','')::uuid;
  EXCEPTION WHEN others THEN v_action_id:=NULL; END;
  IF v_action_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_missing_action' USING ERRCODE='55000';
  END IF;
  SELECT NULLIF(sa.action_data->>'workflow_run_id','')::uuid INTO v_workflow_run_id
  FROM public.shipment_actions sa
  WHERE sa.id=v_action_id AND sa.shipment_id=v_shipment_id
    AND sa.action_type='delivery_slot_reserved'
    AND sa.action_data->>'slot_date'=v_slot_date::text
    AND sa.action_data->>'idempotency_key'='fieldops:route-stop-reschedule:accept:'||v_proposal.id;
  IF v_workflow_run_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.workflow_runs wr WHERE wr.id=v_workflow_run_id) THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_action_conflict' USING ERRCODE='23505';
  END IF;
  v_prev_claims:=COALESCE(current_setting('request.jwt.claims',true),'');
  v_prev_role:=COALESCE(current_setting('request.jwt.claim.role',true),'');
  v_prev_sub:=COALESCE(current_setting('request.jwt.claim.sub',true),'');
  BEGIN v_claims:=NULLIF(v_prev_claims,'')::jsonb;
  EXCEPTION WHEN others THEN v_claims:='{}'::jsonb; END;
  v_service_claims:=(COALESCE(v_claims,'{}'::jsonb)-'sub')
    ||jsonb_build_object('role','service_role');
  PERFORM set_config('request.jwt.claims',v_service_claims::text,true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  BEGIN
    v_transition:=public.transition_task_system_v1(
      v_proposal.id,'completed','route_stop_reschedule_accepted',
      jsonb_build_object(
        'accepted_by_user_id',v_actor,'proposal_task_id',v_proposal.id,
        'proposal_task_event_id',v_proposal_event_id,'source_task_id',v_source.id,
        'route_stop_id',v_stop.id,'shipment_id',v_shipment_id,'slot_date',v_slot_date,
        'shipment_action_id',v_action_id,'workflow_run_id',v_workflow_run_id),
      'fieldops_route_stop_reschedule',
      'fieldops:route-stop-reschedule:accept:'||v_proposal.id||':accepted');
  EXCEPTION WHEN others THEN
    PERFORM set_config('request.jwt.claims',v_prev_claims,true);
    PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
    PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
    RAISE;
  END;
  PERFORM set_config('request.jwt.claims',v_prev_claims,true);
  PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
  PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
  v_accepted_event_id:=NULLIF(v_transition->>'task_event_id','')::uuid;
  IF v_accepted_event_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_reschedule_accept_missing_completion_event' USING ERRCODE='55000';
  END IF;
  RETURN public.ui_get_route_stop_reschedule_readback_v1(v_source.id,v_proposal.id,v_proposal_event_id);
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_propose_route_stop_reschedule_v1(
  p_action_key TEXT,p_resource_key TEXT,p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$ SELECT public.ui_propose_route_stop_reschedule_v1($1,$2,$3,$4,$5,$6); $function$;

CREATE OR REPLACE FUNCTION api.ui_accept_route_stop_reschedule_v1(
  p_action_key TEXT,p_resource_key TEXT,p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$ SELECT public.ui_accept_route_stop_reschedule_v1($1,$2,$3,$4,$5,$6); $function$;

CREATE OR REPLACE FUNCTION api.ui_get_route_stop_reschedule_readback_v1(
  p_source_task_id UUID,p_proposal_task_id UUID,p_proposal_task_event_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$ SELECT public.ui_get_route_stop_reschedule_readback_v1($1,$2,$3); $function$;

REVOKE ALL ON FUNCTION public.ui_propose_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION api.ui_propose_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ui_accept_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION api.ui_accept_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ui_get_route_stop_reschedule_readback_v1(UUID,UUID,UUID) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION api.ui_get_route_stop_reschedule_readback_v1(UUID,UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ui_propose_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_propose_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_accept_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_accept_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_get_route_stop_reschedule_readback_v1(UUID,UUID,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_get_route_stop_reschedule_readback_v1(UUID,UUID,UUID) TO authenticated;

DO $registry$
DECLARE
  r RECORD;
  v_commands JSONB;
  v_command JSONB;
  v_defs JSONB:=jsonb_build_array(
    jsonb_build_object(
      'key','tasks.propose_route_stop_reschedule','label','Propose reschedule',
      'schema_category','resource:tasks','capability','tasks.complete',
      'selection',jsonb_build_object('mode','single','min_count',1,'max_count',1),
      'available',TRUE,'state','enabled',
      'execution',jsonb_build_object(
        'type','rpc','rpc','ui_propose_route_stop_reschedule_v1',
        'idempotency','actor_retry_v1')),
    jsonb_build_object(
      'key','tasks.accept_route_stop_reschedule','label','Accept reschedule',
      'schema_category','resource:tasks','capability','shipments.write',
      'selection',jsonb_build_object('mode','single','min_count',1,'max_count',1),
      'available',TRUE,'state','enabled',
      'execution',jsonb_build_object(
        'type','rpc','rpc','ui_accept_route_stop_reschedule_v1',
        'idempotency','proposal_task_v1')));
BEGIN
  FOR r IN SELECT s.scope_type,s.scope_id,sv.value,sv.schema_version
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='ui_command_registry'
  LOOP
    v_commands:=COALESCE(r.value->'commands','[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
    FOR v_command IN SELECT value FROM jsonb_array_elements(v_defs) LOOP
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_commands) c
        WHERE c->>'key'=v_command->>'key') THEN
        SELECT jsonb_agg(
          CASE WHEN value->>'key'=v_command->>'key' THEN value||v_command ELSE value END
          ORDER BY ordinality)
        INTO v_commands FROM jsonb_array_elements(v_commands) WITH ORDINALITY;
      ELSE
        v_commands:=v_commands||jsonb_build_array(v_command);
      END IF;
    END LOOP;
    PERFORM public.upsert_settings_value_v1(
      'ui_command_registry',r.scope_type,r.scope_id,
      jsonb_set(r.value,'{commands}',v_commands),r.schema_version,
      'Add canonical route-stop reschedule proposal commands');
  END LOOP;
END;
$registry$;

COMMENT ON FUNCTION public.ui_propose_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB)
  IS 'Creates an actor-bound dispatch reschedule proposal for the assigned active route-stop task.';
COMMENT ON FUNCTION public.ui_accept_route_stop_reschedule_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB)
  IS 'Applies an active proposal through canonical shipment reschedule and records exact task-event association.';

SELECT pg_advisory_unlock(hashtext('20260914004000_fieldops_route_stop_reschedule_v1'));
COMMIT;
