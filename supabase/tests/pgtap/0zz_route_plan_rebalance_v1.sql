-- Plan: PLAN-202604-b06-route-plan-rebalance / Step: S01
-- pgTAP: Route plan rebalance v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(25);

CREATE OR REPLACE FUNCTION pg_temp.test_route_plan_rebalance_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_commands JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_source_branch UUID := gen_random_uuid();
  v_target_branch UUID := gen_random_uuid();
  v_source_plan RECORD;
  v_retry RECORD;
  v_target_plan RECORD;
  v_existing_target_plan RECORD;
  v_command_source_plan RECORD;
  v_rebalance RECORD;
  v_exec_result JSONB := NULL;
  v_expected_source_order TEXT := NULL;
  v_source_order TEXT := NULL;
  v_target_order TEXT := NULL;
  v_source_solution_stops JSONB := NULL;
  v_target_solution_stops JSONB := NULL;
  v_ship_1 UUID := gen_random_uuid();
  v_ship_2 UUID := gen_random_uuid();
  v_ship_3 UUID := gen_random_uuid();
  v_ship_4 UUID := gen_random_uuid();
  v_ship_5 UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_commands
    FROM public.settings
   WHERE category = 'ui_command_registry'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_function(
    'public',
    'ui_rebalance_route_plan_v1',
    ARRAY['jsonb'],
    'public.ui_rebalance_route_plan_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_rebalance_route_plan_v1',
    ARRAY['jsonb'],
    'api.ui_rebalance_route_plan_v1 exists'
  );
  RETURN NEXT has_function(
    'public',
    'ui_execute_route_plan_rebalance_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'public.ui_execute_route_plan_rebalance_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_route_plan_rebalance_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'api.ui_execute_route_plan_rebalance_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_rebalance_route_plan_v1(jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_rebalance_route_plan_v1'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_route_plan_rebalance_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_execute_route_plan_rebalance_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_plans.rebalance'
        AND item.value#>>'{execution,type}' = 'rpc'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_route_plan_rebalance_v1'
    ),
    'ui_command_registry exposes route_plans.rebalance'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Plan Rebalance Org', 'route-plan-rebalance-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_source_branch, v_org, 'rebal-src', 'Route Rebalance Source Branch', 'UTC', TRUE),
    (v_target_branch, v_org, 'rebal-dst', 'Route Rebalance Target Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_operator,
    v_org,
    'route-rebalance-' || left(v_operator::text, 8) || '@example.com',
    'Route Rebalance Ops',
    'ops_admin',
    'tenant'
  );

  SELECT *
    INTO v_source_plan
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_source_branch,
        'planned_date', DATE '2026-04-06',
        'requested_by_user_id', v_operator,
        'idempotency_key', 'route-plan-rebalance-source',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object('shipment_id', v_ship_1, 'priority_score', 1),
            jsonb_build_object('shipment_id', v_ship_2, 'priority_score', 2),
            jsonb_build_object('shipment_id', v_ship_3, 'priority_score', 3)
          )
        )
      )
    )
   LIMIT 1;

  PERFORM public.solve_route_plan_v1(
    jsonb_build_object(
      'route_plan_id', v_source_plan.route_plan_id,
      'actor_user_id', v_operator,
      'actor_system', 'pgtap'
    )
  );

  SELECT string_agg(item.value->>'shipment_id', '|' ORDER BY item.ordinality)
    INTO v_expected_source_order
    FROM public.route_plans rp
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(rp.solution->'stops', '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
   WHERE rp.id = v_source_plan.route_plan_id
     AND item.value->>'shipment_id' <> v_ship_2::text;

  SELECT *
    INTO v_existing_target_plan
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_source_branch,
        'planned_date', DATE '2026-04-06',
        'requested_by_user_id', v_operator,
        'idempotency_key', 'route-plan-rebalance-existing-target',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object('shipment_id', v_ship_5, 'priority_score', 5)
          )
        )
      )
    )
   LIMIT 1;

  PERFORM public.solve_route_plan_v1(
    jsonb_build_object(
      'route_plan_id', v_existing_target_plan.route_plan_id,
      'actor_user_id', v_operator,
      'actor_system', 'pgtap'
    )
  );

  SELECT *
    INTO v_command_source_plan
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_source_branch,
        'planned_date', DATE '2026-04-06',
        'requested_by_user_id', v_operator,
        'idempotency_key', 'route-plan-rebalance-command-source',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object('shipment_id', v_ship_4, 'priority_score', 4),
            jsonb_build_object('shipment_id', v_ship_2, 'priority_score', 2)
          )
        )
      )
    )
   LIMIT 1;

  PERFORM public.solve_route_plan_v1(
    jsonb_build_object(
      'route_plan_id', v_command_source_plan.route_plan_id,
      'actor_user_id', v_operator,
      'actor_system', 'pgtap'
    )
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_rebalance
    FROM api.ui_rebalance_route_plan_v1(
      jsonb_build_object(
        'source_route_plan_id', v_source_plan.route_plan_id,
        'target_branch_id', v_target_branch,
        'shipment_ids', jsonb_build_array(v_ship_2::text),
        'idempotency_key', 'route-plan-rebalance-api'
      )
    )
   LIMIT 1;

  RETURN NEXT is(
    v_rebalance.source_route_plan_id::text,
    v_source_plan.route_plan_id::text,
    'api.ui_rebalance_route_plan_v1 returns the source route_plan id'
  );
  RETURN NEXT is(v_rebalance.target_created::text, 'true', 'api.ui_rebalance_route_plan_v1 creates a target route_plan when only target_branch_id is provided');
  RETURN NEXT is(v_rebalance.moved_stop_count, 1, 'api.ui_rebalance_route_plan_v1 reports moved stop count');
  RETURN NEXT is(v_rebalance.source_status, 'submitted', 'source route_plan resets to submitted after rebalance');
  RETURN NEXT is(v_rebalance.target_status, 'submitted', 'target route_plan resets to submitted after rebalance');

  SELECT *
    INTO v_target_plan
    FROM public.route_plans rp
   WHERE rp.id = v_rebalance.target_route_plan_id
   LIMIT 1;

  RETURN NEXT is(
    v_target_plan.branch_id::text,
    v_target_branch::text,
    'rebalance creates the target route_plan on the requested branch'
  );

  SELECT string_agg(item.value->>'shipment_id', '|' ORDER BY item.ordinality)
    INTO v_source_order
    FROM public.route_plans rp
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(rp.inputs->'stops', '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
   WHERE rp.id = v_source_plan.route_plan_id;

  RETURN NEXT is(
    v_source_order,
    v_expected_source_order,
    'source route_plan keeps the remaining stops in source order'
  );

  SELECT string_agg(item.value->>'shipment_id', '|' ORDER BY item.ordinality)
    INTO v_target_order
    FROM public.route_plans rp
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(rp.inputs->'stops', '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
   WHERE rp.id = v_target_plan.id;

  RETURN NEXT is(
    v_target_order,
    v_ship_2::text,
    'target route_plan resolves to the moved stop set'
  );

  SELECT rp.solution->'stops', tp.solution->'stops'
    INTO v_source_solution_stops, v_target_solution_stops
    FROM public.route_plans rp
    CROSS JOIN public.route_plans tp
   WHERE rp.id = v_source_plan.route_plan_id
     AND tp.id = v_target_plan.id;

  RETURN NEXT ok(v_source_solution_stops IS NULL, 'source route_plan clears stale solution stops after rebalance');
  RETURN NEXT ok(v_target_solution_stops IS NULL, 'target route_plan clears stale solution stops after rebalance');
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
      FROM public.route_plan_events
      WHERE route_plan_id = v_source_plan.route_plan_id
        AND event_type = 'rebalanced_out'
    ),
    '1',
    'source route_plan logs one rebalanced_out event'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
      FROM public.route_plan_events
      WHERE route_plan_id = v_target_plan.id
        AND event_type = 'rebalanced_in'
    ),
    '1',
    'target route_plan logs one rebalanced_in event'
  );

  SELECT *
    INTO v_retry
    FROM api.ui_rebalance_route_plan_v1(
      jsonb_build_object(
        'source_route_plan_id', v_source_plan.route_plan_id,
        'target_branch_id', v_target_branch,
        'shipment_ids', jsonb_build_array(v_ship_2::text),
        'idempotency_key', 'route-plan-rebalance-api'
      )
    )
   LIMIT 1;

  RETURN NEXT is(
    v_retry.target_route_plan_id::text,
    v_target_plan.id::text,
    'idempotent replay returns the same target route_plan'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
      FROM public.route_plan_events
      WHERE route_plan_id = v_source_plan.route_plan_id
        AND event_type = 'rebalanced_out'
    ),
    '1',
    'idempotent replay does not duplicate the source rebalanced_out event'
  );

  v_exec_result := api.ui_execute_route_plan_rebalance_v1(
    'route_plans.rebalance',
    'route_plans',
    ARRAY[v_command_source_plan.route_plan_id::text],
    v_command_source_plan.route_plan_id::text,
    1,
    jsonb_build_object(
      'target_route_plan_id', v_existing_target_plan.route_plan_id,
      'shipment_ids', jsonb_build_array(v_ship_4::text)
    )
  );

  RETURN NEXT is(v_exec_result->>'status', 'rebalanced', 'api.ui_execute_route_plan_rebalance_v1 reports rebalanced status');
  RETURN NEXT is(v_exec_result#>>'{items,0,target_created}', 'false', 'command executor reuses the provided target route_plan');
  RETURN NEXT is(v_exec_result#>>'{items,0,moved_stop_count}', '1', 'command executor returns the moved stop count');

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
        FROM api.ui_rebalance_route_plan_v1(
          jsonb_build_object(
            'source_route_plan_id', %L::uuid,
            'target_route_plan_id', %L::uuid,
            'shipment_ids', jsonb_build_array(%L)
          )
        )
      $sql$,
      v_command_source_plan.route_plan_id::text,
      v_existing_target_plan.route_plan_id::text,
      v_ship_2::text
    ),
    '23514',
    format(
      'rebalance_route_plan_v1 cannot move every stop off source route_plan %s',
      v_command_source_plan.route_plan_id
    ),
    'rebalance rejects full-move requests that would empty the source route_plan'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_route_plan_rebalance_v1();

SELECT * FROM finish();

ROLLBACK;
