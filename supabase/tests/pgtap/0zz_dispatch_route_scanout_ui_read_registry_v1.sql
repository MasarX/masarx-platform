-- pgTAP: Dispatch route scanout UI read registry v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(25);

CREATE OR REPLACE FUNCTION pg_temp.test_dispatch_route_scanout_ui_read_registry_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_registry JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  RETURN NEXT has_view('public', 'v_route_run_directory', 'route_run_directory projection view exists');
  RETURN NEXT has_view('public', 'driver_profile_picker_v1', 'driver picker projection view exists');
  RETURN NEXT has_view('public', 'v_vehicle_directory', 'vehicle_directory projection view exists');

  RETURN NEXT ok(has_table_privilege('authenticated', 'public.v_route_run_directory', 'SELECT'), 'authenticated can select v_route_run_directory');
  RETURN NEXT ok(has_table_privilege('authenticated', 'public.driver_profile_picker_v1', 'SELECT'), 'authenticated can select driver_profile_picker_v1');
  RETURN NEXT ok(has_table_privilege('authenticated', 'public.v_vehicle_directory', 'SELECT'), 'authenticated can select v_vehicle_directory');
  RETURN NEXT ok(has_table_privilege('authenticated', 'public.route_run_assignments', 'SELECT'), 'authenticated can select route_run_assignments through RLS');
  RETURN NEXT ok(has_table_privilege('authenticated', 'public.route_run_assignment_events', 'SELECT'), 'authenticated can select route_run_assignment_events through RLS');
  RETURN NEXT ok(has_table_privilege('authenticated', 'public.route_stop_reassignment_events', 'SELECT'), 'authenticated can select route_stop_reassignment_events through RLS');

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'route_run_assignments'
        AND policyname = 'route_run_assignments_select_policy'
    ),
    'route_run_assignments has authenticated route visibility select policy'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'route_run_assignment_events'
        AND policyname = 'route_run_assignment_events_select_policy'
    ),
    'route_run_assignment_events has authenticated route visibility select policy'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'route_stop_reassignment_events'
        AND policyname = 'route_stop_reassignment_events_select_policy'
    ),
    'route_stop_reassignment_events has authenticated route visibility select policy'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_runs'
        AND item.value->>'relation' = 'api.route_runs'
        AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) = TRUE
    ),
    'ui_read_registry includes route_runs mapped to api.route_runs'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_run_directory'
        AND item.value->>'relation' = 'public.v_route_run_directory'
        AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) = TRUE
    ),
    'ui_read_registry includes route_run_directory mapped to v_route_run_directory'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'drivers'
        AND item.value->>'relation' = 'public.driver_profile_picker_v1'
        AND item.value->>'capability_read' = 'fleet.read'
        AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) = TRUE
    ),
    'ui_read_registry includes drivers mapped to driver_profile_picker_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'vehicle_directory'
        AND item.value->>'relation' = 'public.v_vehicle_directory'
        AND item.value->>'capability_read' = 'fleet.read'
        AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) = TRUE
    ),
    'ui_read_registry includes vehicle_directory mapped to v_vehicle_directory'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_run_assignments'
        AND item.value->>'relation' = 'public.route_run_assignments'
        AND item.value->>'capability_read' = 'routes.read'
    ),
    'ui_read_registry includes route_run_assignments'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_run_assignment_events'
        AND item.value->>'relation' = 'public.route_run_assignment_events'
        AND item.value->>'capability_read' = 'routes.read'
    ),
    'ui_read_registry includes route_run_assignment_events'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_stop_reassignment_events'
        AND item.value->>'relation' = 'public.route_stop_reassignment_events'
        AND item.value->>'capability_read' = 'routes.read'
    ),
    'ui_read_registry includes route_stop_reassignment_events'
  );

  RETURN NEXT is(
    (SELECT c.reloptions::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'v_route_run_directory'),
    '{security_invoker=true}',
    'v_route_run_directory is security_invoker'
  );
  RETURN NEXT is(
    (SELECT c.reloptions::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'driver_profile_picker_v1'),
    '{security_invoker=true}',
    'driver_profile_picker_v1 is security_invoker'
  );
  RETURN NEXT is(
    (SELECT c.reloptions::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'v_vehicle_directory'),
    '{security_invoker=true}',
    'v_vehicle_directory is security_invoker'
  );
  RETURN NEXT has_function(
    'public',
    'ui_read_registry_dispatch_route_scanout_resources_v1',
    ARRAY[]::text[],
    'dispatch route scanout registry resource helper exists'
  );
  RETURN NEXT has_function(
    'api',
    'route_run_scan_out_reconciliation_v1',
    ARRAY['uuid'],
    'api route_run_scan_out_reconciliation_v1 wrapper exists'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.route_run_scan_out_reconciliation_v1(uuid)', 'EXECUTE'),
    'authenticated can execute api route_run_scan_out_reconciliation_v1 wrapper'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_dispatch_route_scanout_ui_read_registry_v1();

SELECT * FROM finish();

ROLLBACK;
