-- Plan: PLAN-202604-b06-route-plan-sequence-optimizer / Step: S01
-- pgTAP: Route plan sequence optimizer v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

CREATE OR REPLACE FUNCTION pg_temp.test_route_plan_sequence_optimizer_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_commands JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_plan RECORD;
  v_solve RECORD;
  v_exec_result JSONB := NULL;
  v_order TEXT := NULL;
  v_solution_resolution_id TEXT := NULL;
  v_detail JSONB := NULL;
  v_tenant_plan RECORD;
  v_tenant_solve RECORD;
  v_tenant_order TEXT := NULL;
  v_tenant_detail JSONB := NULL;
  v_tenant_scope_type TEXT := NULL;
  v_ship_1 UUID := gen_random_uuid();
  v_ship_2 UUID := gen_random_uuid();
  v_ship_3 UUID := gen_random_uuid();
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
    'ui_solve_route_plan_v1',
    ARRAY['jsonb'],
    'public.ui_solve_route_plan_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_solve_route_plan_v1',
    ARRAY['jsonb'],
    'api.ui_solve_route_plan_v1 exists'
  );
  RETURN NEXT has_function(
    'public',
    'ui_execute_route_plan_solve_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'public.ui_execute_route_plan_solve_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_route_plan_solve_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'api.ui_execute_route_plan_solve_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_solve_route_plan_v1(jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_solve_route_plan_v1'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_route_plan_solve_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_execute_route_plan_solve_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_plans.solve_sequence'
        AND item.value#>>'{execution,type}' = 'rpc'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_route_plan_solve_v1'
    ),
    'ui_command_registry exposes route_plans.solve_sequence'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Plan Sequence Org', 'route-plan-sequence-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_operator,
    v_org,
    'route-ops-' || left(v_operator::text, 8) || '@example.com',
    'Route Ops',
    'ops_admin',
    'tenant'
  );

  SELECT *
    INTO v_plan
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'planned_date', DATE '2026-04-04',
        'requested_by_user_id', v_operator,
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object(
              'shipment_id', v_ship_1,
              'priority_score', 1,
              'planned_window_start_at', '2026-04-04T09:00:00Z',
              'metadata', jsonb_build_object(
                'route', jsonb_build_object(
                  'travel_minutes', 20,
                  'traffic_delay_minutes', 5,
                  'service_minutes', 12
                )
              )
            ),
            jsonb_build_object(
              'shipment_id', v_ship_2,
              'priority_score', 0,
              'planned_window_start_at', '2026-04-04T08:00:00Z',
              'metadata', jsonb_build_object(
                'route', jsonb_build_object(
                  'travel_minutes', 5,
                  'traffic_delay_minutes', 1,
                  'service_minutes', 8
                )
              )
            ),
            jsonb_build_object(
              'shipment_id', v_ship_3,
              'priority_score', 5,
              'planned_window_start_at', '2026-04-04T09:00:00Z',
              'metadata', jsonb_build_object(
                'route', jsonb_build_object(
                  'travel_minutes', 4,
                  'traffic_delay_minutes', 0,
                  'service_minutes', 5
                )
              )
            )
          )
        )
      )
    )
   LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_solve
    FROM api.ui_solve_route_plan_v1(
      jsonb_build_object('route_plan_id', v_plan.route_plan_id)
    )
   LIMIT 1;

  RETURN NEXT is(v_solve.status, 'solved', 'api.ui_solve_route_plan_v1 reports solved status');
  RETURN NEXT is(v_solve.stop_count, 3, 'api.ui_solve_route_plan_v1 reports all optimized stops');
  RETURN NEXT ok(v_solve.settings_resolution_id IS NOT NULL, 'api.ui_solve_route_plan_v1 returns settings_resolution_id');

  SELECT string_agg(item.value->>'shipment_id', '|' ORDER BY item.ordinality)
    INTO v_order
    FROM jsonb_array_elements(
      COALESCE(
        (SELECT rp.solution->'stops' FROM public.route_plans rp WHERE rp.id = v_plan.route_plan_id),
        '[]'::jsonb
      )
    ) WITH ORDINALITY AS item(value, ordinality);

  RETURN NEXT is(
    v_order,
    v_ship_2::text || '|' || v_ship_3::text || '|' || v_ship_1::text,
    'solve_route_plan_v1 orders earlier deadline first, then lower weighted penalty'
  );

  SELECT rp.solution#>>'{optimizer,settings_resolution_id}'
    INTO v_solution_resolution_id
    FROM public.route_plans rp
   WHERE rp.id = v_plan.route_plan_id;

  RETURN NEXT is(
    v_solution_resolution_id,
    v_solve.settings_resolution_id::text,
    'route_plan solution optimizer metadata keeps the settings_resolution_id'
  );

  v_exec_result := api.ui_execute_route_plan_solve_v1(
    'route_plans.solve_sequence',
    'route_plans',
    ARRAY[v_plan.route_plan_id::text],
    v_plan.route_plan_id::text,
    1,
    '{}'::jsonb
  );

  RETURN NEXT is(v_exec_result->>'status', 'solved', 'api.ui_execute_route_plan_solve_v1 reports solved status');

  v_detail := public.ui_get_resource_v1('route_plans', v_plan.route_plan_id);

  RETURN NEXT is(v_detail->>'status', 'solved', 'ui_get_resource_v1 exposes solved route_plan status');
  RETURN NEXT ok((v_detail#>>'{solution,optimizer,reference_at}') IS NOT NULL, 'ui_get_resource_v1 exposes optimizer reference_at');
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
      FROM public.route_plan_events
      WHERE route_plan_id = v_plan.route_plan_id
        AND event_type = 'solved'
    ),
    '2',
    'route_plan_events logs the direct solve and the route workspace solve command as separate solve events'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    approved_at,
    change_reason
  )
  VALUES (
    'route_planning_policy',
    'tenant',
    v_org,
    1,
    jsonb_build_object(
      'version', 1,
      'enabled', true,
      'deadline_hard_sort', false,
      'weights', jsonb_build_object(
        'window', 0,
        'priority', 10,
        'travel', 0,
        'traffic_delay', 0,
        'service', 0
      )
    ),
    now(),
    'pgtap fixture: tenant route planning override'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    sv.category,
    sv.scope_type,
    sv.scope_id,
    sv.id,
    sv.value,
    now()
  FROM public.settings_versions sv
  WHERE sv.category = 'route_planning_policy'
    AND sv.scope_type = 'tenant'
    AND sv.scope_id = v_org
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

  SELECT scope_type
    INTO v_tenant_scope_type
    FROM public.resolve_settings_row_from_context(
      'route_planning_policy',
      jsonb_build_object('organization_id', v_org)
    )
   LIMIT 1;

  RETURN NEXT is(v_tenant_scope_type, 'tenant', 'route_planning_policy resolves tenant override before global default');

  SELECT *
    INTO v_tenant_plan
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'planned_date', DATE '2026-04-04',
        'requested_by_user_id', v_operator,
        'idempotency_key', 'route-plan-sequence-tenant-override',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object(
              'shipment_id', v_ship_1,
              'priority_score', 1,
              'planned_window_start_at', '2026-04-04T09:00:00Z',
              'metadata', jsonb_build_object(
                'route', jsonb_build_object(
                  'travel_minutes', 20,
                  'traffic_delay_minutes', 5,
                  'service_minutes', 12
                )
              )
            ),
            jsonb_build_object(
              'shipment_id', v_ship_2,
              'priority_score', 0,
              'planned_window_start_at', '2026-04-04T08:00:00Z',
              'metadata', jsonb_build_object(
                'route', jsonb_build_object(
                  'travel_minutes', 5,
                  'traffic_delay_minutes', 1,
                  'service_minutes', 8
                )
              )
            ),
            jsonb_build_object(
              'shipment_id', v_ship_3,
              'priority_score', 5,
              'planned_window_start_at', '2026-04-04T09:00:00Z',
              'metadata', jsonb_build_object(
                'route', jsonb_build_object(
                  'travel_minutes', 4,
                  'traffic_delay_minutes', 0,
                  'service_minutes', 5
                )
              )
            )
          )
        )
      )
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_tenant_solve
    FROM api.ui_solve_route_plan_v1(
      jsonb_build_object('route_plan_id', v_tenant_plan.route_plan_id)
    )
   LIMIT 1;

  RETURN NEXT is(v_tenant_solve.status, 'solved', 'tenant override solve reports solved status');
  RETURN NEXT ok(v_tenant_solve.settings_resolution_id IS NOT NULL, 'tenant override solve returns settings_resolution_id');

  SELECT string_agg(item.value->>'shipment_id', '|' ORDER BY item.ordinality)
    INTO v_tenant_order
    FROM jsonb_array_elements(
      COALESCE(
        (SELECT rp.solution->'stops' FROM public.route_plans rp WHERE rp.id = v_tenant_plan.route_plan_id),
        '[]'::jsonb
      )
    ) WITH ORDINALITY AS item(value, ordinality);

  RETURN NEXT is(
    v_tenant_order,
    v_ship_3::text || '|' || v_ship_1::text || '|' || v_ship_2::text,
    'tenant override solve respects row-driven policy and flips stop order'
  );

  v_tenant_detail := public.ui_get_resource_v1('route_plans', v_tenant_plan.route_plan_id);

  RETURN NEXT is(
    v_tenant_detail#>>'{solution,optimizer,deadline_hard_sort}',
    'false',
    'ui_get_resource_v1 exposes tenant override optimizer policy'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_route_plan_sequence_optimizer_v1();

SELECT * FROM finish();

ROLLBACK;
