-- pgTAP: Security definer functions pin search_path to safe schemas
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

SELECT no_plan();

CREATE TEMP TABLE tmp_secdef_search_path_violations AS
WITH security_definers AS (
  SELECT
    p.oid,
    n.nspname AS schema_name,
    p.proname AS function_name,
    p.proargtypes,
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
    sd.schema_name,
    sd.function_name,
    oidvectortypes(sd.proargtypes) AS signature,
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
SELECT *
FROM parsed_paths
WHERE search_path IS NULL
   OR cardinality(search_path) = 0
   OR (search_path[1] <> 'public' AND search_path <> ARRAY['pg_catalog', 'pg_temp']::text[])
   OR search_path[array_upper(search_path, 1)] <> 'pg_temp'
   OR array_position(search_path, 'pg_temp') <> cardinality(search_path)
   OR EXISTS (
     SELECT 1
     FROM unnest(search_path) AS elem
     WHERE elem NOT IN ('public', 'extensions', 'pg_catalog', 'pg_temp', 'workflow_handlers')
   );

-- Each failed assertion identifies the public catalog object without emitting settings values.
SELECT ok(FALSE, format('Trusted path for %I.%I(%s)',
  schema_name, function_name, signature))
FROM tmp_secdef_search_path_violations
ORDER BY schema_name, function_name, signature;

SELECT cmp_ok(
  (SELECT COUNT(*)::bigint FROM tmp_secdef_search_path_violations),
  '=',
  0::bigint,
  'All SECURITY DEFINER functions use trusted schemas with public first or catalog-only and pg_temp last'
);

SELECT finish();

ROLLBACK;
