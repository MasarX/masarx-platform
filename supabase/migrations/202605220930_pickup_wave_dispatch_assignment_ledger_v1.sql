-- Pickup wave assignments must feed the canonical Dispatch assignment ledger.

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('202605220930_pickup_wave_dispatch_assignment_ledger_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
BEGIN
  IF to_regprocedure('public.assign_pickup_wave_base_v1(jsonb)') IS NULL THEN
    ALTER FUNCTION public.assign_pickup_wave_v1(JSONB) RENAME TO assign_pickup_wave_base_v1;
  END IF;
END;
$do$;

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
  v_result JSONB := '{}'::jsonb;
  v_route_run_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;
  v_actor_user_id UUID := auth.uid();
  v_assignment_mode TEXT := NULL;
  v_route_assignment_mode TEXT := NULL;
  v_partner JSONB := '{}'::jsonb;
  v_assignment_input JSONB := '{}'::jsonb;
  v_assignment_result RECORD;
  v_route_run RECORD;
  v_claims JSONB := '{}'::jsonb;
  v_service_claims JSONB := '{}'::jsonb;
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
BEGIN
  IF NULLIF(v_input->>'idempotency_key', '') IS NULL
     AND NULLIF(v_input->>'route_run_id', '') IS NOT NULL THEN
    v_input := v_input || jsonb_build_object(
      'idempotency_key',
      'assign_pickup_wave_v1:' || md5(jsonb_build_object(
        'route_run_id', v_input->>'route_run_id',
        'driver_user_id', v_input->>'driver_user_id',
        'vehicle_id', v_input->>'vehicle_id',
        'partner', COALESCE(v_input->'partner', '{}'::jsonb)
      )::text)
    );
  END IF;

  v_result := public.assign_pickup_wave_base_v1(v_input);

  BEGIN v_route_run_id := NULLIF(COALESCE(v_result->>'route_run_id', v_result->>'wave_id', v_input->>'route_run_id'), '')::uuid; EXCEPTION WHEN others THEN v_route_run_id := NULL; END;
  IF v_route_run_id IS NULL THEN
    RETURN v_result;
  END IF;

  SELECT rr.*
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RETURN v_result;
  END IF;

  BEGIN v_driver_user_id := NULLIF(COALESCE(v_result->>'driver_user_id', v_input->>'driver_user_id', v_route_run.driver_user_id::text), '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(COALESCE(v_result->>'vehicle_id', v_input->>'vehicle_id', v_route_run.vehicle_id::text), '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;
  BEGIN v_actor_user_id := COALESCE(v_actor_user_id, NULLIF(v_route_run.metadata #>> '{pickup_assignment,assigned_by_user_id}', '')::uuid); EXCEPTION WHEN others THEN v_actor_user_id := auth.uid(); END;

  v_assignment_mode := lower(NULLIF(COALESCE(
    v_result->>'assignment_mode',
    v_input->>'assignment_mode',
    v_route_run.metadata #>> '{pickup_assignment,assignment_mode}'
  ), ''));

  v_partner := COALESCE(v_result->'partner', v_input->'partner', v_route_run.metadata #> '{pickup_assignment,partner}', '{}'::jsonb);
  IF jsonb_typeof(v_partner) IS DISTINCT FROM 'object' THEN
    v_partner := '{}'::jsonb;
  END IF;
  v_partner := jsonb_strip_nulls(v_partner);

  v_route_assignment_mode := CASE
    WHEN v_assignment_mode IN ('partner', 'partner_fleet') OR v_partner <> '{}'::jsonb THEN 'partner_fleet'
    WHEN v_driver_user_id IS NOT NULL THEN 'internal_driver'
    ELSE NULL
  END;

  IF v_route_assignment_mode IS NULL THEN
    RETURN v_result;
  END IF;

  v_assignment_input := jsonb_strip_nulls(jsonb_build_object(
    'route_run_id', v_route_run_id,
    'driver_user_id', CASE WHEN v_route_assignment_mode = 'internal_driver' THEN v_driver_user_id ELSE NULL END,
    'vehicle_id', CASE WHEN v_route_assignment_mode = 'internal_driver' THEN v_vehicle_id ELSE NULL END,
    'partner', CASE WHEN v_route_assignment_mode = 'partner_fleet' THEN v_partner ELSE NULL END,
    'notes', NULLIF(v_input->>'notes', ''),
    'idempotency_key', 'dispatch:' || COALESCE(
      NULLIF(v_input->>'idempotency_key', ''),
      'assign_pickup_wave_v1:' || v_route_run_id::text || ':' || COALESCE(v_driver_user_id::text, md5(v_partner::text))
    ),
    'metadata', jsonb_strip_nulls(jsonb_build_object(
      'source', 'assign_pickup_wave_v1',
      'pickup_assignment', COALESCE(v_route_run.metadata->'pickup_assignment', '{}'::jsonb)
    )),
    'actor_user_id', v_actor_user_id,
    'actor_system', 'public.assign_pickup_wave_v1'
  ));

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN others THEN
    v_claims := '{}'::jsonb;
  END;
  IF jsonb_typeof(v_claims) IS DISTINCT FROM 'object' THEN
    v_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', 'public.assign_pickup_wave_v1', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

  BEGIN
    SELECT *
      INTO v_assignment_result
      FROM public.assign_route_run_v1(v_assignment_input)
     LIMIT 1;
  EXCEPTION WHEN others THEN
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

  RETURN jsonb_strip_nulls(
    v_result || jsonb_build_object(
      'route_run_assignment_id', v_assignment_result.route_run_assignment_id,
      'assignment_status', v_assignment_result.assignment_status,
      'route_assignment_mode', v_assignment_result.assignment_mode,
      'assignment_version', v_assignment_result.assignment_version,
      'assigned_task_count', v_assignment_result.assigned_task_count,
      'stop_task_count', v_assignment_result.stop_task_count
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.assign_pickup_wave_v1(JSONB)
  IS 'Assign a pickup wave, then synchronize the canonical Dispatch route_run_assignments projection, event ledger, and route_stop_execute task ownership through assign_route_run_v1.';
REVOKE ALL ON FUNCTION public.assign_pickup_wave_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_pickup_wave_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_pickup_wave_v1(JSONB) TO authenticated, service_role;

DO $do$
DECLARE
  v_row RECORD;
  v_actor UUID := NULL;
  v_partner JSONB := '{}'::jsonb;
  v_input JSONB := '{}'::jsonb;
  v_claims JSONB := '{}'::jsonb;
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN others THEN
    v_claims := '{}'::jsonb;
  END;
  IF jsonb_typeof(v_claims) IS DISTINCT FROM 'object' THEN
    v_claims := '{}'::jsonb;
  END IF;

  PERFORM set_config('app.actor_system', 'pickup_wave_assignment_backfill', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', ((v_claims - 'sub') || jsonb_build_object('role', 'service_role'))::text, true);

  FOR v_row IN
    SELECT rr.*
      FROM public.route_runs rr
     WHERE NOT EXISTS (
             SELECT 1
               FROM public.route_run_assignments rra
              WHERE rra.route_run_id = rr.id
           )
       AND EXISTS (
             SELECT 1
               FROM public.route_stops rs
              WHERE rs.route_run_id = rr.id
                AND rs.organization_id = rr.organization_id
                AND lower(rs.stop_kind) = 'pickup'
           )
       AND (
             rr.driver_user_id IS NOT NULL
             OR jsonb_strip_nulls(COALESCE(rr.metadata #> '{pickup_assignment,partner}', '{}'::jsonb)) <> '{}'::jsonb
           )
  LOOP
    BEGIN v_actor := NULLIF(v_row.metadata #>> '{pickup_assignment,assigned_by_user_id}', '')::uuid; EXCEPTION WHEN others THEN v_actor := NULL; END;
    v_partner := jsonb_strip_nulls(COALESCE(v_row.metadata #> '{pickup_assignment,partner}', '{}'::jsonb));

    v_input := jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_row.id,
      'driver_user_id', CASE WHEN v_partner = '{}'::jsonb THEN v_row.driver_user_id ELSE NULL END,
      'vehicle_id', CASE WHEN v_partner = '{}'::jsonb THEN v_row.vehicle_id ELSE NULL END,
      'partner', CASE WHEN v_partner <> '{}'::jsonb THEN v_partner ELSE NULL END,
      'idempotency_key', 'pickup-wave-assignment-backfill:' || v_row.id::text,
      'metadata', jsonb_build_object(
        'source', 'pickup_wave_assignment_backfill',
        'pickup_assignment', COALESCE(v_row.metadata->'pickup_assignment', '{}'::jsonb)
      ),
      'actor_user_id', v_actor,
      'actor_system', 'pickup_wave_assignment_backfill'
    ));

    PERFORM 1 FROM public.assign_route_run_v1(v_input);
  END LOOP;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
EXCEPTION WHEN others THEN
  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
  RAISE;
END;
$do$;

COMMIT;
