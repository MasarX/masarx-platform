-- Test: RLS Matrix (proof for all non-partition public tables)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

CREATE TEMP TABLE _rls_matrix AS
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND c.relispartition = FALSE
  AND c.relname <> 'spatial_ref_sys'
ORDER BY c.relname;

SELECT plan((SELECT (COUNT(*) * 2)::INT FROM _rls_matrix));

-- 1) RLS enabled
SELECT ok(rls_enabled, format('RLS enabled on %s.%s', schema_name, table_name))
FROM _rls_matrix;

-- 2) At least one policy exists
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = m.schema_name
      AND p.tablename = m.table_name
    LIMIT 1
  ),
  format('%s.%s has at least one policy', schema_name, table_name)
)
FROM _rls_matrix m;

SELECT finish();

ROLLBACK;
