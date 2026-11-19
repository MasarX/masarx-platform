-- pgTAP: Console V2 dispatch assignment honors platform active-tenant scope.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_dispatch_assignment_platform_tenant_scope_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_platform_home_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_platform_user UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_route RECORD;
  v_result JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'api',
    'ui_execute_route_run_assign_v1',
    ARRAY['text','text','text[]','text','integer','jsonb'],
    'api.ui_execute_route_run_assign_v1 exists'
  );

  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_execute_route_run_assign_v1(text, text, text[], text, integer, jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_execute_route_run_assign_v1'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Dispatch Platform Scope Org', 'dispatch-platform-scope-' || left(v_org::text, 8)),
    (v_other_org, 'Dispatch Platform Other Org', 'dispatch-platform-other-' || left(v_other_org::text, 8)),
    (v_platform_home_org, 'Dispatch Platform Home Org', 'dispatch-platform-home-' || left(v_platform_home_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'dps-' || lower(left(v_org::text, 6)), 'Dispatch Platform Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Dispatch Platform Client', 'dispatch-platform-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (
      v_platform_user,
      v_platform_home_org,
      'dispatch-platform-' || left(v_platform_user::text, 8) || '@example.com',
      'Dispatch Platform Operator',
      'super_admin',
      'active',
      'platform',
      NULL
    ),
    (
      v_driver,
      v_org,
      'dispatch-driver-' || left(v_driver::text, 8) || '@example.com',
      'Dispatch Driver',
      'driver',
      'active',
      'tenant',
      NULL
    );

  INSERT INTO public.vehicles (id, organization_id, plate_number, status, is_active)
  VALUES (v_vehicle, v_org, 'DPS-' || upper(left(v_vehicle::text, 6)), 'active', TRUE);

  INSERT INTO public.shipments (organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_org, v_client, 'DPS-' || upper(left(gen_random_uuid()::text, 8)), 'delivery', 'pending'),
    (v_org, v_client, 'DPS-' || upper(left(gen_random_uuid()::text, 8)), 'delivery', 'pending');

  SELECT *
    INTO v_route
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'stops', (
          SELECT jsonb_agg(
            jsonb_build_object(
              'client_id', s.client_id,
              'shipment_id', s.id,
              'stop_kind', 'delivery',
              'sequence_order', s.sequence_order
            )
            ORDER BY s.sequence_order
          )
          FROM (
            SELECT
              id,
              client_id,
              row_number() OVER (ORDER BY created_at, id) AS sequence_order
              FROM public.shipments
             WHERE organization_id = v_org
             ORDER BY created_at, id
          ) s
        )
      )
    )
   LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_execute_route_run_assign_v1(
    'route_runs.assign',
    'route_runs',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'organization_id', v_org,
      'driver_user_id', v_driver,
      'vehicle_id', v_vehicle,
      'idempotency_key', 'pgtap-dispatch-platform-scope-assign'
    )
  );

  RETURN NEXT is(v_result->>'status', 'assigned', 'platform active-tenant dispatch assignment succeeds');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT driver_user_id::text FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id),
    v_driver::text,
    'assignment projection stores active-tenant driver'
  );
  RETURN NEXT is(
    (SELECT assigned_by_user_id::text FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id),
    v_platform_user::text,
    'assignment projection stores authenticated platform actor'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
        FROM public.tasks t
        JOIN public.task_types tt ON tt.id = t.task_type_id
       WHERE tt.organization_id = v_org
         AND tt.key = 'route_stop_execute'
         AND t.assigned_to = v_driver
         AND EXISTS (
           SELECT 1
             FROM public.route_stops rs
            WHERE rs.id = t.resource_id
              AND rs.route_run_id = v_route.route_run_id
         )
    ),
    '2',
    'route_stop_execute tasks are assigned to the selected driver'
  );

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    PERFORM api.ui_execute_route_run_assign_v1(
      'route_runs.assign',
      'route_runs',
      ARRAY[v_route.route_run_id::text],
      v_route.route_run_id::text,
      1,
      jsonb_build_object(
        'driver_user_id', v_driver,
        'idempotency_key', 'pgtap-dispatch-platform-scope-missing-org'
      )
    );
    RETURN NEXT fail('platform dispatch assignment without organization_id fails closed');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('platform dispatch assignment without organization_id fails closed');
  END;

  BEGIN
    PERFORM api.ui_execute_route_run_assign_v1(
      'route_runs.assign',
      'route_runs',
      ARRAY[v_route.route_run_id::text],
      v_route.route_run_id::text,
      1,
      jsonb_build_object(
        'organization_id', v_other_org,
        'driver_user_id', v_driver,
        'idempotency_key', 'pgtap-dispatch-platform-scope-mismatch-org'
      )
    );
    RETURN NEXT fail('platform dispatch assignment with mismatched organization_id fails closed');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('platform dispatch assignment with mismatched organization_id fails closed');
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_dispatch_assignment_platform_tenant_scope_v1();

SELECT * FROM finish();

ROLLBACK;
