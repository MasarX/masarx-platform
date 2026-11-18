-- Migration: atomic pickup-wave partner reassignment v1
-- Purpose:
--   - Preserve the canonical partner-handoff guard when a pickup wave moves
--     from an internal driver (or another partner) to partner capacity.
--   - Keep task unassignment, route assignment, pickup projections, and audit
--     writes in one transaction under the original actor authority.

BEGIN;
SELECT pg_advisory_lock(hashtext('20260919005000_pickup_wave_partner_reassignment_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.assign_pickup_wave_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_service_role BOOLEAN := public.request_is_service_role_v1();
  v_is_platform BOOLEAN := public.is_platform_user();

  v_route_run_id UUID := NULL;
  v_org_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_reassignment_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'reassignment_reason', '')), '');
  v_notes TEXT := NULLIF(btrim(COALESCE(v_input->>'notes', '')), '');
  v_partner JSONB := COALESCE(v_input->'partner', '{}'::jsonb);
  v_metadata JSONB := COALESCE(v_input->'metadata', '{}'::jsonb);

  v_route_run RECORD;
  v_pickup_stop_count INT := 0;
  v_total_box_count INT := 0;

  v_policy_row RECORD;
  v_policy JSONB := public.pickup_policy_default_v1();
  v_assignment_policy JSONB := '{}'::jsonb;
  v_require_driver_or_partner BOOLEAN := TRUE;
  v_allow_partner_assignment BOOLEAN := TRUE;
  v_enforce_capacity BOOLEAN := FALSE;
  v_default_capacity_boxes INT := 100;

  v_partner_capacity_boxes INT := NULL;
  v_vehicle_capacity_boxes INT := NULL;
  v_driver_status TEXT := NULL;
  v_vehicle_status TEXT := NULL;
  v_assignment_mode TEXT := NULL;
  v_has_partner BOOLEAN := FALSE;
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
  v_route_assignment RECORD;
  v_current_assignment public.route_run_assignments%ROWTYPE;
  v_prepare_result RECORD;
  v_requires_partner_handoff BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_run_id := NULLIF(v_input->>'route_run_id', '')::uuid; EXCEPTION WHEN others THEN v_route_run_id := NULL; END;
  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_driver_user_id := NULLIF(v_input->>'driver_user_id', '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(v_input->>'vehicle_id', '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  IF jsonb_typeof(v_partner) IS DISTINCT FROM 'object' THEN
    v_partner := '{}'::jsonb;
  END IF;
  v_partner := jsonb_strip_nulls(
    v_partner || jsonb_build_object(
      'partner_id', NULLIF(btrim(COALESCE(v_partner->>'partner_id', '')), ''),
      'partner_name', COALESCE(
        NULLIF(btrim(v_partner->>'partner_name'), ''),
        NULLIF(btrim(v_partner->>'name'), '')
      )
    )
  );
  v_has_partner := EXISTS (SELECT 1 FROM jsonb_each(v_partner));
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 requires route_run_id' USING ERRCODE = '23514';
  END IF;

  SELECT rr.*
    INTO v_route_run
   FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 route_run not found: %', v_route_run_id USING ERRCODE = '23503';
  END IF;

  v_org_id := COALESCE(v_org_id, v_route_run.organization_id);
  IF v_org_id IS DISTINCT FROM v_route_run.organization_id THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 organization mismatch for route_run %', v_route_run_id USING ERRCODE = '23514';
  END IF;

  IF NOT v_service_role THEN
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 requires an authenticated user' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_platform AND public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 requires tenant/platform write scope' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_platform AND public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 organization mismatch for current tenant scope' USING ERRCODE = '42501';
    END IF;
    IF NOT public.user_has_permission_v1('fleet.write', v_org_id) THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 requires fleet.write permission' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Serialize mutation only after the caller's tenant and fleet authority is
  -- proven. Route-before-assignment order matches assign_route_run_v1.
  SELECT rr.*
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
     AND rr.organization_id = v_org_id
   FOR UPDATE;

  SELECT COUNT(*), COALESCE(SUM(s.box_count), 0)
    INTO v_pickup_stop_count, v_total_box_count
    FROM public.route_stops rs
    JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
   WHERE rs.route_run_id = v_route_run_id
     AND rs.organization_id = v_org_id
     AND lower(rs.stop_kind) = 'pickup';

  IF v_pickup_stop_count < 1 THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 route_run % is not a pickup wave', v_route_run_id USING ERRCODE = '23514';
  END IF;

  IF lower(COALESCE(v_route_run.status, '')) IN ('completed', 'canceled') THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 cannot assign terminal route_run status %', v_route_run.status USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_pickup_policy(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'resource_id', v_route_run.branch_id
      ))
    )
   LIMIT 1;

  IF v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  v_assignment_policy := COALESCE(v_policy->'assignment', '{}'::jsonb);
  IF jsonb_typeof(v_assignment_policy) IS DISTINCT FROM 'object' THEN
    v_assignment_policy := '{}'::jsonb;
  END IF;

  BEGIN v_require_driver_or_partner := COALESCE((v_assignment_policy->>'require_driver_or_partner')::boolean, TRUE); EXCEPTION WHEN others THEN v_require_driver_or_partner := TRUE; END;
  BEGIN v_allow_partner_assignment := COALESCE((v_assignment_policy->>'allow_partner_assignment')::boolean, TRUE); EXCEPTION WHEN others THEN v_allow_partner_assignment := TRUE; END;
  BEGIN v_enforce_capacity := COALESCE((v_assignment_policy->>'enforce_capacity')::boolean, FALSE); EXCEPTION WHEN others THEN v_enforce_capacity := FALSE; END;
  BEGIN v_default_capacity_boxes := COALESCE(NULLIF(v_assignment_policy->>'default_capacity_boxes', '')::int, 100); EXCEPTION WHEN others THEN v_default_capacity_boxes := 100; END;

  IF v_driver_user_id IS NOT NULL AND v_has_partner THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 supports either internal driver assignment or partner assignment, not both' USING ERRCODE = '23514';
  END IF;

  IF v_driver_user_id IS NULL AND NOT v_has_partner AND v_require_driver_or_partner THEN
    RAISE EXCEPTION 'assign_pickup_wave_v1 requires driver_user_id or partner assignment' USING ERRCODE = '23514';
  END IF;

  IF v_has_partner THEN
    IF NOT v_allow_partner_assignment THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 partner assignment is disabled by policy' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(btrim(COALESCE(v_partner->>'partner_name', v_partner->>'name', '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(v_partner->>'partner_id', '')), '') IS NULL THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 partner assignment requires partner_id or partner_name' USING ERRCODE = '23514';
    END IF;
    BEGIN v_partner_capacity_boxes := COALESCE(NULLIF(v_partner->>'capacity_boxes', '')::int, NULLIF(v_partner#>>'{capacity,boxes}', '')::int); EXCEPTION WHEN others THEN v_partner_capacity_boxes := NULL; END;
    v_assignment_mode := 'partner';
  ELSE
    IF v_driver_user_id IS NOT NULL THEN
      SELECT lower(COALESCE(u.status, ''))
        INTO v_driver_status
        FROM public.users u
       WHERE u.id = v_driver_user_id
         AND u.organization_id = v_org_id
       LIMIT 1;

      IF v_driver_status IS NULL THEN
        RAISE EXCEPTION 'assign_pickup_wave_v1 driver not found: %', v_driver_user_id USING ERRCODE = '23503';
      END IF;
      IF v_driver_status <> 'active' THEN
        RAISE EXCEPTION 'assign_pickup_wave_v1 driver is not active: %', v_driver_status USING ERRCODE = '23514';
      END IF;
    END IF;

    IF v_vehicle_id IS NOT NULL THEN
      SELECT
        lower(COALESCE(v.status, '')),
        COALESCE(
          CASE WHEN v.metadata ? 'capacity_boxes' THEN NULLIF(v.metadata->>'capacity_boxes', '')::int ELSE NULL END,
          CASE WHEN v.metadata #> '{capacity,boxes}' IS NOT NULL THEN NULLIF(v.metadata#>>'{capacity,boxes}', '')::int ELSE NULL END,
          CASE WHEN vt.metadata ? 'capacity_boxes' THEN NULLIF(vt.metadata->>'capacity_boxes', '')::int ELSE NULL END,
          CASE WHEN vt.metadata #> '{capacity,boxes}' IS NOT NULL THEN NULLIF(vt.metadata#>>'{capacity,boxes}', '')::int ELSE NULL END,
          v_default_capacity_boxes
        )
        INTO v_vehicle_status, v_vehicle_capacity_boxes
        FROM public.vehicles v
        LEFT JOIN public.vehicle_types vt
          ON vt.id = v.vehicle_type_id
       WHERE v.id = v_vehicle_id
         AND v.organization_id = v_org_id
       LIMIT 1;

      IF v_vehicle_status IS NULL THEN
        RAISE EXCEPTION 'assign_pickup_wave_v1 vehicle not found: %', v_vehicle_id USING ERRCODE = '23503';
      END IF;
      IF v_vehicle_status <> 'active' THEN
        RAISE EXCEPTION 'assign_pickup_wave_v1 vehicle is not active: %', v_vehicle_status USING ERRCODE = '23514';
      END IF;
    END IF;

    v_assignment_mode := CASE
      WHEN v_driver_user_id IS NOT NULL THEN 'internal_driver'
      ELSE 'unassigned'
    END;
  END IF;

  IF v_enforce_capacity THEN
    IF v_assignment_mode = 'partner' AND v_partner_capacity_boxes IS NOT NULL AND v_total_box_count > v_partner_capacity_boxes THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 partner capacity exceeded (% boxes > % capacity)', v_total_box_count, v_partner_capacity_boxes USING ERRCODE = '23514';
    END IF;
    IF v_assignment_mode <> 'partner'
       AND v_vehicle_id IS NOT NULL
       AND COALESCE(v_vehicle_capacity_boxes, v_default_capacity_boxes) IS NOT NULL
       AND v_total_box_count > COALESCE(v_vehicle_capacity_boxes, v_default_capacity_boxes) THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 vehicle capacity exceeded (% boxes > % capacity)', v_total_box_count, COALESCE(v_vehicle_capacity_boxes, v_default_capacity_boxes) USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT *
    INTO v_current_assignment
    FROM public.route_run_assignments rra
   WHERE rra.route_run_id = v_route_run_id
   FOR UPDATE;

  IF v_assignment_mode = 'unassigned' THEN
    IF v_current_assignment.id IS NOT NULL THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 cannot clear a canonical route assignment; use the supported reassignment lifecycle'
        USING ERRCODE = '23514';
    END IF;

    IF v_idempotency_key IS NOT NULL
       AND COALESCE(v_route_run.metadata #>> '{pickup_assignment,idempotency_key}', '') = v_idempotency_key THEN
      RETURN jsonb_strip_nulls(jsonb_build_object(
        'route_run_id', v_route_run_id,
        'assignment_mode', 'unassigned',
        'box_count', v_total_box_count,
        'created', FALSE
      ));
    END IF;
  ELSIF v_idempotency_key IS NOT NULL
     AND COALESCE(v_route_run.metadata #>> '{pickup_assignment,idempotency_key}', '') = v_idempotency_key
     AND v_current_assignment.id IS NOT NULL
     AND v_current_assignment.assignment_mode = (CASE WHEN v_assignment_mode = 'partner' THEN 'partner_fleet' ELSE 'internal_driver' END)
     AND v_current_assignment.driver_user_id IS NOT DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END)
     AND v_current_assignment.vehicle_id IS NOT DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END)
     AND COALESCE(v_current_assignment.partner, '{}'::jsonb) = COALESCE(CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END, '{}'::jsonb) THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_route_run_id,
      'assignment_mode', COALESCE(v_route_run.metadata #>> '{pickup_assignment,assignment_mode}', v_assignment_mode),
      'driver_user_id', v_route_run.driver_user_id,
      'vehicle_id', v_route_run.vehicle_id,
      'partner', v_route_run.metadata #> '{pickup_assignment,partner}',
      'box_count', v_total_box_count,
      'created', FALSE
    ));
  END IF;

  v_requires_partner_handoff :=
    v_assignment_mode = 'partner'
    AND v_current_assignment.id IS NOT NULL
    AND (
      v_current_assignment.assignment_mode IS DISTINCT FROM 'partner_fleet'
      OR v_current_assignment.driver_user_id IS NOT NULL
      OR v_current_assignment.vehicle_id IS NOT NULL
      OR COALESCE(v_current_assignment.partner, '{}'::jsonb) <> v_partner
    );

  IF v_requires_partner_handoff THEN
    IF v_reassignment_reason IS NULL THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 requires reassignment_reason when replacing canonical route ownership'
        USING ERRCODE = '23514';
    END IF;

    SELECT *
      INTO v_prepare_result
      FROM public.route_run_prepare_partner_handoff_v1(
        v_route_run_id,
        NULL,
        COALESCE(v_notes, v_reassignment_reason),
        'public.assign_pickup_wave_v1'
      )
     LIMIT 1;

    v_metadata := jsonb_strip_nulls(
      v_metadata || jsonb_build_object('reassignment_reason', v_reassignment_reason)
    );
  END IF;

  IF v_assignment_mode <> 'unassigned' THEN
    BEGIN
      v_service_claims := NULLIF(v_prev_claims, '')::jsonb;
    EXCEPTION
      WHEN others THEN
        v_service_claims := '{}'::jsonb;
    END;
    IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
      v_service_claims := '{}'::jsonb;
    END IF;
    v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

    BEGIN
      PERFORM set_config('app.actor_system', 'public.assign_pickup_wave_v1', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

      SELECT *
        INTO v_route_assignment
        FROM public.assign_route_run_v1(
          jsonb_strip_nulls(jsonb_build_object(
            'route_run_id', v_route_run_id,
            'assignment_mode', CASE WHEN v_assignment_mode = 'partner' THEN 'partner_fleet' ELSE 'internal_driver' END,
            'driver_user_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
            'vehicle_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END,
            'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END,
            'partner_id', CASE WHEN v_assignment_mode = 'partner'
              THEN NULLIF(btrim(COALESCE(v_partner->>'partner_id', '')), '') ELSE NULL END,
            'partner_name', CASE WHEN v_assignment_mode = 'partner'
              THEN NULLIF(btrim(COALESCE(v_partner->>'partner_name', v_partner->>'name', '')), '') ELSE NULL END,
            'name', CASE WHEN v_assignment_mode = 'partner'
              THEN NULLIF(btrim(COALESCE(v_partner->>'name', v_partner->>'partner_name', '')), '') ELSE NULL END,
            'notes', v_notes,
            'metadata', NULLIF(v_metadata, '{}'::jsonb),
            'idempotency_key', v_idempotency_key,
            'actor_user_id', v_user_id,
            'actor_system', 'public.assign_pickup_wave_v1'
          ))
        );
    EXCEPTION
      WHEN others THEN
        PERFORM set_config('request.jwt.claims', v_prev_claims, true);
        PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
        PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
        PERFORM set_config('app.actor_system', v_prev_actor_system, true);
        RAISE;
    END;

    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
    PERFORM set_config('app.actor_system', v_prev_actor_system, true);

    IF v_route_assignment.route_run_id IS NULL
       OR v_route_assignment.assignment_mode IS DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN 'partner_fleet' ELSE 'internal_driver' END)
       OR v_route_assignment.driver_user_id IS DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END)
       OR v_route_assignment.vehicle_id IS DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END)
       OR COALESCE(v_route_assignment.partner, '{}'::jsonb) <> COALESCE(CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END, '{}'::jsonb) THEN
      RAISE EXCEPTION 'assign_pickup_wave_v1 idempotency replay conflicts with the current canonical route assignment state'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.route_runs rr
     SET driver_user_id = CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
         vehicle_id = CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END,
         metadata = public.jsonb_deep_merge(
           COALESCE(rr.metadata, '{}'::jsonb),
           jsonb_strip_nulls(jsonb_build_object(
             'pickup_assignment', jsonb_strip_nulls(jsonb_build_object(
               'assignment_mode', v_assignment_mode,
               'driver_user_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
               'vehicle_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END,
               'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END,
               'box_count', v_total_box_count,
               'idempotency_key', v_idempotency_key,
               'reassignment_reason', v_reassignment_reason,
               'notes', v_notes,
               'assigned_by_user_id', v_user_id,
               'assigned_at', now()
             )),
             'metadata', v_metadata
           ))
         ),
         updated_at = now()
   WHERE rr.id = v_route_run_id
     AND rr.organization_id = v_org_id;

  UPDATE public.shipments s
     SET driver_user_id = CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
         updated_at = now(),
         metadata = public.jsonb_deep_merge(
           COALESCE(s.metadata, '{}'::jsonb),
           jsonb_strip_nulls(jsonb_build_object(
             'pickup_assignment', jsonb_strip_nulls(jsonb_build_object(
               'route_run_id', v_route_run_id,
               'assignment_mode', v_assignment_mode,
               'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END,
               'reassignment_reason', v_reassignment_reason
             ))
           ))
         )
   WHERE EXISTS (
     SELECT 1
     FROM public.route_stops rs
     WHERE rs.route_run_id = v_route_run_id
       AND rs.organization_id = v_org_id
       AND rs.shipment_id = s.id
       AND rs.client_id = s.client_id
       AND lower(rs.stop_kind) = 'pickup'
   );

  INSERT INTO public.shipment_actions (
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_user_id,
    performed_by_system,
    action_data,
    timestamp
  )
  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    'pickup_wave_assign',
    'operational',
    s.status,
    v_user_id,
    'public.assign_pickup_wave_v1',
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_route_run_id,
      'assignment_mode', v_assignment_mode,
      'driver_user_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
      'vehicle_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END,
      'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END,
      'idempotency_key', v_idempotency_key,
      'reassignment_reason', v_reassignment_reason,
      'notes', v_notes
    )),
    now()
  FROM public.shipments s
  WHERE EXISTS (
    SELECT 1
    FROM public.route_stops rs
    WHERE rs.route_run_id = v_route_run_id
      AND rs.organization_id = v_org_id
      AND rs.shipment_id = s.id
      AND rs.client_id = s.client_id
      AND lower(rs.stop_kind) = 'pickup'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'route_run_id', v_route_run_id,
    'assignment_mode', v_assignment_mode,
    'driver_user_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END,
    'vehicle_id', CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END,
    'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END,
    'box_count', v_total_box_count,
    'created', TRUE
  ));
END;
$function$;

COMMENT ON FUNCTION public.assign_pickup_wave_v1(JSONB)
  IS 'Validate pickup policy, atomically prepare explicit partner handoff when canonical ownership changes, delegate route ownership, and preserve pickup projections and audit rows.';
REVOKE ALL ON FUNCTION public.assign_pickup_wave_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_pickup_wave_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_pickup_wave_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('20260919005000_pickup_wave_partner_reassignment_v1'));
COMMIT;
