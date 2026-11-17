-- Close the attempt-12 route-stop reference and pickup partner compatibility gaps.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;
SELECT pg_advisory_xact_lock(hashtext('20260919001000_attempt12_failure_union_repair_v1'));

CREATE OR REPLACE FUNCTION public.route_stop_task_contact_metadata_v1(
  p_route_stop_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_stop RECORD;
  v_assignment JSONB := '{}'::jsonb;
  v_support_contacts JSONB := '[]'::jsonb;
BEGIN
  IF p_route_stop_id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  SELECT
    rs.id,
    rs.route_run_id,
    rs.client_id,
    rs.shipment_id,
    rs.sequence_order,
    rs.stop_kind,
    rr.branch_id,
    s.sender_id,
    s.tracking_number,
    s.client_reference_number,
    COALESCE(
      NULLIF(btrim(COALESCE(s.client_reference_number, '')), ''),
      NULLIF(btrim(COALESCE(s.tracking_number, '')), '')
    ) AS display_reference,
    COALESCE(
      NULLIF(btrim(COALESCE(r.name, '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'customer_name', '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'recipient_name', '')), '')
    ) AS customer_name,
    COALESCE(
      NULLIF(btrim(COALESCE(r.phone_number, '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'customer_phone', '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'recipient_phone', '')), ''),
      NULLIF(btrim(COALESCE(s.metadata #>> '{customer,phone_number}', '')), '')
    ) AS customer_phone,
    a.id AS address_id,
    a.validation_status,
    a.sa_short_code,
    ST_Y(a.coordinates::geometry) AS latitude,
    ST_X(a.coordinates::geometry) AS longitude,
    a.raw_input,
    a.normalized_line1,
    a.normalized_line2,
    a.building_number,
    a.district,
    a.city,
    a.province,
    a.postal_code,
    a.country,
    a.additional_directions
  INTO v_stop
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
   AND rr.organization_id = rs.organization_id
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.client_id = rs.client_id
   AND s.organization_id = rs.organization_id
  LEFT JOIN public.recipients r
    ON r.id = s.recipient_id
   AND r.client_id = s.client_id
  LEFT JOIN public.addresses a
    ON a.id = s.destination_address_id
   AND a.client_id = s.client_id
   AND a.organization_id = s.organization_id
  WHERE rs.id = p_route_stop_id
    AND public.route_run_actor_can_read_v1(rs.organization_id, rs.route_run_id, rr.driver_user_id)
  LIMIT 1;

  IF v_stop.id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  v_assignment := COALESCE(public.route_run_assignment_projection_v1(v_stop.route_run_id), '{}'::jsonb);
  v_support_contacts := COALESCE(v_assignment #> '{metadata,support_contacts}', '[]'::jsonb);
  IF jsonb_typeof(v_support_contacts) IS DISTINCT FROM 'array' THEN
    v_support_contacts := '[]'::jsonb;
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_id', v_stop.route_run_id,
      'route_stop_id', v_stop.id,
      'branch_id', v_stop.branch_id,
      'client_id', v_stop.client_id,
      'sender_id', v_stop.sender_id,
      'route_stop',
        jsonb_strip_nulls(
          jsonb_build_object(
            'id', v_stop.id,
            'route_run_id', v_stop.route_run_id,
            'shipment_id', v_stop.shipment_id,
            'client_id', v_stop.client_id,
            'branch_id', v_stop.branch_id,
            'sequence_order', v_stop.sequence_order,
            'stop_kind', v_stop.stop_kind
          )
        ),
      'customer',
        CASE
          WHEN v_stop.customer_name IS NULL
            AND v_stop.customer_phone IS NULL
            AND v_stop.display_reference IS NULL
          THEN NULL
          ELSE jsonb_strip_nulls(
            jsonb_build_object(
              'name', v_stop.customer_name,
              'phone_number', v_stop.customer_phone,
              'reference', v_stop.display_reference,
              'client_reference_number', v_stop.client_reference_number,
              'tracking_number', v_stop.tracking_number
            )
          )
        END,
      'contact',
        CASE
          WHEN v_stop.customer_phone IS NULL THEN NULL
          ELSE jsonb_build_object('phone_number', v_stop.customer_phone)
        END,
      'address',
        CASE
          WHEN v_stop.address_id IS NULL
          THEN NULL
          ELSE jsonb_strip_nulls(
            jsonb_build_object(
              'id', v_stop.address_id,
              'validation_status', v_stop.validation_status,
              'sa_short_code', v_stop.sa_short_code,
              'coordinates', CASE WHEN v_stop.latitude IS NULL OR v_stop.longitude IS NULL THEN NULL
                ELSE jsonb_build_object('latitude', v_stop.latitude, 'longitude', v_stop.longitude) END,
              'address', v_stop.raw_input,
              'raw_input', v_stop.raw_input,
              'line1', v_stop.normalized_line1,
              'line2', v_stop.normalized_line2,
              'building_number', v_stop.building_number,
              'district', v_stop.district,
              'city', v_stop.city,
              'province', v_stop.province,
              'postal_code', v_stop.postal_code,
              'country', v_stop.country,
              'additional_directions', v_stop.additional_directions
            )
          )
        END,
      'support_contacts',
        CASE
          WHEN jsonb_array_length(v_support_contacts) = 0 THEN NULL
          ELSE v_support_contacts
        END
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID)
  IS 'Canonical route_stop task metadata fragment for Field Ops task context. Carries shipment display reference, customer/address data, and current route-assignment support contacts.';
REVOKE ALL ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID) TO authenticated, service_role;

-- Keep pickup assignment on the canonical route assignment ledger and task lifecycle.

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

  IF v_assignment_mode = 'unassigned' THEN
    IF EXISTS (
      SELECT 1
        FROM public.route_run_assignments rra
       WHERE rra.route_run_id = v_route_run_id
    ) THEN
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
     AND EXISTS (
       SELECT 1
         FROM public.route_run_assignments rra
        WHERE rra.route_run_id = v_route_run_id
          AND rra.assignment_mode = CASE WHEN v_assignment_mode = 'partner' THEN 'partner_fleet' ELSE 'internal_driver' END
          AND rra.driver_user_id IS NOT DISTINCT FROM CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END
          AND rra.vehicle_id IS NOT DISTINCT FROM CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END
          AND COALESCE(rra.partner, '{}'::jsonb) = COALESCE(CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END, '{}'::jsonb)
     ) THEN
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
               'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END
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
      'idempotency_key', v_idempotency_key
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
  IS 'Validate pickup-specific assignment policy, delegate ownership to canonical route assignment, and preserve pickup metadata and shipment audit rows.';
REVOKE ALL ON FUNCTION public.assign_pickup_wave_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_pickup_wave_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_pickup_wave_v1(JSONB) TO authenticated, service_role;

-- Adding a view column requires an explicit drop/recreate after all dependent
-- API views (none currently) and before the registry exposes the new field.
DROP VIEW IF EXISTS api.tasks_controls_v1;
CREATE VIEW api.tasks_controls_v1 WITH (security_invoker = true) AS
WITH task_projection AS (
 SELECT t.*,
   COALESCE(rs.planned_window_start_at, rr.planned_start_at) AS planned_at,
   COALESCE(NULLIF(t.metadata->>'area',''), NULLIF(t.metadata#>>'{address,district}',''),
     NULLIF(t.metadata#>>'{address,city}',''), NULLIF(t.metadata->>'city',''), '') AS area,
   COALESCE(NULLIF(t.metadata->>'reference',''), NULLIF(t.metadata#>>'{customer,reference}',''), t.id::text) AS sort_code
 FROM public.tasks t
 LEFT JOIN public.route_stops_visible_v1 rs
   ON t.resource_type = 'route_stop' AND t.resource_id = rs.id
   AND t.organization_id = rs.organization_id
   AND (t.client_id IS NULL OR t.client_id = rs.client_id)
 LEFT JOIN public.route_runs_visible_v1 rr
   ON t.resource_type = 'route_run' AND t.resource_id = rr.id
   AND t.organization_id = rr.organization_id
 WHERE auth.role() = 'service_role'
    OR (public.user_has_capability_v1('tasks.read', public.current_user_scope_type(), public.current_user_scope_id())
      AND (public.is_platform_user()
        OR (public.current_user_scope_type() = 'tenant' AND t.organization_id = public.current_user_org_id())
        OR (public.current_user_scope_type() = 'client' AND t.client_id = public.current_user_client_id())
        OR (public.current_user_scope_type() = 'sender' AND t.sender_id = public.current_user_sender_id())))
), classified AS (
 SELECT task_projection.*, CASE
   WHEN planned_at IS NULL THEN 'later'
   WHEN planned_at <= statement_timestamp() + INTERVAL '60 minutes' THEN 'now'
   WHEN planned_at::date = CURRENT_DATE THEN 'today'
   ELSE 'later' END AS urgency
 FROM task_projection
)
SELECT classified.*,
 CASE urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END AS urgency_order,
 jsonb_build_array(CASE urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END,
   -priority::numeric, CASE WHEN planned_at IS NULL THEN 1 ELSE 0 END,
   COALESCE(extract(epoch FROM planned_at),0), sort_code, id::text) AS smart_order,
 jsonb_build_array(-priority::numeric, sort_code, id::text) AS sort_priority,
 jsonb_build_array(CASE WHEN planned_at IS NULL THEN 1 ELSE 0 END,
   COALESCE(extract(epoch FROM planned_at),0), sort_code, id::text) AS sort_eta,
 jsonb_build_array(area, sort_code, id::text) AS sort_area,
 CASE WHEN urgency = 'now' THEN 1 ELSE 0 END AS urgency_now,
 CASE WHEN urgency = 'today' THEN 1 ELSE 0 END AS urgency_today,
 CASE WHEN urgency = 'later' THEN 1 ELSE 0 END AS urgency_later,
 NULLIF(btrim(COALESCE(classified.metadata->>'reference', classified.metadata#>>'{customer,reference}', '')), '') AS reference
FROM classified;
REVOKE ALL ON api.tasks_controls_v1 FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON api.tasks_controls_v1 TO authenticated, service_role;
COMMENT ON VIEW api.tasks_controls_v1 IS
 'Canonical task read projection with explicit caller scope; exact actor-visible route planned time and narrow display reference, never SLA or arbitrary metadata IDs. No task mutation authority.';

DO $registry$
DECLARE
 v_row RECORD;
 v_task JSONB;
 v_next JSONB;
 v_resources JSONB;
 v_select JSONB;
 v_promoted INTEGER := 0;
BEGIN
 FOR v_row IN
   SELECT s.id AS settings_id, s.settings_version_id, s.category, s.scope_type,
     s.scope_id, s.scope_hash, s.cached_value, sv.value, sv.schema_version
   FROM public.settings s
   JOIN public.settings_versions sv
     ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'ui_read_registry'
   ORDER BY s.id
   FOR UPDATE OF s, sv
 LOOP
   IF v_row.cached_value IS DISTINCT FROM v_row.value
      OR jsonb_typeof(v_row.value->'resources') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'UI read registry settings pair is inconsistent: %', v_row.settings_id;
   END IF;

   SELECT item INTO v_task
   FROM jsonb_array_elements(v_row.value->'resources') item
   WHERE item->>'key' = 'tasks';
   IF NOT FOUND THEN CONTINUE; END IF;

   IF (SELECT count(*) FROM jsonb_array_elements(v_row.value->'resources') item WHERE item->>'key' = 'tasks') <> 1
      OR v_task->>'relation' IS DISTINCT FROM 'public.tasks'
      OR v_task->>'read_relation' IS DISTINCT FROM 'api.tasks_controls_v1'
      OR v_task->>'id_column' IS DISTINCT FROM 'id'
      OR v_task->>'capability_read' IS DISTINCT FROM 'tasks.read'
      OR v_task->'scope_columns' IS DISTINCT FROM '{"tenant":"organization_id","client":"client_id","sender":"sender_id"}'::jsonb THEN
     RAISE EXCEPTION 'task registry authority differs from the canonical contract: %', v_row.settings_id;
   END IF;

   SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb)
     INTO v_select
     FROM (
       SELECT value, min(ord) AS ord
       FROM jsonb_array_elements(COALESCE(v_task->'select', '[]'::jsonb) || '["reference"]'::jsonb)
         WITH ORDINALITY selected(value, ord)
       GROUP BY value
     ) selected;

   v_task := jsonb_set(v_task, '{select}', v_select, TRUE);
   SELECT jsonb_agg(CASE WHEN item->>'key' = 'tasks' THEN v_task ELSE item END ORDER BY ord)
     INTO v_resources
     FROM jsonb_array_elements(v_row.value->'resources') WITH ORDINALITY r(item, ord);
   v_next := jsonb_set(v_row.value, '{resources}', v_resources);

   WITH closed AS (
     UPDATE public.settings_versions
        SET effective_until = GREATEST(clock_timestamp(), effective_from + INTERVAL '1 microsecond'),
            updated_at = clock_timestamp()
      WHERE id = v_row.settings_version_id
        AND scope_hash = v_row.scope_hash
        AND effective_until IS NULL
     RETURNING id
   ), inserted AS (
     INSERT INTO public.settings_versions(
       id, category, scope_type, scope_id, scope_hash, version, value,
       schema_version, change_reason, approved_at, effective_from
     )
     SELECT gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id, v_row.scope_hash,
       (SELECT COALESCE(MAX(candidate.version), 0) + 1
          FROM public.settings_versions candidate
         WHERE candidate.category = v_row.category
           AND candidate.scope_type = v_row.scope_type
           AND candidate.scope_hash = v_row.scope_hash),
       v_next, v_row.schema_version, 'Expose narrow task display reference',
       clock_timestamp(), clock_timestamp()
     FROM closed
     RETURNING id, value
   )
   UPDATE public.settings s
      SET settings_version_id = inserted.id,
          cached_value = inserted.value,
          last_updated = clock_timestamp()
     FROM inserted
    WHERE s.id = v_row.settings_id
      AND s.settings_version_id = v_row.settings_version_id;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'task registry reference promotion lost pointer CAS';
   END IF;
   v_promoted := v_promoted + 1;
 END LOOP;

 IF v_promoted = 0 THEN
   RAISE EXCEPTION 'canonical task registry settings missing';
 END IF;
 DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
END;
$registry$;

COMMIT;
