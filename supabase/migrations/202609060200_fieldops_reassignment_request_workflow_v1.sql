-- Driver requests are immutable intent; only the canonical operator UC078 path moves stops.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('202609060200_fieldops_reassignment_request_workflow_v1'));
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE TABLE public.fieldops_reassignment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  client_id UUID,
  shipment_id UUID,
  route_stop_id UUID NOT NULL,
  source_route_run_id UUID NOT NULL,
  source_assignment_id UUID NOT NULL,
  source_assignment_version INT NOT NULL,
  target_driver_user_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  decision_log_id UUID,
  dispatch_id UUID,
  workflow_run_id UUID,
  dispatch_task_id UUID,
  completed_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, idempotency_key),
  UNIQUE (dispatch_task_id)
);
ALTER TABLE public.fieldops_reassignment_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fieldops_reassignment_requests FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX fieldops_reassignment_requests_stop_source_idx
  ON public.fieldops_reassignment_requests (route_stop_id, source_assignment_id)
  WHERE completed_event_id IS NULL;

INSERT INTO public.table_contracts
  (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES ('public', 'fieldops_reassignment_requests', TRUE, TRUE, TRUE,
  'Private immutable driver intent and exact workflow/task/event linkage; not a work queue.');
INSERT INTO public.audit_redaction_rules (table_schema, table_name, mode, columns, redaction_token)
VALUES ('public', 'fieldops_reassignment_requests', 'denylist', ARRAY['reason','idempotency_key'], '[REDACTED]');
SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

-- Private read authority reused by preparation and candidate lookup. Never trusts a caller org.
CREATE OR REPLACE FUNCTION public.fieldops_reassignment_source_v1(p_stop_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE v_actor UUID := auth.uid(); v_org UUID := public.current_user_org_id(); v_source JSONB;
BEGIN
  IF v_actor IS NULL OR v_org IS NULL OR NOT public.user_has_resource_capability_v1(
    'routes', 'read', public.current_user_scope_type(), COALESCE(public.current_user_scope_id(), v_org)) THEN
    RAISE EXCEPTION 'fieldops_reassignment_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object('organization_id', rs.organization_id, 'client_id', rs.client_id,
    'shipment_id', rs.shipment_id, 'route_stop_id', rs.id, 'source_route_run_id', rr.id,
    'source_assignment_id', a.id, 'source_assignment_version', a.assignment_version, 'actor_user_id', v_actor)
  INTO v_source
  FROM public.route_stops rs
  JOIN public.route_runs rr ON rr.id = rs.route_run_id AND rr.organization_id = rs.organization_id
  JOIN LATERAL (
    SELECT rra.* FROM public.route_run_assignments rra
    WHERE rra.route_run_id = rr.id AND rra.organization_id = rr.organization_id
    ORDER BY rra.created_at DESC, rra.id DESC LIMIT 1
  ) a ON TRUE
  WHERE rs.id = p_stop_id AND rs.organization_id = v_org
    AND rr.driver_user_id = v_actor AND a.driver_user_id = v_actor
    AND lower(a.assignment_status) NOT IN ('cancelled','canceled','completed','refused')
    AND lower(rr.status) NOT IN ('cancelled','canceled','completed')
    AND COALESCE(lower(rs.metadata#>>'{execution,outcome}'),'') NOT IN ('completed','canceled','cancelled','failed','exception','skipped')
    AND NOT EXISTS (SELECT 1 FROM public.shipment_actions sa WHERE sa.organization_id = rs.organization_id
      AND sa.shipment_id = rs.shipment_id AND sa.action_data->>'route_stop_id' = rs.id::text)
    AND NULLIF(btrim(COALESCE(rs.metadata->>'shipment_action','')), '') IS NULL
    AND EXISTS (SELECT 1 FROM (
      SELECT t.* FROM public.tasks t JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE tt.organization_id = rs.organization_id AND tt.key = 'route_stop_execute'
        AND t.resource_type = 'route_stop' AND t.resource_id = rs.id
      ORDER BY t.created_at DESC, t.id DESC LIMIT 1
    ) t WHERE t.organization_id = rs.organization_id AND t.assigned_to = v_actor
      AND lower(t.status) IN ('open','pending','assigned','in_progress')
      AND t.completed_at IS NULL AND t.canceled_at IS NULL)
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_actor
      AND u.organization_id = v_org AND lower(u.status) = 'active');
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'fieldops_reassignment_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN v_source;
END;
$function$;
REVOKE ALL ON FUNCTION public.fieldops_reassignment_source_v1(UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fieldops_reassignment_candidates_v1(p_stop_id UUID)
RETURNS TABLE(value TEXT, label TEXT, description TEXT, metadata JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE v_source JSONB := public.fieldops_reassignment_source_v1(p_stop_id);
BEGIN
  RETURN QUERY
  SELECT u.id::text,
    COALESCE(NULLIF(btrim(u.full_name),''), NULLIF(btrim(u.email),''), dp.driver_code, u.id::text),
    concat_ws(' · ',
      CASE WHEN jsonb_typeof(dp.metadata->'capacity_left') = 'number'
        THEN GREATEST(0, (dp.metadata->>'capacity_left')::numeric)::text || ' capacity left' END,
      CASE WHEN jsonb_typeof(dp.metadata->'reassign_eta_min') = 'number'
        THEN GREATEST(0, (dp.metadata->>'reassign_eta_min')::numeric)::text || ' min' END,
      CASE WHEN jsonb_typeof(dp.metadata->'reassign_distance_km') = 'number'
        THEN GREATEST(0, (dp.metadata->>'reassign_distance_km')::numeric)::text || ' km' END),
    jsonb_strip_nulls(jsonb_build_object('driver_user_id', u.id, 'driver_profile_id', dp.id,
      'driver_code', dp.driver_code,
      'capacity_left', CASE WHEN jsonb_typeof(dp.metadata->'capacity_left') = 'number'
        THEN GREATEST(0, (dp.metadata->>'capacity_left')::numeric) END,
      'eta_min', CASE WHEN jsonb_typeof(dp.metadata->'reassign_eta_min') = 'number'
        THEN GREATEST(0, (dp.metadata->>'reassign_eta_min')::numeric) END,
      'distance_km', CASE WHEN jsonb_typeof(dp.metadata->'reassign_distance_km') = 'number'
        THEN GREATEST(0, (dp.metadata->>'reassign_distance_km')::numeric) END))
  FROM public.driver_profiles dp
  JOIN public.users u ON u.id = dp.user_id AND u.organization_id = dp.organization_id
  WHERE dp.organization_id = (v_source->>'organization_id')::uuid
    AND u.id <> auth.uid() AND lower(dp.status) = 'active' AND lower(u.status) = 'active'
  ORDER BY COALESCE(NULLIF(btrim(u.full_name),''), NULLIF(btrim(u.email),''), dp.driver_code, u.id::text), u.id
  LIMIT 8; -- Preserve the selected source's bounded candidate projection.
END;
$function$;

CREATE OR REPLACE FUNCTION public.prepare_fieldops_reassignment_v1(
  p_stop_id UUID, p_target_driver_id UUID, p_reason TEXT, p_idempotency_key TEXT,
  p_expected_actor_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor UUID := auth.uid(); v_org UUID := public.current_user_org_id();
  v_reason TEXT := btrim(p_reason); v_source JSONB; v_route UUID;
  v_request public.fieldops_reassignment_requests%ROWTYPE;
BEGIN
  -- The expected actor is only a replay guard, never an authority source.
  IF v_actor IS NULL OR v_org IS NULL OR p_expected_actor_user_id IS DISTINCT FROM v_actor
    OR NOT public.user_has_resource_capability_v1('routes','read',public.current_user_scope_type(),COALESCE(public.current_user_scope_id(),v_org))
    OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_actor AND u.organization_id = v_org AND lower(u.status) = 'active') THEN
    RAISE EXCEPTION 'fieldops_reassignment_forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_stop_id IS NULL OR p_target_driver_id IS NULL OR p_target_driver_id = v_actor
    OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 2000
    OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'fieldops_reassignment_invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_request FROM public.fieldops_reassignment_requests
    WHERE actor_user_id = v_actor AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_request.organization_id IS DISTINCT FROM v_org OR v_request.route_stop_id IS DISTINCT FROM p_stop_id
      OR v_request.target_driver_user_id IS DISTINCT FROM p_target_driver_id OR v_request.reason IS DISTINCT FROM v_reason THEN
      RAISE EXCEPTION 'fieldops_reassignment_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('request_id', v_request.id);
  END IF;
  v_source := public.fieldops_reassignment_source_v1(p_stop_id);
  v_route := (v_source->>'source_route_run_id')::uuid;
  -- Match UC078's route -> stop -> request -> review-task ordering.
  PERFORM 1 FROM public.route_runs WHERE id = v_route FOR UPDATE;
  PERFORM 1 FROM public.route_stops WHERE id = p_stop_id AND route_run_id = v_route FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fieldops_reassignment_source_changed' USING ERRCODE = '55000'; END IF;
  v_source := public.fieldops_reassignment_source_v1(p_stop_id);
  IF NOT EXISTS (SELECT 1 FROM public.driver_profiles dp JOIN public.users u
      ON u.id = dp.user_id AND u.organization_id = dp.organization_id
    WHERE u.id = p_target_driver_id AND u.organization_id = v_org
      AND lower(u.status) = 'active' AND lower(dp.status) = 'active') THEN
    RAISE EXCEPTION 'fieldops_reassignment_target_unavailable' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.fieldops_reassignment_requests
    (organization_id, actor_user_id, client_id, shipment_id, route_stop_id,
     source_route_run_id, source_assignment_id, source_assignment_version, target_driver_user_id, reason, idempotency_key)
  VALUES (v_org, v_actor, (v_source->>'client_id')::uuid, (v_source->>'shipment_id')::uuid,
    p_stop_id, v_route, (v_source->>'source_assignment_id')::uuid, (v_source->>'source_assignment_version')::int, p_target_driver_id, v_reason, p_idempotency_key)
  ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING;
  SELECT * INTO STRICT v_request FROM public.fieldops_reassignment_requests
    WHERE actor_user_id = v_actor AND idempotency_key = p_idempotency_key;
  IF v_request.organization_id IS DISTINCT FROM v_org OR v_request.route_stop_id IS DISTINCT FROM p_stop_id
    OR v_request.source_route_run_id IS DISTINCT FROM v_route
    OR v_request.source_assignment_id IS DISTINCT FROM (v_source->>'source_assignment_id')::uuid
    OR v_request.source_assignment_version IS DISTINCT FROM (v_source->>'source_assignment_version')::int
    OR v_request.target_driver_user_id IS DISTINCT FROM p_target_driver_id OR v_request.reason IS DISTINCT FROM v_reason THEN
    RAISE EXCEPTION 'fieldops_reassignment_idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object('request_id', v_request.id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_fieldops_reassignment_v1(p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  r public.fieldops_reassignment_requests%ROWTYPE;
  v_dispatch JSONB; v_task UUID; v_run UUID; v_dispatch_id UUID; v_decision UUID; v_assignment UUID; v_assignment_version INT;
  v_actor_type TEXT; v_actor_scope TEXT; v_actor_scope_id UUID; v_actor_policy JSONB; v_actor_allowed BOOLEAN;
BEGIN
  IF COALESCE(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION 'fieldops_reassignment_service_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.fieldops_reassignment_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'fieldops_reassignment_request_missing' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.route_runs WHERE id = r.source_route_run_id FOR UPDATE;
  PERFORM 1 FROM public.route_stops WHERE id = r.route_stop_id FOR UPDATE;
  SELECT * INTO STRICT r FROM public.fieldops_reassignment_requests WHERE id = p_request_id FOR UPDATE;
  PERFORM set_config('request.correlation_id', r.id::text, TRUE);
  IF r.dispatch_task_id IS NULL THEN
    -- Service is the transport, not the authorization subject. Re-evaluate the
    -- immutable actor against current policy without modifying any JWT claims.
    SELECT u.user_type, NULLIF(btrim(lower(u.access_scope_type)),''),
      CASE WHEN u.access_scope_type='tenant' THEN COALESCE(u.access_scope_id,u.organization_id)
        ELSE u.access_scope_id END
    INTO v_actor_type, v_actor_scope, v_actor_scope_id
    FROM public.users u JOIN public.organizations o ON o.id=u.organization_id
    WHERE u.id=r.actor_user_id AND u.organization_id=r.organization_id
      AND lower(u.status)='active' AND lower(COALESCE(o.billing_status,'active'))<>'suspended';
    IF NOT FOUND OR v_actor_scope IS NULL OR NULLIF(btrim(v_actor_type),'') IS NULL
      OR (v_actor_scope<>'platform' AND v_actor_scope_id IS NULL) THEN
      RAISE EXCEPTION 'fieldops_reassignment_actor_forbidden' USING ERRCODE='42501';
    END IF;
    IF v_actor_scope='platform' THEN v_actor_scope:='global'; v_actor_scope_id:=NULL; END IF;
    SELECT policy INTO v_actor_policy FROM public.resolve_access_control_policy_v1(
      CASE WHEN v_actor_scope='global' THEN 'platform' ELSE v_actor_scope END, v_actor_scope_id, FALSE) LIMIT 1;
    SELECT allowed INTO v_actor_allowed FROM public.access_eval_capability_v1(v_actor_policy,
      COALESCE(v_actor_policy#>>'{resource_map,routes,read}','routes.read'),
      v_actor_scope,v_actor_scope_id,r.actor_user_id,v_actor_type);
    IF v_actor_allowed IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'fieldops_reassignment_actor_forbidden' USING ERRCODE='42501';
    END IF;
    SELECT a.id, a.assignment_version INTO v_assignment, v_assignment_version FROM public.route_run_assignments a
      WHERE a.route_run_id = r.source_route_run_id AND a.organization_id = r.organization_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
    IF v_assignment IS DISTINCT FROM r.source_assignment_id OR v_assignment_version IS DISTINCT FROM r.source_assignment_version OR NOT EXISTS (
      SELECT 1 FROM public.route_stops rs JOIN public.route_runs rr ON rr.id = rs.route_run_id
      JOIN public.route_run_assignments a ON a.id = r.source_assignment_id
      WHERE rs.id = r.route_stop_id AND rs.route_run_id = r.source_route_run_id
        AND rs.organization_id = r.organization_id AND rr.organization_id = r.organization_id
        AND rs.client_id IS NOT DISTINCT FROM r.client_id AND rs.shipment_id IS NOT DISTINCT FROM r.shipment_id
        AND rr.driver_user_id = r.actor_user_id AND a.driver_user_id = r.actor_user_id
        AND lower(a.assignment_status) NOT IN ('completed','canceled','cancelled','refused')
        AND lower(rr.status) NOT IN ('completed','canceled','cancelled')
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = r.actor_user_id
          AND u.organization_id = r.organization_id AND lower(u.status) = 'active')
    AND COALESCE(lower(rs.metadata#>>'{execution,outcome}'),'') NOT IN ('completed','canceled','cancelled','failed','exception','skipped')
    AND NOT EXISTS (SELECT 1 FROM public.shipment_actions sa WHERE sa.organization_id = rs.organization_id
      AND sa.shipment_id = rs.shipment_id AND sa.action_data->>'route_stop_id' = rs.id::text)
    AND NULLIF(btrim(COALESCE(rs.metadata->>'shipment_action','')), '') IS NULL
    AND EXISTS (SELECT 1 FROM (
      SELECT t.* FROM public.tasks t JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE tt.organization_id = rs.organization_id AND tt.key = 'route_stop_execute'
        AND t.resource_type = 'route_stop' AND t.resource_id = rs.id
      ORDER BY t.created_at DESC, t.id DESC LIMIT 1
    ) t WHERE t.organization_id = rs.organization_id AND t.assigned_to = r.actor_user_id
      AND lower(t.status) IN ('open','pending','assigned','in_progress')
      AND t.completed_at IS NULL AND t.canceled_at IS NULL)
    ) OR NOT EXISTS (
      SELECT 1 FROM public.driver_profiles dp JOIN public.users u ON u.id = dp.user_id
      WHERE dp.organization_id = r.organization_id AND u.organization_id = r.organization_id
        AND dp.user_id = r.target_driver_user_id AND lower(dp.status) = 'active' AND lower(u.status) = 'active'
    ) THEN
      RAISE EXCEPTION 'fieldops_reassignment_source_or_target_changed' USING ERRCODE = '55000';
    END IF;
    v_decision := public.log_decision(
      p_organization_id := r.organization_id, p_decision_category := 'dispatch',
      p_resource_type := 'route_stop', p_resource_id := r.route_stop_id,
      p_decision_point := 'fieldops_reassignment_request', p_decision_outcome := 'requested',
      p_performed_by_system := 'fieldops-reassignment-request', p_correlation_id := r.id,
      p_decision_inputs := jsonb_build_object('request_id', r.id, 'actor_user_id', r.actor_user_id,
        'source_assignment_id', r.source_assignment_id, 'target_driver_user_id', r.target_driver_user_id),
      p_decision_reason := NULL, p_settings_resolution_id := NULL);
    v_dispatch := public.run_workflow_binding_stage_v1(jsonb_build_object(
      'binding_key', 'fieldops_reassignment', 'stage_key', 'review_requested',
      'organization_id', r.organization_id, 'client_id', r.client_id,
      'resource_type', 'route_stop', 'resource_id', r.route_stop_id,
      'actor_user_id', r.actor_user_id, 'actor_system', 'fieldops-reassignment-request',
      'source_function', 'submit_fieldops_reassignment_v1',
      'idempotency_key', 'fieldops-reassignment:' || r.id,
      'context', jsonb_build_object('correlation_id', r.id, 'binding_payload', jsonb_build_object('task',
        jsonb_build_object('task_type_key', 'dispatch_exception_review',
          'organization_id', r.organization_id, 'resource_type', 'route_stop', 'resource_id', r.route_stop_id,
          'idempotency_key', 'fieldops-reassignment:' || r.id,
          'context', jsonb_strip_nulls(jsonb_build_object('organization_id', r.organization_id,
            'client_id', r.client_id, 'route_run_id', r.source_route_run_id,
            'route_stop_id', r.route_stop_id, 'shipment_id', r.shipment_id)),
          'metadata', jsonb_build_object('fieldops_reassignment_request_id', r.id, 'correlation_id', r.id,
            'decision_log_id', v_decision, 'source_assignment_id', r.source_assignment_id,
            'source_assignment_version', r.source_assignment_version,
            'source_route_run_id', r.source_route_run_id, 'target_driver_user_id', r.target_driver_user_id,
            'requested_by_user_id', r.actor_user_id, 'reason', r.reason,
            'dispatch_exception_reason', 'driver_reassignment_request',
            'resolution_action', 'route_stops.reassign', 'allowed_ndr_actions', jsonb_build_array()))))));
    v_dispatch_id := NULLIF(v_dispatch->>'dispatch_id','')::uuid;
    v_run := NULLIF(v_dispatch->>'workflow_run_id','')::uuid;
    v_task := NULLIF(v_dispatch#>>'{step_operation_result,task_id}','')::uuid;
    IF v_dispatch->>'ok' IS DISTINCT FROM 'true' OR v_dispatch->>'outcome' IS DISTINCT FROM 'completed'
      OR v_task IS NULL OR v_run IS NULL OR v_dispatch_id IS NULL THEN
      RAISE EXCEPTION 'fieldops_reassignment_dispatch_incomplete' USING ERRCODE = '55000';
    END IF;
    UPDATE public.fieldops_reassignment_requests SET decision_log_id = v_decision,
      dispatch_id = v_dispatch_id, workflow_run_id = v_run, dispatch_task_id = v_task, updated_at = now()
      WHERE id = r.id RETURNING * INTO r;
  END IF;
  -- Cached dispatcher output and task metadata alone are not success evidence.
  IF NOT EXISTS (SELECT 1 FROM public.workflow_binding_dispatches d
    WHERE d.id = r.dispatch_id AND d.workflow_run_id = r.workflow_run_id
      AND d.binding_key = 'fieldops_reassignment' AND d.stage_key = 'review_requested'
      AND d.organization_id = r.organization_id AND d.resource_type = 'route_stop'
      AND d.resource_id = r.route_stop_id AND d.outcome = 'completed'
      AND d.idempotency_key = 'fieldops-reassignment:' || r.id)
    OR NOT EXISTS (SELECT 1 FROM public.tasks t JOIN public.task_types tt ON tt.id = t.task_type_id
    WHERE t.id = r.dispatch_task_id AND t.organization_id = r.organization_id
      AND tt.organization_id = r.organization_id AND tt.key = 'dispatch_exception_review'
      AND t.resource_type = 'route_stop' AND t.resource_id = r.route_stop_id
      AND t.idempotency_key = 'fieldops-reassignment:' || r.id
      AND t.metadata->>'fieldops_reassignment_request_id' = r.id::text
      AND t.metadata->>'parent_workflow_run_id' = r.workflow_run_id::text) THEN
    RAISE EXCEPTION 'fieldops_reassignment_dispatch_incomplete' USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('ok', TRUE, 'request_id', r.id, 'dispatch_task_id', r.dispatch_task_id,
    'workflow_run_id', r.workflow_run_id, 'dispatch_id', r.dispatch_id, 'decision_log_id', r.decision_log_id);
END;
$function$;

-- This is an intentional, private owner-privilege deputy, NOT a service JWT.
-- Authenticated callers cannot execute either helper or insert into the event table.
CREATE OR REPLACE FUNCTION public.complete_fieldops_reassignment_request_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE r public.fieldops_reassignment_requests%ROWTYPE; v_task public.tasks%ROWTYPE; v_result JSONB;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_RELID <> 'public.route_stop_reassignment_events'::regclass
    OR NEW.event_type IS DISTINCT FROM 'reassigned'
    OR NEW.source_route_run_assignment_id IS NULL OR NEW.target_route_run_assignment_id IS NULL
    OR NEW.source_route_run_id IS NULL OR NEW.target_route_run_id IS NULL THEN RETURN NEW; END IF;
  FOR r IN SELECT q.* FROM public.fieldops_reassignment_requests q
    JOIN public.route_stops rs ON rs.id = q.route_stop_id
    JOIN public.route_run_assignments a ON a.id = NEW.target_route_run_assignment_id
    WHERE q.route_stop_id = NEW.route_stop_id AND q.organization_id = NEW.organization_id
      AND q.client_id IS NOT DISTINCT FROM NEW.client_id AND q.shipment_id IS NOT DISTINCT FROM NEW.shipment_id
      AND q.source_route_run_id = NEW.source_route_run_id AND q.source_assignment_id = NEW.source_route_run_assignment_id
      AND NEW.payload#>>'{source_assignment,assignment_version}' = q.source_assignment_version::text
      AND q.completed_event_id IS NULL AND q.dispatch_task_id IS NOT NULL
      AND rs.route_run_id = NEW.target_route_run_id AND rs.organization_id = q.organization_id
      AND rs.client_id IS NOT DISTINCT FROM q.client_id AND rs.shipment_id IS NOT DISTINCT FROM q.shipment_id
      AND a.route_run_id = NEW.target_route_run_id AND a.organization_id = q.organization_id
      AND a.driver_user_id = q.target_driver_user_id
    ORDER BY q.id FOR UPDATE OF q
  LOOP
    SELECT t.* INTO v_task FROM public.tasks t JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE t.id = r.dispatch_task_id AND t.organization_id = r.organization_id
        AND tt.organization_id = r.organization_id AND tt.key = 'dispatch_exception_review'
        AND t.resource_type = 'route_stop' AND t.resource_id = r.route_stop_id
        AND t.idempotency_key = 'fieldops-reassignment:' || r.id
        AND t.metadata->>'fieldops_reassignment_request_id' = r.id::text
        AND t.metadata->>'parent_workflow_run_id' = r.workflow_run_id::text
      FOR UPDATE OF t;
    IF NOT FOUND THEN RAISE EXCEPTION 'fieldops_reassignment_task_link_invalid' USING ERRCODE = '55000'; END IF;
    IF COALESCE(lower(v_task.status),'') NOT IN ('open','pending','assigned','in_progress')
      OR v_task.completed_at IS NOT NULL OR v_task.canceled_at IS NOT NULL THEN CONTINUE; END IF;
    v_result := public.transition_task_system_v1(v_task.id, 'completed', 'resolved_by_route_stop_reassignment',
      jsonb_build_object('request_id', r.id, 'route_stop_reassignment_event_id', NEW.id,
        'decision_log_id', NEW.decision_log_id, 'source_assignment_id', NEW.source_route_run_assignment_id,
        'target_assignment_id', NEW.target_route_run_assignment_id, 'request_correlation_id', r.id,
        'operator_correlation_id', NEW.payload->'correlation_id'),
      'fieldops-reassignment-event', 'fieldops-reassignment-complete:' || NEW.id || ':' || r.id);
    IF v_result->>'status' IS DISTINCT FROM 'completed' OR v_result->>'task_id' IS DISTINCT FROM v_task.id::text THEN
      RAISE EXCEPTION 'fieldops_reassignment_transition_incomplete' USING ERRCODE = '55000';
    END IF;
    UPDATE public.fieldops_reassignment_requests SET completed_event_id = NEW.id, updated_at = now() WHERE id = r.id;
  END LOOP;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_fieldops_reassignment_request_v1() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_complete_fieldops_reassignment_request
  AFTER INSERT ON public.route_stop_reassignment_events
  FOR EACH ROW EXECUTE FUNCTION public.complete_fieldops_reassignment_request_v1();

CREATE OR REPLACE FUNCTION api.prepare_fieldops_reassignment_v1(
 p_stop_id UUID, p_target_driver_id UUID, p_reason TEXT, p_idempotency_key TEXT, p_expected_actor_user_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path TO public, extensions, pg_temp
AS $function$ SELECT public.prepare_fieldops_reassignment_v1($1,$2,$3,$4,$5); $function$;
CREATE OR REPLACE FUNCTION api.submit_fieldops_reassignment_v1(p_request_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path TO public, extensions, pg_temp
AS $function$ SELECT public.submit_fieldops_reassignment_v1($1); $function$;
CREATE OR REPLACE FUNCTION api.fieldops_reassignment_candidates_v1(p_stop_id UUID)
RETURNS TABLE(value TEXT, label TEXT, description TEXT, metadata JSONB)
LANGUAGE sql SECURITY INVOKER SET search_path TO public, extensions, pg_temp
AS $function$ SELECT * FROM public.fieldops_reassignment_candidates_v1($1); $function$;
REVOKE ALL ON FUNCTION public.prepare_fieldops_reassignment_v1(UUID,UUID,TEXT,TEXT,UUID),
 api.prepare_fieldops_reassignment_v1(UUID,UUID,TEXT,TEXT,UUID),
 public.fieldops_reassignment_candidates_v1(UUID), api.fieldops_reassignment_candidates_v1(UUID)
 FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_fieldops_reassignment_v1(UUID,UUID,TEXT,TEXT,UUID),
 api.prepare_fieldops_reassignment_v1(UUID,UUID,TEXT,TEXT,UUID),
 public.fieldops_reassignment_candidates_v1(UUID), api.fieldops_reassignment_candidates_v1(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.submit_fieldops_reassignment_v1(UUID), api.submit_fieldops_reassignment_v1(UUID)
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_reassignment_v1(UUID), api.submit_fieldops_reassignment_v1(UUID) TO service_role;

INSERT INTO public.workflow_binding_registry
 (binding_key,label,description,resource_type,actor_surface,entrypoint_type,current_execution_kind,
 configurability_status,owner,migration_phase,is_business_affecting)
VALUES ('fieldops_reassignment','Driver reassignment request','Driver intent routed to Dispatch through the workflow engine.',
 'route_stop','fieldops','edge','hybrid_task_backed','workflow_configurable','ops','wave_2',TRUE);
INSERT INTO public.workflow_binding_stage_registry
 (binding_key,stage_key,label,sequence_order,is_enabled)
VALUES ('fieldops_reassignment','review_requested','Dispatch review requested',10,TRUE);
DO $seed$
DECLARE v_root TEXT := public.get_root_scope_type_key_v1(); v_template UUID := gen_random_uuid();
 v_policy JSONB; v_row RECORD; v_commands JSONB; v_command JSONB;
BEGIN
 INSERT INTO public.workflow_templates
 (id,name,description,version,status,scope_type,scope_id,created_at,published_at,metadata)
 VALUES (v_template,'workflow_binding.fieldops_reassignment.review_requested.global.v1',
 'Dispatch review for an immutable driver reassignment request.',1,'active',v_root,NULL,workflow_now(),workflow_now(),
 jsonb_build_object('binding_key','fieldops_reassignment','stage_key','review_requested'));
 INSERT INTO public.workflow_template_steps
 (id,workflow_template_id,sequence_order,operation_name,transition_condition,metadata,enabled,handler_key,handler_version)
 VALUES (gen_random_uuid(),v_template,10,'fieldops_reassignment_dispatch_review','success',
 '{"task_path":"$.context.binding_payload.task","context_key":"task"}'::jsonb,TRUE,'task_enqueue_dynamic','v1');
 v_policy := public.resolve_settings_merged('workflow_binding_policy',v_root,NULL::uuid);
 v_policy := public.jsonb_deep_merge(COALESCE(v_policy,'{"version":1,"bindings":{}}'::jsonb),
 jsonb_build_object('bindings',jsonb_build_object('fieldops_reassignment',jsonb_build_object(
 'stages',jsonb_build_object('review_requested',jsonb_build_object('enabled',TRUE,
 'workflow_template_id',v_template,'inline_progress_steps',1))))));
 PERFORM public.upsert_settings_value_v1('workflow_binding_policy',v_root,NULL,v_policy,1,'FieldOps reassignment workflow binding',NULL);

 v_command := jsonb_build_object('key','route_stops.request_reassignment','label','Request reassignment',
 'schema_category','resource:route_stops','capability','routes.read',
 'selection',jsonb_build_object('mode','single','min_count',1,'max_count',1),
 'execution',jsonb_build_object('type','workflow_binding','transport','edge','function','fieldops-reassignment-request',
 'binding_key','fieldops_reassignment','stage_key','review_requested','payload_key','payload',
 'input_schema',jsonb_build_object('version',1,'title','Request reassignment','fields',jsonb_build_array(
 jsonb_build_object('key','target_driver_id','label','Target driver','type','lookup','required',TRUE,
 'lookup_rpc','fieldops_reassignment_candidates_v1','lookup_selection_param','p_stop_id'),
 jsonb_build_object('key','reason','label','Reason','type','textarea','required',TRUE)))));
 FOR v_row IN SELECT s.scope_type,s.scope_id,sv.value FROM public.settings s
 JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_command_registry'
 LOOP
  v_commands := COALESCE(v_row.value->'commands','[]'::jsonb);
  IF jsonb_typeof(v_commands) <> 'array' THEN RAISE EXCEPTION 'invalid_ui_command_registry'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_commands) c WHERE c->>'key'='route_stops.request_reassignment') THEN
   PERFORM public.upsert_settings_value_v1('ui_command_registry',v_row.scope_type,v_row.scope_id,
    jsonb_set(v_row.value,'{commands}',v_commands || jsonb_build_array(v_command)),1,
    'Add driver reassignment request; preserve existing operator commands',NULL);
  END IF;
 END LOOP;
END;
$seed$;
COMMIT;
