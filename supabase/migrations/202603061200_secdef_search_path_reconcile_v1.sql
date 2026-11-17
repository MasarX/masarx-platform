-- Plan: PLAN-202603-frontend-audit-remediation / Step: S97
-- Purpose:
--   - Reconcile any remaining SECURITY DEFINER functions that still do not pin
--     a safe search_path, so cloud pgTAP secdef guards stay green.
--   - Keep the fix dynamic by scanning the live catalog instead of hardcoding
--     function names.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061200_secdef_search_path_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_func RECORD;
  v_identity_args TEXT;
  v_search_path TEXT;
BEGIN
  FOR v_func IN
    WITH security_definers AS (
      SELECT
        p.oid,
        n.nspname AS schema_name,
        p.proname AS function_name,
        p.proconfig,
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
    ),
    parsed_paths AS (
      SELECT
        sd.oid,
        sd.schema_name,
        sd.function_name,
        sd.identity_args,
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
      identity_args
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
    ORDER BY schema_name, function_name, identity_args
  LOOP
    v_identity_args := COALESCE(v_func.identity_args, '');
    v_search_path := CASE
      WHEN v_func.schema_name = 'workflow_handlers'
        THEN 'public, workflow_handlers, extensions, pg_temp'
      ELSE 'public, extensions, pg_temp'
    END;

    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path TO %s',
      v_func.schema_name,
      v_func.function_name,
      v_identity_args,
      v_search_path
    );
  END LOOP;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603061200_secdef_search_path_reconcile_v1'));
COMMIT;
