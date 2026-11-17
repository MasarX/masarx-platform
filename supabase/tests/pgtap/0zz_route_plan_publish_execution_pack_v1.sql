-- Plan: PLAN-202604-b06-route-plan-publish / Step: S01
-- pgTAP: Route plan publish execution pack v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(27);

CREATE OR REPLACE FUNCTION pg_temp.test_route_plan_publish_execution_pack_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_commands JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_ship_1 UUID := gen_random_uuid();
  v_ship_2 UUID := gen_random_uuid();
  v_plan RECORD;
  v_frozen RECORD;
  v_published RECORD;
  v_exec_result JSONB := NULL;
  v_pack JSONB := NULL;
  v_detail JSONB := NULL;
  v_applied RECORD;
  v_route_run_hash TEXT := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_commands
    FROM public.settings
   WHERE category = 'ui_command_registry'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_function('public', 'publish_route_plan_v1', ARRAY['jsonb'], 'public.publish_route_plan_v1 exists');
  RETURN NEXT has_function('public', 'route_plan_execution_pack_v1', ARRAY['uuid'], 'public.route_plan_execution_pack_v1 exists');
  RETURN NEXT has_function('public', 'ui_publish_route_plan_v1', ARRAY['jsonb'], 'public.ui_publish_route_plan_v1 exists');
  RETURN NEXT has_function('api', 'ui_publish_route_plan_v1', ARRAY['jsonb'], 'api.ui_publish_route_plan_v1 exists');
  RETURN NEXT has_function('public', 'ui_route_plan_execution_pack_v1', ARRAY['uuid'], 'public.ui_route_plan_execution_pack_v1 exists');
  RETURN NEXT has_function('api', 'ui_route_plan_execution_pack_v1', ARRAY['uuid'], 'api.ui_route_plan_execution_pack_v1 exists');
  RETURN NEXT has_function('public', 'ui_execute_route_plan_publish_v1', ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'], 'public.ui_execute_route_plan_publish_v1 exists');
  RETURN NEXT has_function('api', 'ui_execute_route_plan_publish_v1', ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'], 'api.ui_execute_route_plan_publish_v1 exists');
  RETURN NEXT has_column('public', 'route_plans', 'published_execution_pack_hash', 'route_plans has published_execution_pack_hash');
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_publish_route_plan_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_publish_route_plan_v1'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_route_plan_execution_pack_v1(uuid)', 'EXECUTE'),
    'authenticated can execute api.ui_route_plan_execution_pack_v1'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_route_plan_publish_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_execute_route_plan_publish_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_plans.publish'
        AND item.value#>>'{execution,type}' = 'rpc'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_route_plan_publish_v1'
    ),
    'ui_command_registry exposes route_plans.publish'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Plan Publish Org', 'route-plan-publish-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'rpp-' || left(v_branch::text, 8), 'Route Plan Publish Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_operator,
    v_org,
    'route-plan-publish-' || left(v_operator::text, 8) || '@example.com',
    'Route Plan Publish Ops',
    'ops_admin',
    'tenant'
  );

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Route Publish Client', 'route-publish-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Route Publish Sender', 'Route Publish Sender', TRUE, 'active');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES
    (v_ship_1, v_org, v_client, v_sender, 'delivery', 'pgtap-route-publish-' || left(v_ship_1::text, 8), 'created'),
    (v_ship_2, v_org, v_client, v_sender, 'delivery', 'pgtap-route-publish-' || left(v_ship_2::text, 8), 'created');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_plan
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'requested_by_user_id', v_operator,
        'planned_date', DATE '2026-04-06',
        'idempotency_key', 'pgtap-route-plan-publish-1',
        'solution', jsonb_build_object(
          'vehicle_id', v_vehicle,
          'driver_user_id', v_operator,
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_ship_1, 'stop_kind', 'delivery', 'sequence_order', 1),
            jsonb_build_object('client_id', v_client, 'shipment_id', v_ship_2, 'stop_kind', 'delivery', 'sequence_order', 2)
          )
        )
      )
    )
   LIMIT 1;

  SELECT *
    INTO v_frozen
    FROM public.freeze_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan.route_plan_id,
        'actor_user_id', v_operator,
        'idempotency_key', 'pgtap-route-plan-publish-freeze-1'
      )
    )
   LIMIT 1;

  RETURN NEXT is(v_frozen.status, 'frozen', 'freeze_route_plan_v1 prepares the route plan for publish');
  RETURN NEXT is(
    COALESCE(public.route_plan_execution_pack_v1(v_plan.route_plan_id), 'null'::jsonb),
    'null'::jsonb,
    'route_plan_execution_pack_v1 stays hidden before publish'
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_published
    FROM api.ui_publish_route_plan_v1(
      jsonb_build_object('route_plan_id', v_plan.route_plan_id)
    )
   LIMIT 1;

  RETURN NEXT is(v_published.status, 'published', 'api.ui_publish_route_plan_v1 reports published status');
  RETURN NEXT is(v_published.stop_count, 2, 'api.ui_publish_route_plan_v1 reports stop_count');
  RETURN NEXT is(v_published.shipment_count, 2, 'api.ui_publish_route_plan_v1 reports shipment_count');
  RETURN NEXT ok(v_published.execution_pack_hash IS NOT NULL, 'api.ui_publish_route_plan_v1 returns execution_pack_hash');

  v_detail := public.ui_get_resource_v1('route_plans', v_plan.route_plan_id);
  RETURN NEXT is(v_detail->>'status', 'published', 'ui_get_resource_v1 exposes published status');
  v_pack := api.ui_route_plan_execution_pack_v1(v_plan.route_plan_id);
  RETURN NEXT is(v_pack->>'execution_pack_hash', v_published.execution_pack_hash, 'api.ui_route_plan_execution_pack_v1 returns the published hash');
  RETURN NEXT is(jsonb_array_length(COALESCE(v_pack->'stops', '[]'::jsonb)), 2, 'api.ui_route_plan_execution_pack_v1 exposes published stops');

  v_exec_result := api.ui_execute_route_plan_publish_v1(
    'route_plans.publish',
    'route_plans',
    ARRAY[v_plan.route_plan_id::text],
    v_plan.route_plan_id::text,
    1,
    '{}'::jsonb
  );

  RETURN NEXT is(v_exec_result->>'status', 'published', 'api.ui_execute_route_plan_publish_v1 reports published status');
  RETURN NEXT is(
    v_exec_result#>>'{items,0,execution_pack_hash}',
    v_published.execution_pack_hash,
    'api.ui_execute_route_plan_publish_v1 returns the canonical execution_pack_hash'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
      FROM public.route_plan_events
      WHERE route_plan_id = v_plan.route_plan_id
        AND event_type = 'published'
    ),
    '1',
    'route_plan_events logs one published event despite replay-safe publish command retries'
  );

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_applied
    FROM public.apply_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan.route_plan_id,
        'actor_user_id', v_operator,
        'idempotency_key', 'pgtap-route-plan-publish-apply-1'
      )
    )
   LIMIT 1;

  RETURN NEXT is(v_applied.status, 'applied', 'apply_route_plan_v1 accepts published plans');

  SELECT rr.metadata->>'route_plan_execution_pack_hash'
    INTO v_route_run_hash
    FROM public.route_runs rr
   WHERE rr.id = v_applied.route_run_id
   LIMIT 1;

  RETURN NEXT is(v_route_run_hash, v_published.execution_pack_hash, 'route_runs metadata carries the published execution_pack_hash');
END;
$function$;

SELECT * FROM pg_temp.test_route_plan_publish_execution_pack_v1();

SELECT * FROM finish();
ROLLBACK;
