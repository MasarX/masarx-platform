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
  v_executor_scoped_tables regclass[];
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value INTO STRICT v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry' AND scope_type = 'global' AND scope_id IS NULL;

  SELECT array_agg(p.polrelid::regclass) INTO v_executor_scoped_tables
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
   WHERE c.relrowsecurity
     AND p.polcmd = 'r'
     AND 'ui_rpc_executor'::regrole::oid = ANY(p.polroles)
     AND pg_get_expr(p.polqual, p.polrelid) LIKE '%route_run_actor_can_read_v1(%'
     AND (p.polrelid, p.polname) IN (
       ('public.route_runs'::regclass, 'route_runs_select_policy'),
       ('public.route_run_assignments'::regclass, 'route_run_assignments_select_policy'),
       ('public.route_run_assignment_events'::regclass, 'route_run_assignment_events_select_policy')
     );

  RETURN NEXT has_view('public', 'v_route_run_directory', 'public.v_route_run_directory exists');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'route_run_directory'
         AND item.value->>'relation' = 'public.v_route_run_directory'
         AND item.value->>'read_relation' = 'public.console_route_run_directory_read_v1'
         AND item.value->>'id_column' = 'id'
         AND item.value->>'capability_read' = 'routes.read'
         AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) IS TRUE
         AND (item.value#>>'{scope_columns,tenant}' = 'organization_id'
              OR 'public.route_runs'::regclass = ANY(v_executor_scoped_tables))
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
         AND (item.value#>>'{scope_columns,tenant}' = 'organization_id'
              OR 'public.route_run_assignments'::regclass = ANY(v_executor_scoped_tables))
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
         AND (item.value#>>'{scope_columns,tenant}' = 'organization_id'
              OR 'public.route_run_assignment_events'::regclass = ANY(v_executor_scoped_tables))
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
         AND EXISTS (
           SELECT 1 FROM pg_catalog.pg_policies p
            WHERE p.schemaname = 'public'
              AND p.tablename = 'route_stop_reassignment_events'
              AND p.policyname = 'ui_rpc_executor_scoped_read'
         )
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
