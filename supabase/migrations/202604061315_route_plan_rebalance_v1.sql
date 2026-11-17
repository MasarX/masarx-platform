-- Migration: Route plan rebalance v1
-- Purpose:
--   - Add the canonical route-plan rebalance contract for UC074.
--   - Keep rebalance planning-only on route_plans and route_plan_events.
--   - Expose browser-safe UI/API wrappers and a dedicated UI command RPC.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604061315_route_plan_rebalance_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------
-- 1) Canonical planning-only rebalance service
-------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rebalance_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  source_route_plan_id UUID,
  target_route_plan_id UUID,
  target_created BOOLEAN,
  moved_stop_count INT,
  source_stop_count INT,
  target_stop_count INT,
  source_status TEXT,
  target_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_source_route_plan_id UUID := NULL;
  v_target_route_plan_id UUID := NULL;
  v_target_branch_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_idempotency_seed JSONB := '{}'::jsonb;
  v_source_plan public.route_plans%ROWTYPE;
  v_target_plan public.route_plans%ROWTYPE;
  v_target_create RECORD;
  v_existing_event_payload JSONB := NULL;
  v_existing_target_created BOOLEAN := FALSE;
  v_selected_shipment_ids TEXT[] := ARRAY[]::TEXT[];
  v_source_stops JSONB := '[]'::jsonb;
  v_target_stops JSONB := '[]'::jsonb;
  v_moved_stops JSONB := '[]'::jsonb;
  v_remaining_stops JSONB := '[]'::jsonb;
  v_target_next_stops JSONB := '[]'::jsonb;
  v_source_solution JSONB := '{}'::jsonb;
  v_target_solution JSONB := '{}'::jsonb;
  v_selected_count INT := 0;
  v_present_count INT := 0;
  v_source_total_count INT := 0;
  v_target_total_count INT := 0;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_source_route_plan_id := NULLIF(v_input->>'source_route_plan_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_source_route_plan_id := NULL;
  END;

  BEGIN
    v_target_route_plan_id := NULLIF(v_input->>'target_route_plan_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_target_route_plan_id := NULL;
  END;

  BEGIN
    v_target_branch_id := NULLIF(v_input->>'target_branch_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_target_branch_id := NULL;
  END;

  BEGIN
    v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;

  IF v_source_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 missing source_route_plan_id'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_input->'shipment_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 requires shipment_ids array'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT value ORDER BY value), ARRAY[]::TEXT[])
    INTO v_selected_shipment_ids
    FROM jsonb_array_elements_text(v_input->'shipment_ids') AS item(value)
   WHERE NULLIF(btrim(COALESCE(value, '')), '') IS NOT NULL;

  v_selected_count := COALESCE(array_length(v_selected_shipment_ids, 1), 0);
  IF v_selected_count < 1 THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 requires at least one shipment_id'
      USING ERRCODE = '23514';
  END IF;

  IF v_source_route_plan_id = v_target_route_plan_id THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 source and target route_plan must differ'
      USING ERRCODE = '23514';
  END IF;

  IF v_idempotency_key IS NULL THEN
    v_idempotency_seed := jsonb_build_object(
      'source_route_plan_id', v_source_route_plan_id,
      'target_route_plan_id', v_target_route_plan_id,
      'target_branch_id', v_target_branch_id,
      'shipment_ids', (
        SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value), '[]'::jsonb)
        FROM unnest(v_selected_shipment_ids) AS item(value)
      )
    );
    v_idempotency_key := 'route-plan-rebalance:' || encode(digest(v_idempotency_seed::text, 'sha256'), 'hex');
  END IF;

  SELECT *
    INTO v_source_plan
    FROM public.route_plans rp
   WHERE rp.id = v_source_route_plan_id
   LIMIT 1;

  IF v_source_plan.id IS NULL THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 source route_plan % not found', v_source_route_plan_id
      USING ERRCODE = '23503';
  END IF;

  IF v_source_plan.status NOT IN ('created', 'submitted', 'solved') THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 requires source route_plan in created/submitted/solved state (got %)', v_source_plan.status
      USING ERRCODE = '23514';
  END IF;

  SELECT rpe.payload
    INTO v_existing_event_payload
    FROM public.route_plan_events rpe
   WHERE rpe.route_plan_id = v_source_plan.id
     AND rpe.event_type = 'rebalanced_out'
     AND rpe.idempotency_key = v_idempotency_key
   ORDER BY rpe.created_at DESC
   LIMIT 1;

  IF v_existing_event_payload IS NOT NULL THEN
    BEGIN
      v_target_route_plan_id := NULLIF(v_existing_event_payload->>'target_route_plan_id', '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_target_route_plan_id := NULL;
    END;

    IF v_target_route_plan_id IS NULL THEN
      RAISE EXCEPTION 'rebalance_route_plan_v1 idempotent replay missing target route_plan for source %', v_source_plan.id
        USING ERRCODE = '23514';
    END IF;

    SELECT *
      INTO v_target_plan
      FROM public.route_plans rp
     WHERE rp.id = v_target_route_plan_id
     LIMIT 1;

    IF v_target_plan.id IS NULL THEN
      RAISE EXCEPTION 'rebalance_route_plan_v1 idempotent replay target route_plan % not found', v_target_route_plan_id
        USING ERRCODE = '23503';
    END IF;

    v_existing_target_created := COALESCE((v_existing_event_payload->>'target_created')::BOOLEAN, FALSE);

    source_route_plan_id := v_source_plan.id;
    target_route_plan_id := v_target_plan.id;
    target_created := v_existing_target_created;
    moved_stop_count := COALESCE((v_existing_event_payload->>'moved_stop_count')::INT, 0);
    source_stop_count := jsonb_array_length(public.route_plan_resolve_stops_v1(v_source_plan.id));
    target_stop_count := jsonb_array_length(public.route_plan_resolve_stops_v1(v_target_plan.id));
    source_status := v_source_plan.status;
    target_status := v_target_plan.status;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_target_route_plan_id IS NOT NULL THEN
    SELECT *
      INTO v_target_plan
      FROM public.route_plans rp
     WHERE rp.id = v_target_route_plan_id
     LIMIT 1;

    IF v_target_plan.id IS NULL THEN
      RAISE EXCEPTION 'rebalance_route_plan_v1 target route_plan % not found', v_target_route_plan_id
        USING ERRCODE = '23503';
    END IF;

    IF v_target_plan.organization_id IS DISTINCT FROM v_source_plan.organization_id THEN
      RAISE EXCEPTION 'rebalance_route_plan_v1 target route_plan % is outside the source organization', v_target_route_plan_id
        USING ERRCODE = '23514';
    END IF;

    IF v_target_plan.status NOT IN ('created', 'submitted', 'solved') THEN
      RAISE EXCEPTION 'rebalance_route_plan_v1 requires target route_plan in created/submitted/solved state (got %)', v_target_plan.status
        USING ERRCODE = '23514';
    END IF;

    IF v_target_branch_id IS NOT NULL AND v_target_plan.branch_id IS DISTINCT FROM v_target_branch_id THEN
      RAISE EXCEPTION 'rebalance_route_plan_v1 target_branch_id % does not match target route_plan branch %', v_target_branch_id, v_target_plan.branch_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_source_stops := public.route_plan_resolve_stops_v1(v_source_plan.id);
  IF jsonb_typeof(v_source_stops) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 source route_plan % must resolve to stops array', v_source_plan.id
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(DISTINCT stop.value->>'shipment_id')
    INTO v_present_count
    FROM jsonb_array_elements(v_source_stops) AS stop(value)
   WHERE NULLIF(btrim(COALESCE(stop.value->>'shipment_id', '')), '') = ANY(v_selected_shipment_ids);

  IF v_present_count <> v_selected_count THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 shipment_ids must all exist on source route_plan %', v_source_plan.id
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(jsonb_agg(stop.value ORDER BY stop.ordinality), '[]'::jsonb)
    INTO v_moved_stops
    FROM jsonb_array_elements(v_source_stops) WITH ORDINALITY AS stop(value, ordinality)
   WHERE NULLIF(btrim(COALESCE(stop.value->>'shipment_id', '')), '') = ANY(v_selected_shipment_ids);

  SELECT COALESCE(jsonb_agg(stop.value ORDER BY stop.ordinality), '[]'::jsonb)
    INTO v_remaining_stops
    FROM jsonb_array_elements(v_source_stops) WITH ORDINALITY AS stop(value, ordinality)
   WHERE NULLIF(btrim(COALESCE(stop.value->>'shipment_id', '')), '') <> ALL(v_selected_shipment_ids);

  moved_stop_count := jsonb_array_length(v_moved_stops);
  v_source_total_count := jsonb_array_length(v_source_stops);
  source_stop_count := jsonb_array_length(v_remaining_stops);

  IF moved_stop_count < 1 THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 selected shipment_ids resolved to zero source stops'
      USING ERRCODE = '23514';
  END IF;

  IF source_stop_count < 1 THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 cannot move every stop off source route_plan %', v_source_plan.id
      USING ERRCODE = '23514';
  END IF;

  IF v_target_plan.id IS NULL THEN
    v_target_branch_id := COALESCE(v_target_branch_id, v_source_plan.branch_id);

    SELECT *
      INTO v_target_create
      FROM public.create_route_plan_v1(
        jsonb_strip_nulls(
          jsonb_build_object(
            'organization_id', v_source_plan.organization_id,
            'branch_id', v_target_branch_id,
            'planned_date', v_source_plan.planned_date,
            'requested_by_user_id', COALESCE(v_actor_user_id, v_source_plan.requested_by_user_id),
            'status', 'submitted',
            'inputs', jsonb_build_object('stops', '[]'::jsonb),
            'constraints', COALESCE(v_source_plan.constraints, '{}'::jsonb),
            'metadata', jsonb_strip_nulls(
              jsonb_build_object(
                'rebalance_source_route_plan_id', v_source_plan.id,
                'rebalance_idempotency_key', v_idempotency_key
              )
            ),
            'idempotency_key', v_idempotency_key || ':target'
          )
        )
      )
     LIMIT 1;

    v_target_route_plan_id := v_target_create.route_plan_id;
    target_created := COALESCE(v_target_create.created, FALSE);

    SELECT *
      INTO v_target_plan
      FROM public.route_plans rp
     WHERE rp.id = v_target_route_plan_id
     LIMIT 1;
  ELSE
    target_created := FALSE;
  END IF;

  IF v_target_plan.id IS NULL THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 target route_plan could not be resolved'
      USING ERRCODE = '23514';
  END IF;

  v_target_stops := public.route_plan_resolve_stops_v1(v_target_plan.id);
  IF jsonb_typeof(v_target_stops) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rebalance_route_plan_v1 target route_plan % must resolve to stops array', v_target_plan.id
      USING ERRCODE = '23514';
  END IF;

  v_target_next_stops := COALESCE(v_target_stops, '[]'::jsonb) || COALESCE(v_moved_stops, '[]'::jsonb);
  target_stop_count := jsonb_array_length(v_target_next_stops);
  v_target_total_count := jsonb_array_length(v_target_stops);

  IF jsonb_typeof(COALESCE(v_source_plan.solution, '{}'::jsonb)) = 'object' THEN
    v_source_solution := COALESCE(v_source_plan.solution, '{}'::jsonb) - 'stops' - 'optimizer';
  ELSE
    v_source_solution := '{}'::jsonb;
  END IF;

  IF jsonb_typeof(COALESCE(v_target_plan.solution, '{}'::jsonb)) = 'object' THEN
    v_target_solution := COALESCE(v_target_plan.solution, '{}'::jsonb) - 'stops' - 'optimizer';
  ELSE
    v_target_solution := '{}'::jsonb;
  END IF;

  UPDATE public.route_plans
     SET status = 'submitted',
         status_reason = 'rebalance_pending_solve',
         solved_at = NULL,
         inputs = jsonb_set(COALESCE(v_source_plan.inputs, '{}'::jsonb), ARRAY['stops'], v_remaining_stops, TRUE),
         solution = COALESCE(v_source_solution, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_source_plan.id;

  UPDATE public.route_plans
     SET status = 'submitted',
         status_reason = 'rebalance_pending_solve',
         solved_at = NULL,
         inputs = jsonb_set(COALESCE(v_target_plan.inputs, '{}'::jsonb), ARRAY['stops'], v_target_next_stops, TRUE),
         solution = COALESCE(v_target_solution, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_target_plan.id;

  PERFORM public.route_plan_log_event_v1(
    v_source_plan.id,
    'rebalanced_out',
    v_source_plan.status,
    'submitted',
    jsonb_strip_nulls(
      jsonb_build_object(
        'target_route_plan_id', v_target_plan.id,
        'target_branch_id', COALESCE(v_target_plan.branch_id, v_target_branch_id),
        'shipment_ids', to_jsonb(v_selected_shipment_ids),
        'moved_stop_count', moved_stop_count,
        'source_stop_count_before', v_source_total_count,
        'source_stop_count_after', source_stop_count,
        'target_stop_count_before', v_target_total_count,
        'target_stop_count_after', target_stop_count,
        'target_created', target_created
      )
    ),
    v_actor_user_id,
    v_actor_system,
    v_idempotency_key
  );

  PERFORM public.route_plan_log_event_v1(
    v_target_plan.id,
    'rebalanced_in',
    v_target_plan.status,
    'submitted',
    jsonb_strip_nulls(
      jsonb_build_object(
        'source_route_plan_id', v_source_plan.id,
        'shipment_ids', to_jsonb(v_selected_shipment_ids),
        'moved_stop_count', moved_stop_count,
        'source_stop_count_after', source_stop_count,
        'target_stop_count_after', target_stop_count,
        'target_created', target_created
      )
    ),
    v_actor_user_id,
    v_actor_system,
    v_idempotency_key || ':target'
  );

  source_route_plan_id := v_source_plan.id;
  target_route_plan_id := v_target_plan.id;
  source_status := 'submitted';
  target_status := 'submitted';
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.rebalance_route_plan_v1(JSONB) IS
  'Planning-only route-plan rebalance contract. Moves selected shipment stops between route_plans, resets both plans back to planning state, and never mutates route_runs or assignment truth.';

REVOKE ALL ON FUNCTION public.rebalance_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebalance_route_plan_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.rebalance_route_plan_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rebalance_route_plan_v1(JSONB) TO service_role;

-------------------------------------------------------------
-- 2) Browser-safe UI/API wrappers
-------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_rebalance_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  source_route_plan_id UUID,
  target_route_plan_id UUID,
  target_created BOOLEAN,
  moved_stop_count INT,
  source_stop_count INT,
  target_stop_count INT,
  source_status TEXT,
  target_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
  v_source_route_plan_id UUID := NULL;
  v_target_route_plan_id UUID := NULL;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('write')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_rebalance_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_source_route_plan_id := NULLIF(v_input->>'source_route_plan_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_source_route_plan_id := NULL;
  END;

  BEGIN
    v_target_route_plan_id := NULLIF(v_input->>'target_route_plan_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_target_route_plan_id := NULL;
  END;

  PERFORM public.ui_route_plan_visible_v1(v_source_route_plan_id, 'write');

  IF v_target_route_plan_id IS NOT NULL THEN
    PERFORM public.ui_route_plan_visible_v1(v_target_route_plan_id, 'write');
  END IF;

  v_payload := (
    v_input
    - 'organization_id'
    - 'requested_by_user_id'
    - 'actor_user_id'
    - 'actor_system'
  );

  v_payload := jsonb_strip_nulls(
    v_payload || jsonb_build_object(
      'source_route_plan_id', v_source_route_plan_id,
      'actor_user_id', v_ctx.user_id,
      'actor_system', 'route_plan_ui'
    )
  );

  RETURN QUERY
  SELECT *
  FROM public.rebalance_route_plan_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_rebalance_route_plan_v1(JSONB) IS
  'Authenticated UI write-path for route-plan rebalance with server-derived actor context.';

REVOKE ALL ON FUNCTION public.ui_rebalance_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_rebalance_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_rebalance_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_rebalance_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  source_route_plan_id UUID,
  target_route_plan_id UUID,
  target_created BOOLEAN,
  moved_stop_count INT,
  source_stop_count INT,
  target_stop_count INT,
  source_status TEXT,
  target_status TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_rebalance_route_plan_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_rebalance_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_rebalance_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_rebalance_route_plan_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------
-- 3) Dedicated UI command executor
-------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_route_plan_rebalance_v1(
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
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_execution JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_visible_plan JSONB := NULL;
  v_result RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_rebalance_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_plan_rebalance_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_plan_rebalance_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_rebalance_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

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
    RAISE EXCEPTION 'ui_execute_route_plan_rebalance_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_route_plan_rebalance_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);

  v_selection_id_text := COALESCE(
    NULLIF(v_id, ''),
    CASE WHEN array_length(v_ids, 1) IS NOT NULL THEN v_ids[1] ELSE NULL END
  );

  BEGIN
    v_selection_uuid := NULLIF(btrim(COALESCE(v_selection_id_text, '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_selection_uuid := NULL;
  END;

  IF v_selection_uuid IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_rebalance_v1 invalid route_plan id %', v_selection_id_text;
  END IF;

  v_visible_plan := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
  IF v_visible_plan IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_rebalance_v1 route_plan % is not visible in resource %', v_selection_uuid, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_result
    FROM public.ui_rebalance_route_plan_v1(
      jsonb_strip_nulls(
        COALESCE(v_params, '{}'::jsonb)
        || jsonb_build_object('source_route_plan_id', v_selection_uuid)
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'rebalanced',
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', 1,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'source_route_plan_id', v_result.source_route_plan_id,
          'target_route_plan_id', v_result.target_route_plan_id,
          'target_created', v_result.target_created,
          'moved_stop_count', v_result.moved_stop_count,
          'source_stop_count', v_result.source_stop_count,
          'target_stop_count', v_result.target_stop_count,
          'source_status', v_result.source_status,
          'target_status', v_result.target_status
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_route_plan_rebalance_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Rebalance visible route_plans from Console/Portal without widening ui_execute_command_v1 or mutating execution-truth state.';

REVOKE ALL ON FUNCTION public.ui_execute_route_plan_rebalance_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_route_plan_rebalance_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_route_plan_rebalance_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_route_plan_rebalance_v1(
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
  SELECT public.ui_execute_route_plan_rebalance_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_route_plan_rebalance_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_route_plan_rebalance_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_route_plan_rebalance_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------
-- 4) ui_command_registry route-plan rebalance command
-------------------------------------------------------------

DO $do$
DECLARE
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['route_plans.rebalance'],
    jsonb_build_object(
      'key', 'route_plans.rebalance',
      'label', 'Rebalance route plan',
      'description', 'Move selected shipment stops onto another planning route plan or create a sibling plan without mutating route-run execution truth.',
      'capability', 'route_plans.write',
      'schema_category', 'resource:route_plans',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_route_plan_rebalance_v1',
        'params', '{}'::jsonb,
        'confirm', jsonb_build_object(
          'title', 'Rebalance route plan?',
          'description', 'This moves the selected shipments onto another planning route plan and resets both plans back to a planning state for re-solve.',
          'confirm_label', 'Rebalance route plan',
          'cancel_label', 'Cancel',
          'tone', 'default'
        )
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
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
      IF v_command_key = 'route_plans.rebalance' THEN
        v_command := public.deep_merge_jsonb(v_canonical_commands->v_command_key, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item(value)
      WHERE item.value->>'key' = 'route_plans.rebalance'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'route_plans.rebalance');
    END IF;

    v_next := jsonb_set(v_current, ARRAY['commands'], v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             change_reason = 'Expose route_plans.rebalance through ui_command_registry.',
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

COMMIT;
