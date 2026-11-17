-- Plan: PLAN-202603-b06-planning-dispatch-wave0 / Step: S06
-- pgTAP: Route plan UI/API contract v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(37);

CREATE OR REPLACE FUNCTION pg_temp.test_route_plan_ui_api_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_access JSONB := NULL;
  v_registry JSONB := NULL;
  v_navigation JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_client_user UUID := gen_random_uuid();
  v_shipment1 UUID := gen_random_uuid();
  v_shipment2 UUID := gen_random_uuid();
  v_zone UUID := gen_random_uuid();
  v_standard_level UUID := gen_random_uuid();
  v_plan RECORD;
  v_frozen RECORD;
  v_wave_plan RECORD;
  v_spoofed_org UUID := gen_random_uuid();
  v_spoofed_user UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_access
    FROM public.settings
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_navigation
    FROM public.settings
   WHERE category = 'ui_navigation'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_view('api', 'route_plans', 'api.route_plans view exists');
  RETURN NEXT has_function('public', 'ui_create_route_plan_v1', ARRAY['jsonb'], 'public.ui_create_route_plan_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'ui_route_plan_resolve_stops_v1', ARRAY['uuid'], 'public.ui_route_plan_resolve_stops_v1(uuid) exists');
  RETURN NEXT has_function('public', 'ui_freeze_route_plan_v1', ARRAY['jsonb'], 'public.ui_freeze_route_plan_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'ui_apply_route_plan_v1', ARRAY['jsonb'], 'public.ui_apply_route_plan_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'ui_start_route_plan_apply_workflow_v1', ARRAY['jsonb'], 'public.ui_start_route_plan_apply_workflow_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'ui_build_delivery_wave_route_plan_v1', ARRAY['jsonb'], 'public.ui_build_delivery_wave_route_plan_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'ui_create_route_plan_v1', ARRAY['jsonb'], 'api.ui_create_route_plan_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'ui_route_plan_resolve_stops_v1', ARRAY['uuid'], 'api.ui_route_plan_resolve_stops_v1(uuid) exists');
  RETURN NEXT has_function('api', 'ui_freeze_route_plan_v1', ARRAY['jsonb'], 'api.ui_freeze_route_plan_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'ui_apply_route_plan_v1', ARRAY['jsonb'], 'api.ui_apply_route_plan_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'ui_start_route_plan_apply_workflow_v1', ARRAY['jsonb'], 'api.ui_start_route_plan_apply_workflow_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'ui_build_delivery_wave_route_plan_v1', ARRAY['jsonb'], 'api.ui_build_delivery_wave_route_plan_v1(jsonb) exists');
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_create_route_plan_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_create_route_plan_v1'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_freeze_route_plan_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_freeze_route_plan_v1'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_build_delivery_wave_route_plan_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_build_delivery_wave_route_plan_v1'
  );
  RETURN NEXT ok(
    has_table_privilege('authenticated', 'api.route_plans', 'SELECT'),
    'authenticated can select api.route_plans'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'capabilities', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_plans.read'
    ),
    'access_control_policy exposes route_plans.read capability'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'capabilities', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_plans.write'
    ),
    'access_control_policy exposes route_plans.write capability'
  );
  RETURN NEXT is(v_access#>>'{resource_map,route_plans,read}', 'route_plans.read', 'resource_map wires route_plans.read');
  RETURN NEXT is(v_access#>>'{resource_map,route_plans,write}', 'route_plans.write', 'resource_map wires route_plans.write');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'roles', '[]'::jsonb)) AS role(value)
      WHERE role.value->>'key' = 'ops_admin'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(role.value->'capability_keys', '[]'::jsonb)) AS cap(value)
          WHERE cap.value = 'route_plans.write'
        )
    ),
    'ops_admin includes route_plans.write capability'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_plans'
        AND item.value->>'relation' = 'public.route_plans'
    ),
    'ui_read_registry exposes route_plans against public.route_plans'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'route_plans'
    ),
    'console operations navigation includes route_plans'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,portal,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'route_plans'
    ),
    'portal operations navigation includes route_plans'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Plan UI Org', 'route-plan-ui-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'rpui-' || lower(left(v_org::text, 6)), 'Route Plan UI Branch');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Route Plan UI Client', 'route-plan-ui-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user, v_org, 'route-plan-ui-' || left(v_user::text, 8) || '@example.com', 'Route Plan UI Ops', 'ops_admin', 'tenant', NULL),
    (v_client_user, v_org, 'route-plan-ui-client-' || left(v_client_user::text, 8) || '@example.com', 'Route Plan UI Client User', 'client_admin', 'client', v_client);

  INSERT INTO public.shipments (
    id, organization_id, client_id, tracking_number, status, service_type, created_at, updated_at
  )
  VALUES
    (v_shipment1, v_org, v_client, 'RPUI-1-' || upper(left(v_shipment1::text, 8)), 'pending', 'delivery', now(), now()),
    (v_shipment2, v_org, v_client, 'RPUI-2-' || upper(left(v_shipment2::text, 8)), 'pending', 'delivery', now(), now());

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_plan
    FROM api.ui_create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_spoofed_org,
        'requested_by_user_id', v_spoofed_user,
        'branch_id', v_branch,
        'planned_date', '2026-04-03',
        'idempotency_key', 'pgtap-route-plan-ui-contract',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1),
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 2)
          )
        )
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_plan.created IS TRUE, 'api.ui_create_route_plan_v1 creates a route_plan');
  RETURN NEXT is(
    (SELECT organization_id::text FROM public.route_plans WHERE id = v_plan.route_plan_id),
    v_org::text,
    'ui create ignores spoofed organization_id and uses current tenant organization'
  );
  RETURN NEXT is(
    (SELECT requested_by_user_id::text FROM public.route_plans WHERE id = v_plan.route_plan_id),
    v_user::text,
    'ui create ignores spoofed requested_by_user_id and uses current authenticated user'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.route_plans WHERE id = v_plan.route_plan_id),
    1,
    'api.route_plans exposes the created route_plan to the owner'
  );
  RETURN NEXT is(
    jsonb_array_length(api.ui_route_plan_resolve_stops_v1(v_plan.route_plan_id)),
    2,
    'api.ui_route_plan_resolve_stops_v1 returns the planned stops'
  );

  SELECT *
    INTO v_frozen
    FROM api.ui_freeze_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan.route_plan_id,
        'actor_user_id', v_spoofed_user,
        'idempotency_key', 'pgtap-route-plan-ui-freeze'
      )
    )
   LIMIT 1;

  RETURN NEXT is(v_frozen.status, 'frozen', 'api.ui_freeze_route_plan_v1 freezes the route_plan');
  RETURN NEXT is(
    (
      SELECT actor_user_id::text
      FROM public.route_plan_events
      WHERE route_plan_id = v_plan.route_plan_id
        AND event_type = 'frozen'
      ORDER BY created_at DESC
      LIMIT 1
    ),
    v_user::text,
    'ui freeze ignores spoofed actor_user_id and logs the authenticated actor'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.zones (id, organization_id, name, slug)
  VALUES (v_zone, v_org, 'Route Plan UI Zone', 'route-plan-ui-zone-' || left(v_zone::text, 8));

  INSERT INTO public.branch_zones (branch_id, zone_id, priority)
  VALUES (v_branch, v_zone, 10);

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES (v_standard_level, v_org, 'standard', 'Standard', TRUE);

  INSERT INTO public.service_offerings (service_level_id, branch_id, zone_id, effective_from, is_active, priority)
  VALUES (v_standard_level, v_branch, v_zone, '2026-01-01T00:00:00Z', TRUE, 10);

  INSERT INTO public.branch_capacity_windows (
    branch_id,
    zone_id,
    service_level_id,
    effective_from,
    capacity,
    is_active,
    priority
  )
  VALUES (
    v_branch,
    v_zone,
    v_standard_level,
    '2026-01-01T00:00:00Z',
    jsonb_build_object('max_stops', 50),
    TRUE,
    10
  );

  UPDATE public.shipments
     SET zone_id = v_zone,
         service_level = 'standard',
         promised_delivery_date = DATE '2026-04-03',
         promised_window_start_at = '2026-04-03T08:00:00Z',
         promised_window_end_at = '2026-04-03T09:00:00Z',
         priority_score = CASE id WHEN v_shipment1 THEN 20 ELSE 10 END
   WHERE id IN (v_shipment1, v_shipment2);

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_wave_plan
    FROM api.ui_build_delivery_wave_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_spoofed_org,
        'requested_by_user_id', v_spoofed_user,
        'branch_id', v_branch,
        'planned_date', '2026-04-03',
        'wave_selection', jsonb_build_object(
          'statuses', jsonb_build_array('pending')
        )
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_wave_plan.created IS TRUE, 'api.ui_build_delivery_wave_route_plan_v1 creates a route_plan');
  RETURN NEXT is(
    (SELECT organization_id::text FROM public.route_plans WHERE id = v_wave_plan.route_plan_id),
    v_org::text,
    'ui build delivery wave ignores spoofed organization_id and uses current tenant organization'
  );
  RETURN NEXT is(
    (SELECT requested_by_user_id::text FROM public.route_plans WHERE id = v_wave_plan.route_plan_id),
    v_user::text,
    'ui build delivery wave ignores spoofed requested_by_user_id and uses current authenticated user'
  );
  RETURN NEXT is(
    jsonb_array_length(api.ui_route_plan_resolve_stops_v1(v_wave_plan.route_plan_id)),
    2,
    'api.ui_build_delivery_wave_route_plan_v1 writes resolved stops through the route_plan contract'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_client_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    PERFORM api.ui_create_route_plan_v1(
      jsonb_build_object(
        'branch_id', v_branch,
        'planned_date', '2026-04-03',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1)
          )
        )
      )
    );
    RETURN NEXT fail('client-scoped user cannot create route_plans');
  EXCEPTION
    WHEN others THEN
      RETURN NEXT matches(SQLERRM, '.*route_plans.write capability.*|.*tenant scope.*', 'client-scoped user cannot create route_plans');
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_route_plan_ui_api_contract_v1();

SELECT * FROM finish();
ROLLBACK;
