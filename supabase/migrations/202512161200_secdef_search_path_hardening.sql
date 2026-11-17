-- Migration: Ensure SECURITY DEFINER functions pin safe search_path
-- Purpose: Enforce a safe, consistent search_path for all SECURITY DEFINER functions
--          (repo objective + pgTAP guard 045_secdef_search_path.sql).

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT
      n.nspname AS schema_name,
      p.proname AS function_name,
      pg_get_function_identity_arguments(p.oid) AS identity_args
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
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = public, workflow_handlers, extensions, pg_temp',
      r.schema_name,
      r.function_name,
      r.identity_args
    );
  END LOOP;
END
$$;

COMMIT;

