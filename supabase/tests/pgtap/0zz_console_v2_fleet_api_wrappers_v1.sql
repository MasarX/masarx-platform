-- pgTAP: Console V2 fleet api-schema wrappers required by browser clients.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

CREATE OR REPLACE FUNCTION test_console_v2_fleet_api_wrapper_contracts()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rpc TEXT;
  v_signature TEXT;
  v_rpcs TEXT[] := ARRAY[
    'complete_maintenance_v1',
    'cancel_maintenance_v1',
    'record_vehicle_event_v1'
  ];
BEGIN
  FOREACH v_rpc IN ARRAY v_rpcs LOOP
    v_signature := format('api.%s(jsonb)', v_rpc);

    RETURN NEXT has_function(
      'api',
      v_rpc,
      ARRAY['jsonb'],
      format('%s exists for browser-safe Console V2 live calls', v_signature)
    );

    RETURN NEXT ok(
      has_function_privilege('authenticated', v_signature, 'execute'),
      format('authenticated can execute %s', v_signature)
    );

    RETURN NEXT ok(
      has_function_privilege('service_role', v_signature, 'execute'),
      format('service_role can execute %s', v_signature)
    );

    RETURN NEXT ok(
      NOT has_function_privilege('anon', v_signature, 'execute'),
      format('anon cannot execute %s', v_signature)
    );

    RETURN NEXT ok(
      EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'api'
           AND p.proname = v_rpc
           AND pg_catalog.oidvectortypes(p.proargtypes) = 'jsonb'
           AND p.prosecdef
      ),
      format('%s is SECURITY DEFINER', v_signature)
    );
  END LOOP;
END;
$function$;

SELECT * FROM test_console_v2_fleet_api_wrapper_contracts();

CREATE OR REPLACE FUNCTION test_console_v2_fleet_api_wrapper_execution()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '0fb09000-0000-0000-0000-000000000001'::uuid;
  v_branch UUID := '0fb09000-0000-0000-0000-000000000101'::uuid;
  v_admin UUID := '0fb09000-0000-0000-0000-000000000401'::uuid;
  v_vehicle_type UUID := '0fb09000-0000-0000-0000-000000000601'::uuid;
  v_vehicle UUID := '0fb09000-0000-0000-0000-000000000701'::uuid;
  v_complete_window UUID := '0fb09000-0000-0000-0000-000000000801'::uuid;
  v_cancel_window UUID := '0fb09000-0000-0000-0000-000000000802'::uuid;
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Fleet API Wrapper Org', 'fleet-api-wrapper-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'fleet-api-wrapper-b1', 'Fleet API Wrapper Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (v_admin, v_org, 'fleet-api-wrapper-admin@example.com', 'Fleet API Wrapper Admin', 'fleet_manager', 'tenant');

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES (v_vehicle_type, v_org, 'api-wrapper-van', 'API Wrapper Van', TRUE);

  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES (v_vehicle, v_org, v_branch, v_vehicle_type, 'API-901', 'active', TRUE);

  INSERT INTO public.vehicle_maintenance_windows (
    id, organization_id, vehicle_id, window_start_at, window_end_at, status, reason
  ) VALUES
    (v_complete_window, v_org, v_vehicle, now() - interval '2 hours', now() + interval '1 hour', 'scheduled', 'inspection'),
    (v_cancel_window, v_org, v_vehicle, now() + interval '1 day', now() + interval '1 day 2 hours', 'scheduled', 'shop_closed');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['fleet_manager'], v_admin);

  INSERT INTO public.rbac_user_role_assignments (
    organization_id, user_id, role_id, assigned_by_user_id, metadata
  )
  SELECT v_org, v_admin, r.id, v_admin, jsonb_build_object('test', 'fleet_api_wrapper_execution')
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  v_result := api.complete_maintenance_v1(jsonb_build_object(
    'vehicle_maintenance_window_id', v_complete_window,
    'notes', 'completed through api wrapper'
  ));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'api.complete_maintenance_v1 delegates and returns ok=TRUE');
  RETURN NEXT is(
    (SELECT status FROM public.vehicle_maintenance_windows WHERE id = v_complete_window),
    'completed',
    'api.complete_maintenance_v1 updates canonical maintenance status'
  );

  v_result := api.cancel_maintenance_v1(jsonb_build_object(
    'vehicle_maintenance_window_id', v_cancel_window,
    'reason', 'shop_closed'
  ));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'api.cancel_maintenance_v1 delegates and returns ok=TRUE');
  RETURN NEXT is(
    (SELECT status FROM public.vehicle_maintenance_windows WHERE id = v_cancel_window),
    'cancelled',
    'api.cancel_maintenance_v1 updates canonical maintenance status'
  );

  v_result := api.record_vehicle_event_v1(jsonb_build_object(
    'vehicle_id', v_vehicle,
    'event_type', 'fuel',
    'fuel_liters', '37.25',
    'cost_amount', '186.25',
    'cost_currency', 'SAR',
    'odometer_km', '45678'
  ));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'api.record_vehicle_event_v1 delegates and returns ok=TRUE');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.vehicle_events ve
       WHERE ve.vehicle_id = v_vehicle
         AND ve.event_type = 'fuel'
         AND ve.fuel_liters = 37.25
         AND ve.cost_currency = 'SAR'
    ),
    'api.record_vehicle_event_v1 appends canonical vehicle event ledger row'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_console_v2_fleet_api_wrapper_execution();

ROLLBACK;
