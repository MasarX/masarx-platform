-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: Index redundancy repair v1 (dynamic)
-- Purpose:
--   - Repair drift in long-lived environments by removing exact duplicate indexes in app schemas.
--   - Keeps a single preferred index per duplicate group (per 0zz_index_redundancy.sql).
--   - Safety: never drops constraint-backed or replica-identity indexes.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041110_index_redundancy_repair_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  rec RECORD;
  drop_stmt TEXT;
BEGIN
  -- If the only way to fix duplicates is to drop constraint-backed indexes, fail-fast.
  IF EXISTS (
    WITH idx AS (
      SELECT
        n.nspname AS schema_name,
        t.relname AS table_name,
        i.oid AS index_oid,
        am.amname AS access_method,
        COALESCE(pg_get_expr(pi.indpred, pi.indrelid), '') AS predicate_expr,
        COALESCE(pg_get_expr(pi.indexprs, pi.indrelid), '') AS index_exprs,
        pi.indkey,
        pi.indoption,
        COALESCE(pi.indnullsnotdistinct, false) AS nulls_not_distinct,
        EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.oid) AS is_constraint_index
      FROM pg_index pi
      JOIN pg_class i ON i.oid = pi.indexrelid
      JOIN pg_am am ON am.oid = i.relam
      JOIN pg_class t ON t.oid = pi.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname IN ('public','qa')
        AND t.relkind IN ('r','p')
        AND t.relispartition = false
    ),
    dups AS (
      SELECT
        schema_name,
        table_name,
        access_method,
        predicate_expr,
        index_exprs,
        indkey,
        indoption,
        nulls_not_distinct,
        sum(CASE WHEN is_constraint_index THEN 1 ELSE 0 END) AS constraint_count,
        count(*) AS idx_count
      FROM idx
      GROUP BY 1,2,3,4,5,6,7,8
      HAVING count(*) > 1
    )
    SELECT 1
    FROM dups
    WHERE constraint_count > 1
  ) THEN
    RAISE EXCEPTION 'index_redundancy_repair_v1: duplicate index group has multiple constraint-backed indexes; manual fix required';
  END IF;

  -- Drop redundant indexes (exact duplicates) while keeping a single preferred survivor per group.
  FOR rec IN
    WITH idx AS (
      SELECT
        n.nspname AS schema_name,
        t.relname AS table_name,
        i.relname AS index_name,
        i.oid AS index_oid,
        am.amname AS access_method,
        COALESCE(pg_get_expr(pi.indpred, pi.indrelid), '') AS predicate_expr,
        COALESCE(pg_get_expr(pi.indexprs, pi.indrelid), '') AS index_exprs,
        pi.indkey,
        pi.indoption,
        COALESCE(pi.indnullsnotdistinct, false) AS nulls_not_distinct,
        EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.oid) AS is_constraint_index,
        COALESCE(pi.indisreplident, false) AS is_replica_identity,
        COALESCE(pi.indisunique, false) AS is_unique,
        CASE WHEN i.relname ~ '^idx_fk_' THEN 0 ELSE 1 END AS prefer_name
      FROM pg_index pi
      JOIN pg_class i ON i.oid = pi.indexrelid
      JOIN pg_am am ON am.oid = i.relam
      JOIN pg_class t ON t.oid = pi.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname IN ('public','qa')
        AND t.relkind IN ('r','p')
        AND t.relispartition = false
    ),
    dups AS (
      SELECT
        schema_name,
        table_name,
        access_method,
        predicate_expr,
        index_exprs,
        indkey,
        indoption,
        nulls_not_distinct
      FROM idx
      GROUP BY 1,2,3,4,5,6,7,8
      HAVING count(*) > 1
    ),
    ranked AS (
      SELECT
        idx.*,
        row_number() OVER (
          PARTITION BY schema_name, table_name, access_method, predicate_expr, index_exprs, indkey, indoption, nulls_not_distinct
          ORDER BY
            is_constraint_index DESC,
            is_replica_identity DESC,
            is_unique DESC,
            prefer_name DESC,
            index_name ASC
        ) AS rn
      FROM idx
      JOIN dups USING (schema_name, table_name, access_method, predicate_expr, index_exprs, indkey, indoption, nulls_not_distinct)
    )
    SELECT schema_name, index_name
    FROM ranked
    WHERE rn > 1
      AND is_constraint_index = false
      AND is_replica_identity = false
    ORDER BY schema_name, index_name
  LOOP
    drop_stmt := format('DROP INDEX IF EXISTS %I.%I', rec.schema_name, rec.index_name);
    EXECUTE drop_stmt;
  END LOOP;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202602041110_index_redundancy_repair_v1'));
COMMIT;

