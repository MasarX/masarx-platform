-- Migration: route plan publish apply contract compat v1
-- Purpose:
--   - Restore UC075 apply semantics after the later constraint-guard migration
--     redefined public.apply_route_plan_v1.
--   - Keep constraint validation from the current base while allowing published
--     route plans and propagating the canonical execution-pack hash downstream.

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  route_run_id UUID,
  stop_ids UUID[],
  created BOOLEAN,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_route_plan_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_idempotency_key TEXT := NULL;

  v_plan RECORD;
  v_stops JSONB := '[]'::jsonb;
  v_create_result RECORD;
  v_existing_route_run_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;
  v_from_status TEXT := NULL;
  v_execution_pack_hash TEXT := NULL;
  v_constraint_report JSONB := '{}'::jsonb;
  v_constraint_messages TEXT := NULL;
  v_constraint_valid BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'apply_route_plan_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid; EXCEPTION WHEN others THEN v_route_plan_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');
  v_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), ''),
    format('route-plan:%s:apply', v_route_plan_id)
  );

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'apply_route_plan_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT rp.*
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = v_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'apply_route_plan_v1 route_plan % not found', v_route_plan_id USING ERRCODE = '23503';
  END IF;

  v_from_status := v_plan.status;
  v_execution_pack_hash := NULLIF(COALESCE(v_plan.published_execution_pack_hash, ''), '');

  SELECT rr.id
    INTO v_existing_route_run_id
    FROM public.route_runs rr
   WHERE rr.route_plan_id = v_route_plan_id
   LIMIT 1;

  IF v_plan.status = 'applied' AND v_existing_route_run_id IS NOT NULL THEN
    route_plan_id := v_route_plan_id;
    route_run_id := v_existing_route_run_id;
    stop_ids := ARRAY(
      SELECT rs.id
      FROM public.route_stops rs
      WHERE rs.route_run_id = v_existing_route_run_id
      ORDER BY rs.sequence_order
    );
    created := FALSE;
    status := 'applied';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_plan.status NOT IN ('frozen', 'published') THEN
    RAISE EXCEPTION 'apply_route_plan_v1 requires route_plan % to be frozen/published (got %)', v_route_plan_id, v_plan.status
      USING ERRCODE = '23514';
  END IF;

  v_stops := public.route_plan_resolve_stops_v1(v_route_plan_id);
  IF jsonb_typeof(v_stops) <> 'array' OR jsonb_array_length(v_stops) < 1 THEN
    RAISE EXCEPTION 'apply_route_plan_v1 requires a frozen/published route_plan with at least one stop' USING ERRCODE = '23514';
  END IF;

  v_constraint_report := public.route_plan_validate_constraints_v1(v_route_plan_id);

  BEGIN
    v_constraint_valid := COALESCE((v_constraint_report->>'valid')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_constraint_valid := FALSE;
  END;

  IF v_constraint_valid IS NOT TRUE THEN
    SELECT string_agg(item.value->>'message', '; ' ORDER BY item.ord)
      INTO v_constraint_messages
      FROM jsonb_array_elements(COALESCE(v_constraint_report->'violations', '[]'::jsonb)) WITH ORDINALITY AS item(value, ord);

    RAISE EXCEPTION 'apply_route_plan_v1 constraint validation failed for route_plan %: %',
      v_route_plan_id,
      COALESCE(v_constraint_messages, 'unknown violation')
      USING ERRCODE = '23514',
            DETAIL = left(COALESCE(v_constraint_report::text, '{}'), 4000);
  END IF;

  BEGIN v_driver_user_id := NULLIF(COALESCE(v_plan.solution->>'driver_user_id', v_plan.inputs->>'driver_user_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(COALESCE(v_plan.solution->>'vehicle_id', v_plan.inputs->>'vehicle_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  SELECT *
    INTO v_create_result
    FROM public.create_route_run_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_plan.organization_id,
        'branch_id', v_plan.branch_id,
        'driver_user_id', v_driver_user_id,
        'vehicle_id', v_vehicle_id,
        'planned_date', v_plan.planned_date,
        'status', 'planned',
        'idempotency_key', v_idempotency_key,
        'stops', v_stops,
        'metadata',
          COALESCE(v_plan.metadata, '{}'::jsonb)
          || jsonb_strip_nulls(
            jsonb_build_object(
              'route_plan_id', v_plan.id,
              'route_plan_version', v_plan.version,
              'route_plan_execution_pack_hash', v_execution_pack_hash
            )
          )
      ))
    )
    LIMIT 1;

  UPDATE public.route_runs
     SET route_plan_id = v_route_plan_id,
         updated_at = now()
   WHERE id = v_create_result.route_run_id
     AND (
       public.route_runs.route_plan_id IS NULL
       OR public.route_runs.route_plan_id = v_route_plan_id
     );

  IF NOT EXISTS (
    SELECT 1
    FROM public.route_runs rr
    WHERE rr.id = v_create_result.route_run_id
      AND rr.route_plan_id = v_route_plan_id
  ) THEN
    RAISE EXCEPTION 'apply_route_plan_v1 could not link route_run % to route_plan %', v_create_result.route_run_id, v_route_plan_id
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.route_plans
     SET status = 'applied',
         applied_at = COALESCE(applied_at, now()),
         metadata = public.deep_merge_jsonb(
           COALESCE(metadata, '{}'::jsonb),
           jsonb_build_object('constraint_validation', v_constraint_report)
         ),
         updated_at = now()
   WHERE id = v_route_plan_id;

  PERFORM public.route_plan_log_event_v1(
    v_route_plan_id,
    'applied',
    v_from_status,
    'applied',
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_create_result.route_run_id,
      'stop_ids', to_jsonb(v_create_result.stop_ids),
      'constraint_validation', v_constraint_report,
      'execution_pack_hash', v_execution_pack_hash
    )),
    v_actor_user_id,
    v_actor_system,
    v_idempotency_key
  );

  route_plan_id := v_route_plan_id;
  route_run_id := v_create_result.route_run_id;
  stop_ids := v_create_result.stop_ids;
  created := COALESCE(v_create_result.created, FALSE);
  status := 'applied';
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.apply_route_plan_v1(JSONB) IS
  'Service write-path: apply a frozen/published route_plan into route_runs/route_stops while preserving current constraint validation and carrying the published execution-pack hash downstream.';

COMMIT;
