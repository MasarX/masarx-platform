BEGIN;
SET LOCAL search_path TO pg_catalog, public, workflow_handlers, extensions, pg_temp;

DO $migration$
DECLARE
  session_path CONSTANT text := $pattern$(\mPERFORM\s+(?:pg_catalog\.)?set_config\s*\(\s*'search_path'\s*,\s*'(public(?:, workflow_handlers)?(?:, extensions)?, pg_temp)'\s*,\s*)false(\s*\))$pattern$;
  body_header CONSTANT text := $pattern$(\n[ ]*AS \$[[:alnum:]_]*\$)$pattern$;
  handler record;
  definition text;
BEGIN
  FOR handler IN
    SELECT p.oid, p.oid::regprocedure AS signature, (path_match.parts)[2] AS body_path,
           EXISTS (
             SELECT 1 FROM unnest(p.proconfig) AS settings(setting)
             WHERE setting LIKE 'search_path=%'
           ) AS has_function_path
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL regexp_match(p.prosrc, session_path, 'i') AS path_match(parts)
    WHERE n.nspname = 'workflow_handlers' AND p.prokind = 'f'
      AND path_match.parts IS NOT NULL
    ORDER BY p.oid::regprocedure::text
  LOOP
    -- A transaction-local change restores the caller's setting only inside a function SET scope.
    definition := regexp_replace(pg_get_functiondef(handler.oid), session_path, E'\\1true\\3', 'gi');
    IF NOT handler.has_function_path THEN
      IF definition !~ body_header THEN
        RAISE EXCEPTION 'No function body header found for %', handler.signature;
      END IF;
      definition := regexp_replace(definition, body_header, E'\n SET search_path TO ' || handler.body_path || E'\\1');
    END IF;
    EXECUTE definition;
  END LOOP;
END;
$migration$;

COMMIT;
