-- Console V2 dispatch subset reassignment may split a run that originated
-- from a route plan. The generated target route must keep lineage in metadata,
-- but it must not reuse route_plan_id because that column is unique per applied
-- plan.
DO $$
DECLARE
  v_function_definition text;
  v_next_definition text;
  v_old_fragment text := '      v_source_route_run.route_plan_id,' || chr(10) || '      v_target_route_idempotency,';
  v_new_fragment text := '      NULL,' || chr(10) || '      v_target_route_idempotency,';
BEGIN
  SELECT pg_get_functiondef('public.reassign_route_stops_v1(jsonb)'::regprocedure)
    INTO v_function_definition;

  IF v_function_definition IS NULL THEN
    RAISE EXCEPTION 'public.reassign_route_stops_v1(jsonb) is missing';
  END IF;

  IF position(v_old_fragment IN v_function_definition) = 0 THEN
    RAISE EXCEPTION 'public.reassign_route_stops_v1 route_plan_id insertion fragment not found';
  END IF;

  v_next_definition := replace(v_function_definition, v_old_fragment, v_new_fragment);
  IF v_next_definition = v_function_definition THEN
    RAISE EXCEPTION 'public.reassign_route_stops_v1 route_plan_id insertion fragment was not replaced';
  END IF;

  EXECUTE v_next_definition;
END;
$$;

COMMENT ON FUNCTION public.reassign_route_stops_v1(JSONB)
  IS 'Moves a subset of route stops to a generated target route while preserving assignment lineage; target routes created from route-plan source runs keep route plan lineage in metadata and do not reuse the unique route_plan_id.';
