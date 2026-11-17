-- Migration: SECURITY DEFINER search_path enforcement
-- Purpose:
--   - Ensure all SECURITY DEFINER functions pin search_path to safe schemas:
--     public (+ extensions/workflow_handlers) and pg_temp.
--   - Protect against drift when functions are replaced without reapplying
--     search_path attributes (pgTAP 045_secdef_search_path.sql).

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    WITH security_definers AS (
      SELECT
        p.oid,
        n.nspname AS schema_name,
        p.proname AS function_name,
        p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      LEFT JOIN pg_depend d
        ON d.objid = p.oid
       AND d.deptype = 'e'
      LEFT JOIN pg_extension e
        ON e.oid = d.refobjid
      WHERE p.prosecdef
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pgbouncer', 'storage')
        AND e.oid IS NULL
    ),
    parsed_paths AS (
      SELECT
        sd.oid,
        sd.schema_name,
        sd.function_name,
        ARRAY(
          SELECT trim(both ' ' FROM elem)
          FROM unnest(string_to_array(split_part(cfg, '=', 2), ',')) AS elem
        ) AS search_path
      FROM security_definers sd
      LEFT JOIN LATERAL (
        SELECT cfg
        FROM unnest(COALESCE(sd.proconfig, ARRAY[]::text[])) AS cfg
        WHERE cfg ILIKE 'search_path=%'
        LIMIT 1
      ) sp ON TRUE
    )
    SELECT
      oid,
      schema_name,
      function_name,
      pg_get_function_identity_arguments(oid) AS args
    FROM parsed_paths
    WHERE search_path IS NULL
       OR cardinality(search_path) = 0
       OR search_path[1] <> 'public'
       OR search_path[array_upper(search_path, 1)] <> 'pg_temp'
       OR EXISTS (
         SELECT 1
         FROM unnest(search_path) AS elem
         WHERE elem NOT IN ('public', 'extensions', 'pg_temp', 'workflow_handlers')
       )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = public, extensions, workflow_handlers, pg_temp',
      r.schema_name,
      r.function_name,
      r.args
    );
  END LOOP;
END $$;

COMMIT;

