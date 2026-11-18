-- pgTAP: Console V2 Dispatch route_run_directory is live-registry readable.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_dispatch_route_run_directory_registry_v1()
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
   LIMIT 1;

  RETURN NEXT has_view('public', 'v_route_run_directory', 'public.v_route_run_directory exists');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'route_run_directory'
         AND item.value->>'relation' = 'public.v_route_run_directory'
         AND item.value->>'id_column' = 'id'
         AND item.value->>'capability_read' = 'routes.read'
         AND item.value#>>'{scope_columns,tenant}' = 'organization_id'
         AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) IS TRUE
    ),
    'ui_read_registry exposes route_run_directory as scoped view-backed resource'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'route_run_assignments'
         AND item.value->>'relation' = 'public.route_run_assignments'
         AND item.value->>'id_column' = 'id'
         AND item.value->>'capability_read' = 'routes.read'
         AND item.value#>>'{scope_columns,tenant}' = 'organization_id'
    ),
    'ui_read_registry exposes route_run_assignments for Dispatch insight rail'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'route_run_assignment_events'
         AND item.value->>'relation' = 'public.route_run_assignment_events'
         AND item.value->>'id_column' = 'id'
         AND item.value->>'capability_read' = 'routes.read'
         AND item.value#>>'{scope_columns,tenant}' = 'organization_id'
    ),
    'ui_read_registry exposes route_run_assignment_events for Dispatch insight rail'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'route_stop_reassignment_events'
         AND item.value->>'relation' = 'public.route_stop_reassignment_events'
         AND item.value->>'id_column' = 'id'
         AND item.value->>'capability_read' = 'routes.read'
         AND item.value#>>'{scope_columns,tenant}' = 'organization_id'
    ),
    'ui_read_registry exposes route_stop_reassignment_events for Dispatch insight rail'
  );
  RETURN NEXT ok(
    has_table_privilege('authenticated', 'public.v_route_run_directory', 'SELECT'),
    'authenticated can select public.v_route_run_directory'
  );
  RETURN NEXT ok(
    NOT has_table_privilege('anon', 'public.v_route_run_directory', 'SELECT'),
    'anon cannot select public.v_route_run_directory'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'v_route_run_directory'
         AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']::text[]
    ),
    'route_run_directory is security_invoker for view-aware reads'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_dispatch_route_run_directory_registry_v1();

SELECT * FROM finish();

ROLLBACK;
