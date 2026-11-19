-- pgTAP: Console V2 Users can read the user_directory projection via the
-- canonical live ui_read_registry path.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_user_directory_registry_v1()
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

  RETURN NEXT has_view('public', 'v_user_directory', 'public.v_user_directory exists');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'user_directory'
         AND item.value->>'relation' = 'public.v_user_directory'
         AND item.value->>'id_column' = 'id'
         AND item.value->>'capability_read' = 'users.read'
         AND item.value#>>'{scope_columns,tenant}' = 'organization_id'
         AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) IS TRUE
    ),
    'ui_read_registry exposes user_directory as scoped view-backed resource'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'user_directory'
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(item.value->'filters', '[]'::jsonb)) AS filter(value)
            WHERE filter.value->>'key' = 'organization_id'
              AND filter.value->>'column' = 'organization_id'
              AND filter.value->>'op' = 'eq'
         )
    ),
    'user_directory allows tenant organization_id filtering from Console V2'
  );
  RETURN NEXT ok(
    has_table_privilege('authenticated', 'public.v_user_directory', 'SELECT'),
    'authenticated can select public.v_user_directory'
  );
  RETURN NEXT ok(
    NOT has_table_privilege('anon', 'public.v_user_directory', 'SELECT'),
    'anon cannot select public.v_user_directory'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'v_user_directory'
         AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']::text[]
    ),
    'user_directory is security_invoker for view-aware reads'
  );
  RETURN NEXT lives_ok(
    $sql$
      SELECT id, organization_id, email, active_role_count, active_role_keys
        FROM public.v_user_directory
       LIMIT 1
    $sql$,
    'v_user_directory exposes the frontend role-rollup columns'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_user_directory_registry_v1();

SELECT * FROM finish();

ROLLBACK;
