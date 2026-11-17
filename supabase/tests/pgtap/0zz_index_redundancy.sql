-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Test: No exact duplicate indexes in app schemas (zero redundancy).
--
-- Definition (exact duplicates):
--   Same table, same access method, same key columns/expressions, same predicate,
--   same NULLS NOT DISTINCT semantics.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

CREATE TEMP TABLE tmp_index_dups AS
WITH idx AS (
  SELECT
    n.nspname AS schema_name,
    t.relname AS table_name,
    i.relname AS index_name,
    am.amname AS access_method,
    pg_get_expr(pi.indpred, pi.indrelid) AS predicate_expr,
    pg_get_expr(pi.indexprs, pi.indrelid) AS index_exprs,
    pi.indkey,
    pi.indoption,
    pi.indnullsnotdistinct AS nulls_not_distinct
  FROM pg_index pi
  JOIN pg_class i ON i.oid = pi.indexrelid
  JOIN pg_am am ON am.oid = i.relam
  JOIN pg_class t ON t.oid = pi.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname IN ('public', 'qa')
    AND t.relkind IN ('r','p')
    AND t.relispartition = false
),
dups AS (
  SELECT
    schema_name,
    table_name,
    access_method,
    COALESCE(predicate_expr, '') AS predicate_expr,
    COALESCE(index_exprs, '') AS index_exprs,
    indkey,
    indoption,
    COALESCE(nulls_not_distinct, false) AS nulls_not_distinct,
    array_agg(index_name ORDER BY index_name) AS indexes,
    count(*) AS count
  FROM idx
  GROUP BY 1,2,3,4,5,6,7,8
  HAVING count(*) > 1
)
SELECT * FROM dups;

SELECT diag(
  'Duplicate index group: ' ||
  schema_name || '.' || table_name ||
  ' method=' || access_method ||
  ' predicate=' || CASE WHEN predicate_expr = '' THEN '(none)' ELSE predicate_expr END ||
  ' expr=' || CASE WHEN index_exprs = '' THEN '(none)' ELSE index_exprs END ||
  ' nulls_not_distinct=' || (CASE WHEN nulls_not_distinct THEN 'true' ELSE 'false' END) ||
  ' indexes=' || array_to_string(indexes, ', ')
)
FROM tmp_index_dups;

SELECT is(
  (SELECT count(*)::INT FROM tmp_index_dups),
  0,
  'No exact duplicate indexes in public/qa schemas'
);

SELECT * FROM finish();

ROLLBACK;
