BEGIN;
SELECT pg_advisory_lock(hashtext('202606010830_fieldops_mobile_v2_reassign_dispatch_task_bridge_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.submit_fieldops_reassign_v1(
  p_stop_id UUID,
  p_target_driver_id UUID,
  p_reason TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_existing UUID;
  v_decision_id UUID;
  v_stop RECORD;
  v_target_driver_exists BOOLEAN := FALSE;
  v_request_task RECORD;
  v_request_task_id UUID := NULL;
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_service_claims JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_stop_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires stop_id' USING ERRCODE = '22023';
  END IF;
  IF p_target_driver_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires target_driver_id' USING ERRCODE = '22023';
  END IF;
  IF p_target_driver_id = v_user_id THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 target_driver_id must differ from caller' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires a reason of at least 3 chars' USING ERRCODE = '22023';
  END IF;

  SELECT
    rs.id,
    rs.organization_id,
    rs.client_id,
    rs.shipment_id,
    rs.route_run_id,
    rr.branch_id,
    rr.driver_user_id AS route_driver_user_id,
    s.sender_id,
    s.tracking_number
    INTO v_stop
    FROM public.route_stops rs
    JOIN public.route_runs rr
      ON rr.id = rs.route_run_id
     AND rr.organization_id = rs.organization_id
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.organization_id = rs.organization_id
   WHERE rs.id = p_stop_id
     AND rs.organization_id = v_org
   LIMIT 1;

  IF v_stop.id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 route_stop % not found for current organization', p_stop_id
      USING ERRCODE = '23503';
  END IF;

  IF COALESCE(v_stop.route_driver_user_id, '00000000-0000-0000-0000-000000000000'::uuid) <> v_user_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.route_run_assignments rra
        WHERE rra.route_run_id = v_stop.route_run_id
          AND rra.driver_user_id = v_user_id
          AND lower(COALESCE(rra.assignment_status, '')) NOT IN ('cancelled', 'canceled', 'completed', 'refused')
     ) THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 caller is not assigned to stop %', p_stop_id
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.users u
     WHERE u.id = p_target_driver_id
       AND u.organization_id = v_org
  ) INTO v_target_driver_exists;

  IF NOT COALESCE(v_target_driver_exists, FALSE) THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 target driver % is not in current organization', p_target_driver_id
      USING ERRCODE = '23503';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_reassign', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    SELECT t.id
      INTO v_request_task_id
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
       AND tt.key = 'dispatch_exception_review'
     WHERE t.organization_id = v_org
       AND t.resource_type = 'route_stop'
       AND t.resource_id = p_stop_id
       AND t.metadata->>'mobile_v2_reassign_decision_log_id' = v_existing::text
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT 1;

    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'dispatch_task_id', v_request_task_id,
      'ok', TRUE,
      'state', 'replayed',
      'stop_id', p_stop_id,
      'target_driver_id', p_target_driver_id
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'fieldops_reassign',
    p_resource_type := 'route_stop',
    p_resource_id := p_stop_id,
    p_decision_point := 'reassign_stop',
    p_decision_outcome := 'requested',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id := p_idempotency_key,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'stop_id', p_stop_id,
      'source_route_run_id', v_stop.route_run_id,
      'target_driver_id', p_target_driver_id,
      'reason', v_reason,
      'actor_user_id', v_user_id
    )),
    p_decision_reason := v_reason,
    p_settings_resolution_id := NULL
  );

  v_service_claims := COALESCE(NULLIF(v_prev_claims, '')::jsonb, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);
  PERFORM set_config('app.actor_system', 'fieldops_mobile_v2_reassign', true);
  BEGIN
    SELECT *
      INTO v_request_task
      FROM public.create_task_system_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'task_type_key', 'dispatch_exception_review',
          'resource_type', 'route_stop',
          'resource_id', p_stop_id,
          'context', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org,
            'client_id', v_stop.client_id,
            'sender_id', v_stop.sender_id,
            'branch_id', v_stop.branch_id,
            'shipment_id', v_stop.shipment_id,
            'route_run_id', v_stop.route_run_id,
            'route_stop_id', p_stop_id,
            'requested_by_user_id', v_user_id,
            'target_driver_user_id', p_target_driver_id,
            'dispatch_exception_reason', 'driver_reassignment_request'
          )),
          'idempotency_key', format('fieldops-mobile-v2:reassign-request:%s', p_idempotency_key),
          'metadata', jsonb_strip_nulls(jsonb_build_object(
            'subject', 'Mobile V2 reassignment request ' || COALESCE(v_stop.tracking_number, p_stop_id::text),
            'mobile_v2_reassign_request', TRUE,
            'mobile_v2_reassign_decision_log_id', v_decision_id,
            'route_stop_id', p_stop_id,
            'source_route_run_id', v_stop.route_run_id,
            'shipment_id', v_stop.shipment_id,
            'tracking_number', v_stop.tracking_number,
            'requested_by_user_id', v_user_id,
            'target_driver_user_id', p_target_driver_id,
            'dispatch_exception_reason', 'driver_reassignment_request',
            'exception_notes', v_reason,
            'reason', v_reason,
            'resolution_action', 'route_stops.reassign',
            'allowed_ndr_actions', jsonb_build_array()
          )),
          'actor_system', 'fieldops_mobile_v2_reassign'
        ))
      )
     LIMIT 1;
    v_request_task_id := v_request_task.task_id;

    PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    PERFORM set_config('app.actor_system', v_prev_actor_system, true);
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'dispatch_task_id', v_request_task_id,
    'ok', TRUE,
    'state', 'requested',
    'stop_id', p_stop_id,
    'source_route_run_id', v_stop.route_run_id,
    'target_driver_id', p_target_driver_id
  );
END;
$function$;

COMMENT ON FUNCTION public.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) IS
  'Mobile V2 stop-reassignment request write. Validates the live assigned stop, writes decision_log, and creates a Dispatch recovery task for canonical operator reassignment.';

REVOKE ALL ON FUNCTION public.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_reassign_v1(
  p_stop_id UUID,
  p_target_driver_id UUID,
  p_reason TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.submit_fieldops_reassign_v1(p_stop_id, p_target_driver_id, p_reason, p_idempotency_key);
$function$;

REVOKE ALL ON FUNCTION api.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_fieldops_reassign_request_task_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_target_driver_id UUID := NULL;
  v_task RECORD;
  v_transition JSONB;
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_service_claims JSONB := '{}'::jsonb;
BEGIN
  IF lower(COALESCE(NEW.event_type, '')) <> 'reassigned' THEN
    RETURN NEW;
  END IF;

  SELECT rra.driver_user_id
    INTO v_target_driver_id
    FROM public.route_run_assignments rra
   WHERE rra.id = NEW.target_route_run_assignment_id
   LIMIT 1;

  FOR v_task IN
    SELECT t.id
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
       AND tt.key = 'dispatch_exception_review'
     WHERE t.organization_id = NEW.organization_id
       AND t.resource_type = 'route_stop'
       AND t.resource_id = NEW.route_stop_id
       AND lower(COALESCE(t.status, '')) NOT IN ('completed', 'canceled', 'cancelled')
       AND lower(COALESCE(t.metadata->>'mobile_v2_reassign_request', 'false')) = 'true'
       AND (
         NULLIF(t.metadata->>'target_driver_user_id', '') IS NULL
         OR v_target_driver_id IS NULL
         OR NULLIF(t.metadata->>'target_driver_user_id', '') = v_target_driver_id::text
       )
  LOOP
    v_service_claims := COALESCE(NULLIF(v_prev_claims, '')::jsonb, '{}'::jsonb);
    IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
      v_service_claims := '{}'::jsonb;
    END IF;
    v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claims', v_service_claims::text, true);
    PERFORM set_config('app.actor_system', 'route_stop_reassign_task_bridge', true);
    BEGIN
      v_transition := public.transition_task_system_v1(
        v_task.id,
        'completed',
        'resolved_by_route_stop_reassignment',
        jsonb_strip_nulls(jsonb_build_object(
          'route_stop_reassignment_event_id', NEW.id,
          'route_stop_id', NEW.route_stop_id,
          'source_route_run_id', NEW.source_route_run_id,
          'target_route_run_id', NEW.target_route_run_id,
          'target_route_run_assignment_id', NEW.target_route_run_assignment_id
        )),
        'route_stop_reassign_task_bridge',
        format('fieldops-mobile-v2:reassign-request-complete:%s:%s', NEW.id, v_task.id)
      );

      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
    EXCEPTION
      WHEN others THEN
        PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
        PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
        PERFORM set_config('request.jwt.claims', v_prev_claims, true);
        PERFORM set_config('app.actor_system', v_prev_actor_system, true);
        RAISE;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_route_stop_reassign_complete_fieldops_request ON public.route_stop_reassignment_events;
CREATE TRIGGER trg_route_stop_reassign_complete_fieldops_request
  AFTER INSERT ON public.route_stop_reassignment_events
  FOR EACH ROW
  EXECUTE FUNCTION public.complete_fieldops_reassign_request_task_v1();

COMMENT ON FUNCTION public.complete_fieldops_reassign_request_task_v1() IS
  'Completes pending Mobile V2 reassignment request tasks when canonical route_stop_reassignment_events prove Dispatch moved the stop.';

SELECT pg_advisory_unlock(hashtext('202606010830_fieldops_mobile_v2_reassign_dispatch_task_bridge_v1'));
COMMIT;
