-- Migration: Auto-fix SECURITY DEFINER function search_path drift
-- Purpose:
--   - Repair cloud drift where a project-owned SECURITY DEFINER function is
--     missing a safe pinned search_path (or has a non-compliant one), causing
--     pgTAP SECDEF search_path lint failures.
--   - Applies to non-extension functions outside excluded system schemas.
-- Date: 2025-12-17

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  rec RECORD;
  v_target_path TEXT;
BEGIN
  FOR rec IN
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
        sd.proconfig,
        pg_get_function_identity_arguments(sd.oid) AS identity_args,
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
    ),
    violations AS (
      SELECT *
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
    )
    SELECT schema_name, function_name, identity_args
    FROM violations
  LOOP
    v_target_path := CASE
      WHEN rec.schema_name = 'workflow_handlers' THEN 'public, workflow_handlers, extensions, pg_temp'
      ELSE 'public, extensions, pg_temp'
    END;

    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path TO %s',
      rec.schema_name,
      rec.function_name,
      rec.identity_args,
      v_target_path
    );
  END LOOP;
END $$;

COMMIT;

