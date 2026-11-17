-- pgTAP: SECDEF functions search_path pinned
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
SELECT plan(1);

-- All project-owned SECURITY DEFINER functions should have a search_path starting with public
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND n.nspname = 'workflow_handlers'
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
        WHERE (cfg ILIKE 'search_path=public%' OR cfg ILIKE 'search_path=workflow_handlers%')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  ),
  'All project SECURITY DEFINER functions set search_path starting with public'
);

SELECT finish();
ROLLBACK;