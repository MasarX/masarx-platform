-- F619: canonical returned-to-branch actions and non-terminal route-stop incidents.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260913102000_fieldops_return_actions_route_stop_incident_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Keep incident review row-driven by copying the established dispatch-review defaults.
DO $catalog$
DECLARE
  v_current JSONB;
  v_items JSONB;
  v_base JSONB;
  v_desired JSONB;
  v_next JSONB;
BEGIN
  SELECT s.cached_value INTO v_current
  FROM public.settings s
  WHERE s.category='task_type_catalog' AND s.scope_type='global' AND s.scope_id IS NULL
  FOR UPDATE;
  IF jsonb_typeof(v_current->'task_types') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'fieldops incident requires global task_type_catalog' USING ERRCODE='23514';
  END IF;
  v_items:=v_current->'task_types';
  SELECT value INTO v_base FROM jsonb_array_elements(v_items)
  WHERE value->>'key'='dispatch_exception_review' LIMIT 1;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'fieldops incident requires dispatch_exception_review catalog defaults' USING ERRCODE='23514';
  END IF;
  v_desired:=jsonb_build_object(
    'key','route_stop_incident_review',
    'name','Route Stop Incident Review',
    'description','Review a non-terminal incident reported by the route-stop executor.',
    'default_priority',COALESCE((v_base->>'default_priority')::int,50),
    'default_queue_key',v_base->>'default_queue_key',
    'enabled',TRUE,
    'metadata',jsonb_build_object(
      'assignment_defaults',COALESCE(v_base#>'{metadata,assignment_defaults}','{}'::jsonb),
      'source_task_type_key','route_stop_execute','non_terminal',TRUE));
  SELECT COALESCE(jsonb_agg(
    CASE WHEN value->>'key'='route_stop_incident_review' THEN value||v_desired ELSE value END
    ORDER BY ordinality),'[]'::jsonb)
  INTO v_next FROM jsonb_array_elements(v_items) WITH ORDINALITY;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_items) e WHERE e->>'key'='route_stop_incident_review') THEN
    v_next:=v_next||jsonb_build_array(v_desired);
  END IF;
  IF v_next IS DISTINCT FROM v_items THEN
    PERFORM public.upsert_settings_value_v1(
      'task_type_catalog','global',NULL::uuid,jsonb_set(v_current,'{task_types}',v_next),1,
      'Add route-stop incident review Tasks SSOT type');
  END IF;
END;
$catalog$;

INSERT INTO public.lookup_definitions(category,description,owner_role,approval_policy,is_mutable)
VALUES(
  'route_stop_incident_type',
  'FieldOps non-terminal route-stop incident classifications',
  'operations','tier_1',FALSE)
ON CONFLICT(category) DO NOTHING;

INSERT INTO public.lookup_values(
  lookup_definition_id,value,label,sort_order,is_default,status)
SELECT d.id,v.value,v.label,v.sort_order,v.is_default,'active'
FROM public.lookup_definitions d
JOIN (VALUES
  ('incident','Incident',10,TRUE),('package_damage','Package damage',20,FALSE)
) v(value,label,sort_order,is_default) ON TRUE
WHERE d.category='route_stop_incident_type'
ON CONFLICT(lookup_definition_id,value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ui_execute_return_to_branch_action_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security TO on
AS $function$
DECLARE
  v_scan_id UUID;
  v_actor UUID:=auth.uid();
  v_org UUID:=public.current_user_org_id();
  v_scope_type TEXT:=public.current_user_scope_type();
  v_scope_id UUID:=public.current_user_scope_id();
  v_registry JSONB;
  v_command JSONB;
  v_receipt JSONB;
  v_return public.return_to_branch_shipments_v1%ROWTYPE;
  v_created RECORD;
  v_task public.tasks%ROWTYPE;
  v_review public.tasks%ROWTYPE;
  v_assignee UUID;
  v_claims JSONB;
  v_prev_claims TEXT;
  v_prev_role TEXT;
  v_prev_sub TEXT;
  v_service_claims JSONB;
BEGIN
  IF p_action_key='return_to_branch.otp_pickup_release' THEN
    RAISE EXCEPTION 'otp_issuer_verifier_authority_unavailable' USING ERRCODE='55000';
  ELSIF p_action_key='return_to_branch.discard' THEN
    RAISE EXCEPTION 'physical_discard_custody_finance_policy_unavailable' USING ERRCODE='55000';
  END IF;
  IF v_actor IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'fieldops_return_action_forbidden' USING ERRCODE='42501';
  END IF;
  v_registry:=public.resolve_settings_merged('ui_command_registry',v_scope_type,v_scope_id);
  SELECT value INTO v_command FROM jsonb_array_elements(COALESCE(v_registry->'commands','[]'::jsonb))
  WHERE value->>'key'=p_action_key LIMIT 1;
  IF v_command IS NULL
    OR COALESCE((v_command->>'available')::boolean,FALSE) IS NOT TRUE
    OR v_command->>'capability' IS DISTINCT FROM 'tasks.complete'
    OR v_command#>>'{execution,rpc}' IS DISTINCT FROM 'ui_execute_return_to_branch_action_v1' THEN
    RAISE EXCEPTION 'fieldops_return_action_invalid_command' USING ERRCODE='22023';
  END IF;
  PERFORM public.assert_capability_v1('tasks.complete',v_scope_type,v_scope_id);
  IF p_action_key NOT IN ('return_to_branch.reinduct','return_to_branch.escalate')
    OR p_resource_key IS DISTINCT FROM 'return_to_branch_scan'
    OR COALESCE(p_selection_count,0)<>1
    OR COALESCE(cardinality(p_selection_ids),0)<>1
    OR NULLIF(btrim(COALESCE(p_selection_id,'')),'') IS NULL
    OR p_selection_ids[1] IS DISTINCT FROM p_selection_id THEN
    RAISE EXCEPTION 'fieldops_return_action_invalid_command' USING ERRCODE='22023';
  END IF;
  BEGIN v_scan_id:=p_selection_id::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'fieldops_return_action_invalid_scan' USING ERRCODE='22023';
  END;
  v_receipt:=public.ui_get_return_to_branch_scan_readback_v1(v_scan_id);
  IF v_receipt IS NULL THEN
    RAISE EXCEPTION 'fieldops_return_action_forbidden' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_return FROM public.return_to_branch_shipments_v1 r
  WHERE r.intake_scan_event_id=v_scan_id
    AND r.organization_id=public.current_user_org_id()
    AND r.shipment_id=(v_receipt->>'shipment_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fieldops_return_action_forbidden' USING ERRCODE='42501';
  END IF;

  SELECT t.* INTO v_review
  FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE t.organization_id=v_return.organization_id
    AND t.resource_type='shipment' AND t.resource_id=v_return.shipment_id
    AND tt.key='dispatch_exception_review'
    AND t.metadata->>'return_to_branch_scan_event_id'=v_scan_id::text
    AND lower(t.status) IN ('open','pending','assigned','in_progress')
    AND t.completed_at IS NULL AND t.canceled_at IS NULL
  ORDER BY t.created_at DESC,t.id DESC LIMIT 1;
  IF p_action_key='return_to_branch.reinduct' THEN
    IF NOT FOUND THEN
      RAISE EXCEPTION 'fieldops_return_reinduct_review_required' USING ERRCODE='55000';
    END IF;
    RETURN public.ui_execute_dispatch_exception_resolution_v1(
      'dispatch_exception_review.complete','tasks',
      ARRAY[v_review.id::text],v_review.id::text,1,
      COALESCE(p_params,'{}'::jsonb)||jsonb_build_object('resolution_action','reattempt'));
  END IF;

  IF NOT FOUND THEN
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
      'task_type_key','dispatch_exception_review',
      'resource_type','shipment','resource_id',v_return.shipment_id,
      'idempotency_key','fieldops:return-scan:escalate:'||v_scan_id,
      'actor_system','fieldops_return_action',
      'context',jsonb_strip_nulls(jsonb_build_object(
        'organization_id',v_return.organization_id,'client_id',v_return.client_id,
        'sender_id',v_return.sender_id,'shipment_id',v_return.shipment_id,
        'route_stop_id',v_return.route_stop_id,'branch_id',v_return.branch_id)),
      'metadata',jsonb_strip_nulls(jsonb_build_object(
        'dispatch_exception_reason','other',
        'exception_notes',NULLIF(btrim(COALESCE(p_params->>'summary',p_params->>'statement','')),''),
        'return_to_branch_scan_event_id',v_scan_id,'reported_by_user_id',v_actor,
        'allowed_ndr_actions',jsonb_build_array('reattempt')))));
    EXCEPTION WHEN others THEN
      PERFORM set_config('request.jwt.claims',v_prev_claims,true);
      PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
      PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
      RAISE;
    END;
    PERFORM set_config('request.jwt.claims',v_prev_claims,true);
    PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
    PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
    SELECT t.* INTO STRICT v_review
    FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
    WHERE t.id=v_created.task_id AND tt.key='dispatch_exception_review';
    IF v_review.organization_id IS DISTINCT FROM v_return.organization_id
      OR v_review.resource_type IS DISTINCT FROM 'shipment'
      OR v_review.resource_id IS DISTINCT FROM v_return.shipment_id
      OR v_review.metadata->>'return_to_branch_scan_event_id' IS DISTINCT FROM v_scan_id::text
      OR lower(v_review.status) NOT IN ('open','pending','assigned','in_progress')
      OR v_review.completed_at IS NOT NULL OR v_review.canceled_at IS NOT NULL THEN
      RAISE EXCEPTION 'fieldops_return_escalation_idempotency_conflict' USING ERRCODE='23505';
    END IF;
    IF v_review.assigned_to IS NULL THEN
      v_assignee:=public.resolve_task_assignee_user_v1(
        v_review.organization_id,v_return.branch_id,
        COALESCE(v_review.metadata->'assignment_defaults','{}'::jsonb));
      IF v_assignee IS NOT NULL THEN
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
          PERFORM * FROM public.assign_task_system_v1(
            v_review.id,v_assignee,'fieldops:return-scan:escalate:assign:'||v_scan_id,
            'Assigned from task type defaults','fieldops_return_action');
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
  END IF;
  RETURN jsonb_build_object(
    'status','escalated','scan_event_id',v_scan_id,
    'receipt',public.ui_get_return_to_branch_scan_readback_v1(v_scan_id));
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_execute_return_to_branch_action_v1(
  p_action_key TEXT,p_resource_key TEXT,p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$
  SELECT public.ui_execute_return_to_branch_action_v1($1,$2,$3,$4,$5,$6);
$function$;

CREATE OR REPLACE FUNCTION public.ui_get_route_stop_incident_readback_v1(
  p_source_task_id UUID,p_incident_task_id UUID,p_incident_task_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security TO on
AS $function$
DECLARE
  v_actor UUID:=auth.uid();
  v_org UUID:=public.current_user_org_id();
  v_result JSONB;
BEGIN
  IF v_actor IS NULL OR v_org IS NULL
    OR public.ui_get_resource_v1('tasks',p_source_task_id) IS NULL THEN
    RAISE EXCEPTION 'route_stop_incident_readback_forbidden' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object(
    'source_task',jsonb_build_object('id',src.id,'status',src.status),
    'incident_task',jsonb_build_object(
      'id',incident.id,'status',incident.status,'assigned_to',incident.assigned_to,
      'queue_key',incident.queue_key,'task_event_id',ev.id),
    'incident',jsonb_build_object(
      'type',ev.payload->>'incident_type','summary',ev.payload->>'summary',
      'artifact_ids',ev.payload->'artifact_ids','reported_by_user_id',ev.actor_user_id),
    'route_stop_id',rs.id,'route_run_id',rs.route_run_id,'shipment_id',rs.shipment_id)
  INTO v_result
  FROM public.tasks src
  JOIN public.tasks incident ON incident.id=p_incident_task_id
    AND incident.organization_id=src.organization_id
    AND incident.resource_type='route_stop' AND incident.resource_id=src.resource_id
    AND incident.metadata->>'source_task_id'=src.id::text
    AND incident.metadata->>'reported_by_user_id'=v_actor::text
  JOIN public.task_types it ON it.id=incident.task_type_id AND it.key='route_stop_incident_review'
  JOIN public.task_events ev ON ev.id=p_incident_task_event_id
    AND ev.task_id=incident.id AND ev.organization_id=incident.organization_id
    AND ev.event_type='incident_reported' AND ev.actor_user_id=v_actor
  JOIN public.route_stops_visible_v1 rs ON rs.id=src.resource_id
    AND rs.organization_id=src.organization_id
    AND (src.client_id IS NULL OR rs.client_id=src.client_id)
  WHERE src.id=p_source_task_id AND src.organization_id=v_org AND src.resource_type='route_stop'
    AND EXISTS(SELECT 1 FROM public.artifact_links al
      WHERE al.organization_id=v_org AND al.resource_type='task_event'
        AND al.resource_id=ev.id AND al.relation_type='incident_evidence');
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'route_stop_incident_readback_forbidden' USING ERRCODE='42501';
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_report_route_stop_incident_v1(
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
  v_incident_type TEXT:=lower(NULLIF(btrim(COALESCE(p_params->>'incident_type','')),''));
  v_summary TEXT:=NULLIF(btrim(COALESCE(p_params->>'summary',p_params->>'statement','')),'');
  v_retry TEXT:=NULLIF(btrim(COALESCE(p_params->>'retry_key','')),'');
  v_artifact_ids UUID[];
  v_key TEXT;
  v_created RECORD;
  v_incident public.tasks%ROWTYPE;
  v_event_id UUID;
  v_assignee UUID;
  v_claims JSONB;
  v_prev_claims TEXT;
  v_prev_role TEXT;
  v_prev_sub TEXT;
  v_service_claims JSONB;
BEGIN
  IF v_actor IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'route_stop_incident_forbidden' USING ERRCODE='42501';
  END IF;
  v_registry:=public.resolve_settings_merged('ui_command_registry',v_scope_type,v_scope_id);
  SELECT value INTO v_command FROM jsonb_array_elements(COALESCE(v_registry->'commands','[]'::jsonb))
  WHERE value->>'key'=p_action_key LIMIT 1;
  IF v_command IS NULL
    OR COALESCE((v_command->>'available')::boolean,FALSE) IS NOT TRUE
    OR v_command->>'capability' IS DISTINCT FROM 'tasks.complete'
    OR v_command#>>'{execution,rpc}' IS DISTINCT FROM 'ui_report_route_stop_incident_v1' THEN
    RAISE EXCEPTION 'route_stop_incident_invalid_command' USING ERRCODE='22023';
  END IF;
  PERFORM public.assert_capability_v1('tasks.complete',v_scope_type,v_scope_id);
  IF p_action_key IS DISTINCT FROM 'tasks.report_incident'
    OR p_resource_key IS DISTINCT FROM 'tasks'
    OR COALESCE(p_selection_count,0)<>1
    OR COALESCE(cardinality(p_selection_ids),0)<>1
    OR NULLIF(btrim(COALESCE(p_selection_id,'')),'') IS NULL
    OR p_selection_ids[1] IS DISTINCT FROM p_selection_id
    OR jsonb_typeof(COALESCE(p_params,'{}'::jsonb)) IS DISTINCT FROM 'object'
    OR v_summary IS NULL OR v_retry IS NULL OR length(v_retry)>200
    OR jsonb_typeof(COALESCE(p_params->'artifact_ids','null'::jsonb)) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_params->'artifact_ids')=0 THEN
    RAISE EXCEPTION 'route_stop_incident_invalid_request' USING ERRCODE='22023';
  END IF;
  IF v_incident_type IS NULL
    OR public.is_active_lookup_value_v1('route_stop_incident_type',v_incident_type,TRUE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'route_stop_incident_invalid_type' USING ERRCODE='22023';
  END IF;
  BEGIN
    v_source_task_id:=p_selection_id::uuid;
    SELECT array_agg(DISTINCT value::uuid ORDER BY value::uuid) INTO v_artifact_ids
    FROM jsonb_array_elements_text(p_params->'artifact_ids');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'route_stop_incident_invalid_request' USING ERRCODE='22023';
  END;
  IF cardinality(v_artifact_ids) IS DISTINCT FROM jsonb_array_length(p_params->'artifact_ids')
    OR (SELECT count(*) FROM public.artifacts a
      WHERE a.id=ANY(v_artifact_ids) AND a.organization_id=v_org
        AND a.created_by_user_id=v_actor AND a.storage_bucket='fieldops-evidence')
       <>cardinality(v_artifact_ids) THEN
    RAISE EXCEPTION 'route_stop_incident_artifact_forbidden' USING ERRCODE='42501';
  END IF;
  IF public.ui_get_resource_v1('tasks',v_source_task_id) IS NULL THEN
    RAISE EXCEPTION 'route_stop_incident_forbidden' USING ERRCODE='42501';
  END IF;
  SELECT t.* INTO v_source
  FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE t.id=v_source_task_id AND t.organization_id=v_org
    AND tt.key='route_stop_execute' AND t.resource_type='route_stop'
    AND t.assigned_to=v_actor AND lower(t.status) IN ('open','pending','assigned','in_progress')
    AND t.completed_at IS NULL AND t.canceled_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'route_stop_incident_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_stop FROM public.route_stops_visible_v1 rs
  WHERE rs.id=v_source.resource_id AND rs.organization_id=v_org
    AND (v_source.client_id IS NULL OR rs.client_id=v_source.client_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'route_stop_incident_forbidden' USING ERRCODE='42501'; END IF;

  v_key:='fieldops:route-stop-incident:'||v_actor||':'||v_retry;
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
    'task_type_key','route_stop_incident_review',
    'resource_type','route_stop','resource_id',v_stop.id,
    'idempotency_key',v_key,'actor_system','fieldops_route_stop_incident',
    'context',jsonb_strip_nulls(jsonb_build_object(
      'organization_id',v_org,'client_id',v_source.client_id,'sender_id',v_source.sender_id,
      'route_stop_id',v_stop.id,'route_run_id',v_stop.route_run_id,
      'shipment_id',v_stop.shipment_id,'branch_id',v_stop.branch_id)),
    'metadata',jsonb_build_object(
      'source_task_id',v_source.id,'reported_by_user_id',v_actor,
      'incident_type',v_incident_type,'summary',v_summary,
      'evidence_artifact_ids',to_jsonb(v_artifact_ids),
      'route_stop_id',v_stop.id,'route_run_id',v_stop.route_run_id,
      'shipment_id',v_stop.shipment_id,'non_terminal',TRUE)));
  EXCEPTION WHEN others THEN
    PERFORM set_config('request.jwt.claims',v_prev_claims,true);
    PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
    PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
    RAISE;
  END;
  PERFORM set_config('request.jwt.claims',v_prev_claims,true);
  PERFORM set_config('request.jwt.claim.role',v_prev_role,true);
  PERFORM set_config('request.jwt.claim.sub',v_prev_sub,true);
  SELECT * INTO STRICT v_incident FROM public.tasks WHERE id=v_created.task_id FOR UPDATE;
  IF v_incident.organization_id IS DISTINCT FROM v_org
    OR v_incident.resource_id IS DISTINCT FROM v_stop.id
    OR v_incident.metadata->>'source_task_id' IS DISTINCT FROM v_source.id::text
    OR v_incident.metadata->>'reported_by_user_id' IS DISTINCT FROM v_actor::text
    OR v_incident.metadata->>'incident_type' IS DISTINCT FROM v_incident_type
    OR v_incident.metadata->>'summary' IS DISTINCT FROM v_summary
    OR v_incident.metadata->'evidence_artifact_ids' IS DISTINCT FROM to_jsonb(v_artifact_ids) THEN
    RAISE EXCEPTION 'route_stop_incident_idempotency_conflict' USING ERRCODE='23505';
  END IF;
  SELECT te.id INTO v_event_id FROM public.task_events te
  WHERE te.task_id=v_incident.id AND te.event_type='incident_reported'
    AND te.actor_user_id=v_actor AND te.idempotency_key=v_key||':reported';
  IF v_event_id IS NULL THEN
    UPDATE public.tasks SET version=version+1,updated_at=now()
    WHERE id=v_incident.id RETURNING version INTO v_incident.version;
    INSERT INTO public.task_events(
      task_id,organization_id,event_type,from_status,to_status,actor_user_id,
      actor_system,payload,idempotency_key,task_version,created_at)
    VALUES(
      v_incident.id,v_org,'incident_reported',v_incident.status,v_incident.status,v_actor,
      'fieldops_route_stop_incident',
      jsonb_build_object(
        'source_task_id',v_source.id,'route_stop_id',v_stop.id,'route_run_id',v_stop.route_run_id,
        'shipment_id',v_stop.shipment_id,'incident_type',v_incident_type,'summary',v_summary,
        'artifact_ids',to_jsonb(v_artifact_ids),'reporter_user_id',v_actor),
      v_key||':reported',v_incident.version,now())
    RETURNING id INTO v_event_id;
    INSERT INTO public.artifact_links(
      organization_id,artifact_id,resource_type,resource_id,relation_type)
    SELECT v_org,id,'task_event',v_event_id,'incident_evidence'
    FROM unnest(v_artifact_ids) id ON CONFLICT DO NOTHING;
  END IF;
  IF v_incident.assigned_to IS NULL THEN
    v_assignee:=public.resolve_task_assignee_user_v1(
      v_org,v_stop.branch_id,COALESCE(v_incident.metadata->'assignment_defaults','{}'::jsonb));
    IF v_assignee IS NOT NULL THEN
      PERFORM set_config('request.jwt.claims',v_service_claims::text,true);
      PERFORM set_config('request.jwt.claim.role','service_role',true);
      PERFORM set_config('request.jwt.claim.sub','',true);
      BEGIN
        PERFORM * FROM public.assign_task_system_v1(
          v_incident.id,v_assignee,v_key||':assign',
          'Assigned from task type defaults','fieldops_route_stop_incident');
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
  RETURN public.ui_get_route_stop_incident_readback_v1(v_source.id,v_incident.id,v_event_id);
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_report_route_stop_incident_v1(
  p_action_key TEXT,p_resource_key TEXT,p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$ SELECT public.ui_report_route_stop_incident_v1($1,$2,$3,$4,$5,$6); $function$;

CREATE OR REPLACE FUNCTION api.ui_get_route_stop_incident_readback_v1(
  p_source_task_id UUID,p_incident_task_id UUID,p_incident_task_event_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$ SELECT public.ui_get_route_stop_incident_readback_v1($1,$2,$3); $function$;

REVOKE ALL ON FUNCTION public.ui_execute_return_to_branch_action_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION api.ui_execute_return_to_branch_action_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ui_report_route_stop_incident_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION api.ui_report_route_stop_incident_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ui_get_route_stop_incident_readback_v1(UUID,UUID,UUID) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION api.ui_get_route_stop_incident_readback_v1(UUID,UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_return_to_branch_action_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_execute_return_to_branch_action_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_report_route_stop_incident_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_report_route_stop_incident_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_get_route_stop_incident_readback_v1(UUID,UUID,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_get_route_stop_incident_readback_v1(UUID,UUID,UUID) TO authenticated;

DO $registry$
DECLARE
  r RECORD;
  v_commands JSONB;
  v_command JSONB;
  v_defs JSONB:=jsonb_build_array(
    jsonb_build_object('key','return_to_branch.reinduct','label','Reinduct for reattempt',
      'schema_category','resource:return_to_branch_scan','capability','tasks.complete',
      'selection',jsonb_build_object('mode','single','min_count',1,'max_count',1),
      'available',TRUE,'state','enabled',
      'execution',jsonb_build_object('type','rpc','rpc','ui_execute_return_to_branch_action_v1')),
    jsonb_build_object('key','return_to_branch.escalate','label','Escalate for review',
      'schema_category','resource:return_to_branch_scan','capability','tasks.complete',
      'selection',jsonb_build_object('mode','single','min_count',1,'max_count',1),
      'available',TRUE,'state','enabled',
      'execution',jsonb_build_object('type','rpc','rpc','ui_execute_return_to_branch_action_v1')),
    jsonb_build_object('key','return_to_branch.otp_pickup_release','label','Release with OTP',
      'schema_category','resource:return_to_branch_scan','capability','tasks.complete',
      'selection',jsonb_build_object('mode','single','min_count',1,'max_count',1),
      'available',FALSE,'state','disabled',
      'reason','otp_issuer_verifier_authority_unavailable',
      'disabled_reason','otp_issuer_verifier_authority_unavailable'),
    jsonb_build_object('key','return_to_branch.discard','label','Discard shipment',
      'schema_category','resource:return_to_branch_scan','capability','tasks.complete',
      'selection',jsonb_build_object('mode','single','min_count',1,'max_count',1),
      'available',FALSE,'state','disabled',
      'reason','physical_discard_custody_finance_policy_unavailable',
      'disabled_reason','physical_discard_custody_finance_policy_unavailable'),
    jsonb_build_object('key','tasks.report_incident','label','Report incident',
      'schema_category','resource:tasks','capability','tasks.complete',
      'selection',jsonb_build_object('mode','single','min_count',1,'max_count',1),
      'available',TRUE,'state','enabled',
      'execution',jsonb_build_object(
        'type','rpc','rpc','ui_report_route_stop_incident_v1',
        'idempotency','actor_retry_v1',
        'evidence',jsonb_build_object('bucket','fieldops-evidence','min_items',1))));
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
      'Add canonical FieldOps return and route-stop incident actions');
  END LOOP;
END;
$registry$;

COMMENT ON FUNCTION public.ui_execute_return_to_branch_action_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB)
  IS 'Executes actor-owned return scan reinduct/escalate actions; unavailable custody actions fail before DML.';
COMMENT ON FUNCTION public.ui_report_route_stop_incident_v1(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB)
  IS 'Creates an actor-bound non-terminal route-stop incident review task with owned evidence.';

SELECT pg_advisory_unlock(hashtext('20260913102000_fieldops_return_actions_route_stop_incident_v1'));
COMMIT;
