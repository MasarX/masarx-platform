-- Migration: UC080 route run assignment response lifecycle v1
BEGIN;
SELECT pg_advisory_lock(hashtext('202604062130_uc080_route_run_assignment_response_lifecycle_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Assignment response columns + consistency checks
-------------------------------------------------------------------------------

ALTER TABLE public.route_run_assignments
  ADD COLUMN IF NOT EXISTS responded_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refusal_reason TEXT,
  ADD COLUMN IF NOT EXISTS response_notes TEXT,
  ADD COLUMN IF NOT EXISTS response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.route_run_assignments
  DROP CONSTRAINT IF EXISTS route_run_assignments_response_metadata_object_ck;

ALTER TABLE public.route_run_assignments
  ADD CONSTRAINT route_run_assignments_response_metadata_object_ck
  CHECK (jsonb_typeof(response_metadata) = 'object');

ALTER TABLE public.route_run_assignments
  DROP CONSTRAINT IF EXISTS route_run_assignments_response_state_ck;

ALTER TABLE public.route_run_assignments
  ADD CONSTRAINT route_run_assignments_response_state_ck
  CHECK (
    assignment_status = 'assigned'
    OR (
      responded_by_user_id IS NOT NULL
      AND (
        (
          assignment_status = 'acknowledged'
          AND acknowledged_at IS NOT NULL
          AND accepted_at IS NULL
          AND refused_at IS NULL
          AND btrim(COALESCE(refusal_reason, '')) = ''
        )
        OR (
          assignment_status = 'accepted'
          AND acknowledged_at IS NOT NULL
          AND accepted_at IS NOT NULL
          AND refused_at IS NULL
          AND btrim(COALESCE(refusal_reason, '')) = ''
        )
        OR (
          assignment_status = 'refused'
          AND refused_at IS NOT NULL
          AND accepted_at IS NULL
          AND btrim(COALESCE(refusal_reason, '')) <> ''
        )
      )
    )
  );

ALTER TABLE public.route_run_assignments
  DROP CONSTRAINT IF EXISTS route_run_assignments_refusal_reason_ck;

ALTER TABLE public.route_run_assignments
  ADD CONSTRAINT route_run_assignments_refusal_reason_ck
  CHECK (
    assignment_status <> 'refused'
    OR btrim(COALESCE(refusal_reason, '')) <> ''
  );

-------------------------------------------------------------------------------
-- 2) Response state normalizer
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_run_assignments_normalize_response_state_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF NEW.response_metadata IS NULL OR jsonb_typeof(NEW.response_metadata) IS DISTINCT FROM 'object' THEN
    NEW.response_metadata := '{}'::jsonb;
  END IF;

  NEW.refusal_reason := NULLIF(btrim(COALESCE(NEW.refusal_reason, '')), '');
  NEW.response_notes := NULLIF(btrim(COALESCE(NEW.response_notes, '')), '');

  IF NEW.assignment_status = 'assigned' THEN
    NEW.responded_by_user_id := NULL;
    NEW.acknowledged_at := NULL;
    NEW.accepted_at := NULL;
    NEW.refused_at := NULL;
    NEW.refusal_reason := NULL;
  ELSIF NEW.assignment_status = 'acknowledged' THEN
    NEW.acknowledged_at := COALESCE(NEW.acknowledged_at, COALESCE(OLD.acknowledged_at, now()));
    NEW.accepted_at := NULL;
    NEW.refused_at := NULL;
    NEW.refusal_reason := NULL;
    NEW.responded_by_user_id := COALESCE(NEW.responded_by_user_id, OLD.responded_by_user_id);
  ELSIF NEW.assignment_status = 'accepted' THEN
    NEW.acknowledged_at := COALESCE(NEW.acknowledged_at, COALESCE(OLD.acknowledged_at, now()));
    NEW.accepted_at := COALESCE(NEW.accepted_at, now());
    NEW.refused_at := NULL;
    NEW.refusal_reason := NULL;
    NEW.responded_by_user_id := COALESCE(NEW.responded_by_user_id, OLD.responded_by_user_id);
  ELSIF NEW.assignment_status = 'refused' THEN
    NEW.refused_at := COALESCE(NEW.refused_at, now());
    NEW.accepted_at := NULL;
    NEW.responded_by_user_id := COALESCE(NEW.responded_by_user_id, OLD.responded_by_user_id);
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_route_run_assignments_normalize_response_state ON public.route_run_assignments;
CREATE TRIGGER trg_route_run_assignments_normalize_response_state
  BEFORE INSERT OR UPDATE ON public.route_run_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.route_run_assignments_normalize_response_state_v1();
-------------------------------------------------------------------------------
-- 3) Canonical response RPC
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.respond_route_run_assignment_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_run_id UUID,
  route_run_assignment_id UUID,
  assignment_status TEXT,
  assignment_version INT,
  responded_by_user_id UUID,
  acknowledged_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  refused_at TIMESTAMPTZ,
  refusal_reason TEXT,
  response_notes TEXT,
  response_metadata JSONB,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_scope_type TEXT := NULL;
  v_scope_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_assignment_ui');
  v_action_key TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'action_key', '')), ''));
  v_response_status TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'response_status', '')), ''));
  v_route_run_id UUID := NULL;
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_response_notes TEXT := NULLIF(btrim(COALESCE(v_input->>'response_notes', '')), '');
  v_refusal_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'refusal_reason', '')), '');
  v_requested_response_metadata JSONB := COALESCE(v_input->'response_metadata', '{}'::jsonb);
  v_route_run public.route_runs%ROWTYPE;
  v_assignment public.route_run_assignments%ROWTYPE;
  v_existing_event public.route_run_assignment_events%ROWTYPE;
  v_current_response_status TEXT := NULL;
  v_next_assignment_status TEXT := NULL;
  v_next_version INT := NULL;
  v_event_type TEXT := NULL;
  v_decision_id UUID := NULL;
  v_resolved_response_metadata JSONB := '{}'::jsonb;
  v_route_assignment_payload JSONB := '{}'::jsonb;
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_is_service BOOLEAN := FALSE;
  v_can_write BOOLEAN := FALSE;
  v_is_self_driver BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'respond_route_run_assignment_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  IF v_response_status = '' THEN
    CASE v_action_key
      WHEN 'route_runs.acknowledge_assignment' THEN
        v_response_status := 'acknowledged';
      WHEN 'route_runs.accept_assignment' THEN
        v_response_status := 'accepted';
      WHEN 'route_runs.refuse_assignment' THEN
        v_response_status := 'refused';
      ELSE
        v_response_status := '';
    END CASE;
  END IF;

  IF v_response_status NOT IN ('acknowledged', 'accepted', 'refused') THEN
    RAISE EXCEPTION 'respond_route_run_assignment_v1 invalid response status %', COALESCE(v_response_status, '')
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  v_is_service := v_role = 'service_role';
  v_scope_type := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id := public.current_user_scope_id();

  BEGIN
    v_route_run_id := NULLIF(v_input->>'route_run_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_run_id := NULL;
  END;

  BEGIN
    v_actor_user_id := auth.uid();
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'respond_route_run_assignment_v1 requires route_run_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT rr.*
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
   FOR UPDATE;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'respond_route_run_assignment_v1 route_run % not found', v_route_run_id
      USING ERRCODE = '23503';
  END IF;

  SELECT rra.*
    INTO v_assignment
    FROM public.route_run_assignments rra
   WHERE rra.route_run_id = v_route_run_id
   FOR UPDATE;

  IF v_assignment.id IS NULL THEN
    RAISE EXCEPTION 'respond_route_run_assignment_v1 route_run % has no assignment to respond to', v_route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_is_service AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'respond_route_run_assignment_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_can_write := public.user_has_resource_capability_v1('routes', 'write', v_scope_type, v_scope_id);
  v_is_self_driver := v_actor_user_id IS NOT NULL
    AND v_assignment.driver_user_id IS NOT NULL
    AND v_assignment.driver_user_id = v_actor_user_id;

  IF NOT v_is_service AND NOT v_can_write AND NOT v_is_self_driver THEN
    RAISE EXCEPTION 'respond_route_run_assignment_v1 requires routes.write capability or assignment ownership'
      USING ERRCODE = '42501';
  END IF;

  IF v_response_status = 'accepted' AND v_assignment.assignment_status = 'assigned' THEN
    RAISE EXCEPTION 'respond_route_run_assignment_v1 requires acknowledgement before acceptance'
      USING ERRCODE = '23514';
  END IF;

  IF v_response_status = 'refused' AND btrim(COALESCE(v_refusal_reason, '')) = '' THEN
    RAISE EXCEPTION 'respond_route_run_assignment_v1 requires refusal_reason for refusal'
      USING ERRCODE = '23514';
  END IF;

  IF v_assignment.assignment_status = v_response_status THEN
    route_run_id := v_route_run_id;
    route_run_assignment_id := v_assignment.id;
    assignment_status := v_assignment.assignment_status;
    assignment_version := v_assignment.assignment_version;
    responded_by_user_id := v_assignment.responded_by_user_id;
    acknowledged_at := v_assignment.acknowledged_at;
    accepted_at := v_assignment.accepted_at;
    refused_at := v_assignment.refused_at;
    refusal_reason := v_assignment.refusal_reason;
    response_notes := v_assignment.response_notes;
    response_metadata := v_assignment.response_metadata;
    created := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT *
      INTO v_existing_event
      FROM public.route_run_assignment_events ev
     WHERE ev.route_run_id = v_route_run_id
       AND ev.idempotency_key = v_idempotency_key
     LIMIT 1;

    IF v_existing_event.id IS NOT NULL THEN
      route_run_id := v_route_run_id;
      route_run_assignment_id := v_assignment.id;
      assignment_status := v_assignment.assignment_status;
      assignment_version := v_assignment.assignment_version;
      responded_by_user_id := v_assignment.responded_by_user_id;
      acknowledged_at := v_assignment.acknowledged_at;
      accepted_at := v_assignment.accepted_at;
      refused_at := v_assignment.refused_at;
      refusal_reason := v_assignment.refusal_reason;
      response_notes := v_assignment.response_notes;
      response_metadata := v_assignment.response_metadata;
      created := FALSE;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  v_current_response_status := v_assignment.assignment_status;
  v_next_assignment_status := v_response_status;
  v_next_version := COALESCE(v_assignment.assignment_version, 0) + 1;

  IF v_current_response_status = 'acknowledged' AND v_next_assignment_status = 'accepted' THEN
    NULL;
  ELSIF v_current_response_status = 'assigned' AND v_next_assignment_status IN ('acknowledged', 'refused') THEN
    NULL;
  ELSIF v_current_response_status = 'acknowledged' AND v_next_assignment_status = 'refused' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'respond_route_run_assignment_v1 cannot transition % to %', v_current_response_status, v_next_assignment_status
      USING ERRCODE = '23514';
  END IF;

  v_resolved_response_metadata :=
    jsonb_strip_nulls(
      COALESCE(v_requested_response_metadata, '{}'::jsonb)
      || jsonb_build_object(
        'action_key', v_action_key,
        'response_status', v_next_assignment_status,
        'route_run_id', v_route_run_id,
        'route_run_assignment_id', v_assignment.id,
        'selection_id', v_route_run_id::text,
        'idempotency_key', v_idempotency_key,
        'actor_user_id', v_actor_user_id,
        'actor_system', v_actor_system,
        'response_notes', v_response_notes,
        'refusal_reason', v_refusal_reason,
        'recorded_at', now()
      )
    );
  IF v_next_assignment_status = 'acknowledged' THEN
    v_event_type := 'acknowledged';
  ELSIF v_next_assignment_status = 'accepted' THEN
    v_event_type := 'accepted';
  ELSE
    v_event_type := 'refused';
  END IF;

  UPDATE public.route_run_assignments rra
     SET assignment_status = v_next_assignment_status,
         assignment_version = v_next_version,
         responded_by_user_id = v_actor_user_id,
         acknowledged_at = CASE
           WHEN v_next_assignment_status IN ('acknowledged', 'accepted') THEN COALESCE(v_assignment.acknowledged_at, now())
           ELSE v_assignment.acknowledged_at
         END,
         accepted_at = CASE
           WHEN v_next_assignment_status = 'accepted' THEN COALESCE(v_assignment.accepted_at, now())
           ELSE NULL
         END,
         refused_at = CASE
           WHEN v_next_assignment_status = 'refused' THEN COALESCE(v_assignment.refused_at, now())
           ELSE NULL
         END,
         refusal_reason = CASE
           WHEN v_next_assignment_status = 'refused' THEN v_refusal_reason
           ELSE NULL
         END,
         response_notes = v_response_notes,
         response_metadata = v_resolved_response_metadata
   WHERE rra.route_run_id = v_route_run_id
   RETURNING *
    INTO v_assignment;

  v_route_assignment_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_assignment_id', v_assignment.id,
      'assignment_status', v_assignment.assignment_status,
      'assignment_version', v_assignment.assignment_version,
      'assignment_mode', v_assignment.assignment_mode,
      'driver_user_id', v_assignment.driver_user_id,
      'vehicle_id', v_assignment.vehicle_id,
      'partner', v_assignment.partner,
      'assigned_by_user_id', v_assignment.assigned_by_user_id,
      'assigned_at', v_assignment.assigned_at,
      'responded_by_user_id', v_assignment.responded_by_user_id,
      'acknowledged_at', v_assignment.acknowledged_at,
      'accepted_at', v_assignment.accepted_at,
      'refused_at', v_assignment.refused_at,
      'refusal_reason', v_assignment.refusal_reason,
      'response_notes', v_assignment.response_notes,
      'response_metadata', NULLIF(v_assignment.response_metadata, '{}'::jsonb)
    )
  );

  UPDATE public.route_runs rr
     SET metadata = jsonb_set(COALESCE(rr.metadata, '{}'::jsonb), '{route_assignment}', v_route_assignment_payload, true)
   WHERE rr.id = v_route_run_id;

  UPDATE public.shipments s
     SET metadata = jsonb_set(COALESCE(s.metadata, '{}'::jsonb), '{route_assignment}', v_route_assignment_payload, true)
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_route_run_id
     AND s.id = rs.shipment_id
     AND s.client_id = rs.client_id;

  INSERT INTO public.route_run_assignment_events (
    organization_id,
    route_run_assignment_id,
    route_run_id,
    assignment_version,
    event_type,
    from_status,
    to_status,
    assignment_mode,
    driver_user_id,
    vehicle_id,
    partner,
    actor_user_id,
    actor_system,
    notes,
    payload,
    idempotency_key,
    decision_log_id
  )
  VALUES (
    v_assignment.organization_id,
    v_assignment.id,
    v_route_run_id,
    v_assignment.assignment_version,
    v_event_type,
    v_current_response_status,
    v_assignment.assignment_status,
    v_assignment.assignment_mode,
    v_assignment.driver_user_id,
    v_assignment.vehicle_id,
    v_assignment.partner,
    v_actor_user_id,
    v_actor_system,
    COALESCE(v_response_notes, v_refusal_reason),
    jsonb_strip_nulls(
      jsonb_build_object(
        'response_status', v_assignment.assignment_status,
        'response_notes', v_response_notes,
        'refusal_reason', v_refusal_reason,
        'response_metadata', NULLIF(v_assignment.response_metadata, '{}'::jsonb),
        'route_run_assignment_id', v_assignment.id,
        'route_run_id', v_route_run_id,
        'recorded_at', now()
      )
    ),
    v_idempotency_key,
    v_decision_id
  );

  route_run_id := v_route_run_id;
  route_run_assignment_id := v_assignment.id;
  assignment_status := v_assignment.assignment_status;
  assignment_version := v_assignment.assignment_version;
  responded_by_user_id := v_assignment.responded_by_user_id;
  acknowledged_at := v_assignment.acknowledged_at;
  accepted_at := v_assignment.accepted_at;
  refused_at := v_assignment.refused_at;
  refusal_reason := v_assignment.refusal_reason;
  response_notes := v_assignment.response_notes;
  response_metadata := v_assignment.response_metadata;
  created := TRUE;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.respond_route_run_assignment_v1(JSONB)
  IS 'Canonical route-run assignment response RPC. Accepts acknowledgement, acceptance, and refusal transitions for the assigned executor, records response evidence, and updates the route_run projection.';

REVOKE ALL ON FUNCTION public.respond_route_run_assignment_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.respond_route_run_assignment_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.respond_route_run_assignment_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.respond_route_run_assignment_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_run_id UUID,
  route_run_assignment_id UUID,
  assignment_status TEXT,
  assignment_version INT,
  responded_by_user_id UUID,
  acknowledged_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  refused_at TIMESTAMPTZ,
  refusal_reason TEXT,
  response_notes TEXT,
  response_metadata JSONB,
  created BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.respond_route_run_assignment_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.respond_route_run_assignment_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.respond_route_run_assignment_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.respond_route_run_assignment_v1(JSONB) TO authenticated, service_role;
-------------------------------------------------------------------------------
-- 4) Browser-safe UI/API executor
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_route_run_assignment_response_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_execution JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_route_run_id UUID := NULL;
  v_visible_route JSONB := NULL;
  v_response_status TEXT := NULL;
  v_result RECORD;
BEGIN
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_run_assignment_response_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_run_assignment_response_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assignment_response_v1 unknown command %', p_action_key;
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(NULLIF(v_selection->>'min_count', '')::INT, CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END);
  v_max := COALESCE(NULLIF(v_selection->>'max_count', '')::INT, CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END);

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_route_run_assignment_response_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_route_run_assignment_response_v1 selection above maximum %', v_max;
  END IF;

  BEGIN
    v_route_run_id := NULLIF(COALESCE(v_id, v_ids[1]), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_run_id := NULL;
  END;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assignment_response_v1 invalid route id %', COALESCE(v_id, v_ids[1], '')
      USING ERRCODE = '23514';
  END IF;

  v_visible_route := public.ui_get_resource_v1(p_resource_key, v_route_run_id);
  IF v_visible_route IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assignment_response_v1 route % is not visible in resource %', v_route_run_id, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);
  v_response_status := NULLIF(btrim(COALESCE(v_params->>'response_status', '')), '');

  SELECT *
    INTO v_result
    FROM public.respond_route_run_assignment_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'action_key', p_action_key,
          'route_run_id', v_route_run_id,
          'response_status', v_response_status,
          'response_notes', NULLIF(v_params->>'response_notes', ''),
          'refusal_reason', NULLIF(v_params->>'refusal_reason', ''),
          'response_metadata', COALESCE(v_params->'response_metadata', '{}'::jsonb),
          'idempotency_key', NULLIF(v_params->>'idempotency_key', ''),
          'actor_system', COALESCE(NULLIF(btrim(COALESCE(v_params->>'actor_system', '')), ''), 'route_assignment_ui')
        )
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', v_result.assignment_status,
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', 1,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'route_run_id', v_result.route_run_id,
          'route_run_assignment_id', v_result.route_run_assignment_id,
          'assignment_status', v_result.assignment_status,
          'assignment_version', v_result.assignment_version,
          'responded_by_user_id', v_result.responded_by_user_id,
          'acknowledged_at', v_result.acknowledged_at,
          'accepted_at', v_result.accepted_at,
          'refused_at', v_result.refused_at,
          'refusal_reason', v_result.refusal_reason,
          'response_notes', v_result.response_notes,
          'response_metadata', v_result.response_metadata,
          'created', v_result.created,
          'updated', v_result.created
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_route_run_assignment_response_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Dedicated UI command executor for route run assignment responses. Keeps assignment acknowledgement, acceptance, and refusal on the routes resource contract without widening ui_execute_command_v1.';

REVOKE ALL ON FUNCTION public.ui_execute_route_run_assignment_response_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_route_run_assignment_response_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_route_run_assignment_response_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_route_run_assignment_response_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_execute_route_run_assignment_response_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_route_run_assignment_response_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_route_run_assignment_response_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_route_run_assignment_response_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;
-------------------------------------------------------------------------------
-- 5) ui_command_registry: expose route assignment responses
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
  v_canonical_commands JSONB := jsonb_build_object(
    'route_runs.acknowledge_assignment', jsonb_build_object(
      'key', 'route_runs.acknowledge_assignment',
      'label', 'Acknowledge assignment',
      'description', 'Acknowledge the selected route assignment before execution starts.',
      'capability', 'routes.read',
      'schema_category', 'resource:routes',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_route_run_assignment_response_v1',
        'params', jsonb_build_object('response_status', 'acknowledged'),
        'confirm', jsonb_build_object(
          'title', 'Acknowledge assignment?',
          'description', 'Mark the selected route assignment as acknowledged by the executor.',
          'confirm_label', 'Acknowledge',
          'cancel_label', 'Cancel',
          'tone', 'primary'
        )
      )
    ),
    'route_runs.accept_assignment', jsonb_build_object(
      'key', 'route_runs.accept_assignment',
      'label', 'Accept assignment',
      'description', 'Accept the selected route assignment after acknowledgement.',
      'capability', 'routes.read',
      'schema_category', 'resource:routes',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_route_run_assignment_response_v1',
        'params', jsonb_build_object('response_status', 'accepted'),
        'confirm', jsonb_build_object(
          'title', 'Accept assignment?',
          'description', 'Mark the selected route assignment as accepted by the executor.',
          'confirm_label', 'Accept',
          'cancel_label', 'Cancel',
          'tone', 'primary'
        )
      )
    ),
    'route_runs.refuse_assignment', jsonb_build_object(
      'key', 'route_runs.refuse_assignment',
      'label', 'Refuse assignment',
      'description', 'Refuse the selected route assignment with a required reason.',
      'capability', 'routes.read',
      'schema_category', 'resource:routes',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_route_run_assignment_response_v1',
        'params', jsonb_build_object('response_status', 'refused'),
        'input_schema', jsonb_build_object(
          'version', 1,
          'fields', jsonb_build_array(
            jsonb_build_object(
              'key', 'refusal_reason',
              'label', 'Refusal reason',
              'type', 'textarea',
              'required', TRUE
            ),
            jsonb_build_object(
              'key', 'response_notes',
              'label', 'Response notes',
              'type', 'textarea',
              'required', FALSE
            )
          )
        ),
        'confirm', jsonb_build_object(
          'title', 'Refuse assignment?',
          'description', 'Refuse the selected route assignment and record the refusal reason.',
          'confirm_label', 'Refuse',
          'cancel_label', 'Cancel',
          'tone', 'danger'
        )
      )
    )
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key IN ('route_runs.acknowledge_assignment', 'route_runs.accept_assignment', 'route_runs.refuse_assignment') THEN
        v_command := public.deep_merge_jsonb(v_canonical_commands->v_command_key, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    FOREACH v_command_key IN ARRAY ARRAY['route_runs.acknowledge_assignment', 'route_runs.accept_assignment', 'route_runs.refuse_assignment'] LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_next_commands) AS item
        WHERE item->>'key' = v_command_key
      ) THEN
        v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->v_command_key);
      END IF;
    END LOOP;

    v_next_commands := COALESCE(v_next_commands, '[]'::jsonb);
    v_next := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);

    IF v_next IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose route run assignment response commands through ui_command_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604062130_uc080_route_run_assignment_response_lifecycle_v1'));
COMMIT;
