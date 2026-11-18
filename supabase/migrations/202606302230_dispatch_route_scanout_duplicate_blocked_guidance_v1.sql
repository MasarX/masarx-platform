-- Migration: Dispatch route scanout duplicate blocked guidance v1
-- Purpose:
--   - Keep blocked departure operator guidance aligned with reconciliation
--     states that include duplicate route-load scans.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606302230_dispatch_route_scanout_duplicate_blocked_guidance_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.confirm_route_run_departure_v1(
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_actor_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_route_run_id UUID := NULL;
  v_route_stop_id UUID := NULL;
  v_task_id UUID := NULL;
  v_ops_session_id UUID := NULL;
  v_route_run public.route_runs%ROWTYPE;
  v_has_routes_write BOOLEAN := FALSE;
  v_scan_out JSONB := '{}'::jsonb;
  v_existing_departure JSONB := '{}'::jsonb;
  v_route_departure JSONB := '{}'::jsonb;
  v_effective_status TEXT := NULL;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 requires object input'
      USING ERRCODE = '22023';
  END IF;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := v_org_id;
  END IF;

  PERFORM public.assert_capability_v1('tasks.complete', v_scope_type, v_scope_id);
  v_has_routes_write := public.user_has_capability_v1('routes.write', v_scope_type, v_scope_id);

  BEGIN
    v_route_run_id := NULLIF(btrim(COALESCE(v_input->>'route_run_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 invalid route_run_id'
      USING ERRCODE = '22P02';
  END;
  BEGIN
    v_route_stop_id := NULLIF(btrim(COALESCE(v_input->>'route_stop_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 invalid route_stop_id'
      USING ERRCODE = '22P02';
  END;
  BEGIN
    v_task_id := NULLIF(btrim(COALESCE(v_input->>'task_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 invalid task_id'
      USING ERRCODE = '22P02';
  END;
  BEGIN
    v_ops_session_id := NULLIF(btrim(COALESCE(v_input->>'ops_session_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 invalid ops_session_id'
      USING ERRCODE = '22P02';
  END;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 requires route_run_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 route_run % not found', v_route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user() AND v_org_id IS NOT NULL AND v_route_run.organization_id IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 route_run % is outside the current organization', v_route_run_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.route_run_actor_can_read_v1(
    v_route_run.organization_id,
    v_route_run.id,
    v_route_run.driver_user_id
  ) THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 route_run % is not visible to the current actor', v_route_run_id
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type = 'tenant'
     AND v_route_run.driver_user_id IS NOT NULL
     AND v_route_run.driver_user_id <> v_actor_id
     AND NOT v_has_routes_write THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 requires route ownership'
      USING ERRCODE = '42501';
  END IF;

  IF lower(COALESCE(v_route_run.status, '')) IN ('completed', 'canceled') THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 cannot mutate terminal route_run status %', v_route_run.status
      USING ERRCODE = '23514';
  END IF;

  IF v_route_stop_id IS NOT NULL THEN
    PERFORM 1
      FROM public.route_stops rs
     WHERE rs.id = v_route_stop_id
       AND rs.route_run_id = v_route_run.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirm_route_run_departure_v1 route_stop % is outside route_run %', v_route_stop_id, v_route_run_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_task_id IS NOT NULL THEN
    PERFORM 1
      FROM public.tasks t
      JOIN public.route_stops rs
        ON t.resource_type = 'route_stop'
       AND rs.id = t.resource_id
     WHERE t.id = v_task_id
       AND rs.route_run_id = v_route_run.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirm_route_run_departure_v1 task % is outside route_run %', v_task_id, v_route_run_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_ops_session_id IS NOT NULL THEN
    PERFORM 1
      FROM public.ops_sessions s
     WHERE s.id = v_ops_session_id
       AND s.organization_id = v_route_run.organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirm_route_run_departure_v1 ops_session % not found for route organization', v_ops_session_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  v_scan_out := COALESCE(public.route_run_scan_out_reconciliation_v1(v_route_run.id), '{}'::jsonb);
  IF COALESCE((v_scan_out->>'ready_for_departure')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'confirm_route_run_departure_v1 route_run % is not ready for departure (missing %, duplicate %, unexpected %)',
      v_route_run.id,
      COALESCE(v_scan_out->>'missing_stop_count', '0'),
      COALESCE(v_scan_out->>'duplicate_scan_count', '0'),
      COALESCE(v_scan_out->>'unexpected_scan_count', '0')
      USING ERRCODE = '23514';
  END IF;

  v_existing_departure := COALESCE(v_route_run.metadata->'route_departure', '{}'::jsonb);
  IF jsonb_typeof(v_existing_departure) IS DISTINCT FROM 'object' THEN
    v_existing_departure := '{}'::jsonb;
  END IF;

  IF NULLIF(COALESCE(v_existing_departure->>'confirmed_at', ''), '') IS NOT NULL THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'route_run_id', v_route_run.id,
        'status', v_route_run.status,
        'started_at', v_route_run.started_at,
        'scan_out', v_scan_out,
        'route_departure', v_existing_departure
      )
    );
  END IF;

  v_effective_status :=
    CASE
      WHEN lower(COALESCE(v_route_run.status, '')) = 'planned' THEN 'in_progress'
      ELSE v_route_run.status
    END;

  v_route_departure := jsonb_strip_nulls(
    jsonb_build_object(
      'confirmed_at', workflow_now(),
      'confirmed_by_user_id', v_actor_id,
      'route_stop_id', v_route_stop_id,
      'task_id', v_task_id,
      'ops_session_id', v_ops_session_id,
      'scan_out', v_scan_out
    )
  );

  UPDATE public.route_runs rr
     SET status = v_effective_status,
         started_at = COALESCE(rr.started_at, workflow_now()),
         metadata = jsonb_set(
           COALESCE(rr.metadata, '{}'::jsonb),
           '{route_departure}',
           v_route_departure,
           TRUE
         ),
         updated_at = workflow_now()
   WHERE rr.id = v_route_run.id;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_id', v_route_run.id,
      'status', v_effective_status,
      'started_at', COALESCE(v_route_run.started_at, workflow_now()),
      'scan_out', v_scan_out,
      'route_departure', v_route_departure
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.confirm_route_run_departure_v1(JSONB)
  IS 'Canonical route departure confirmation gate. Requires route-load scan reconciliation to be clean and reports missing, duplicate, and unexpected scan blockers before mutating route departure state.';

SELECT pg_advisory_unlock(hashtext('202606302230_dispatch_route_scanout_duplicate_blocked_guidance_v1'));
COMMIT;
