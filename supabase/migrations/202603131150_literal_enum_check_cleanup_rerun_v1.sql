-- Migration: Literal enum CHECK cleanup rerun v1 (dynamic)
-- Purpose:
--   - Remove drifted literal-list CHECK constraints from long-lived environments.
--   - Align the database with the lookup-contract SSOT and the pgTAP zero-hardcoding rule.
-- Notes:
--   - Uses the same detection contract as 0zz_no_literal_enum_checks.sql.
--   - Dynamic and environment-safe: only drops constraints that currently violate the rule.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603131150_literal_enum_check_cleanup_rerun_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class c
      ON c.oid = con.conrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE con.contype = 'c'
      AND n.nspname IN ('public', 'qa')
      AND c.relkind IN ('r', 'p')
      AND c.relispartition = false
      AND c.relname NOT IN ('spatial_ref_sys')
      AND (
        pg_get_constraintdef(con.oid) ILIKE '% IN (%'
        OR pg_get_constraintdef(con.oid) ILIKE '% IN(%'
        OR pg_get_constraintdef(con.oid) ILIKE '%ANY (ARRAY[%'
      )
    ORDER BY n.nspname, c.relname, con.conname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      rec.schema_name,
      rec.table_name,
      rec.constraint_name
    );
  END LOOP;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603131150_literal_enum_check_cleanup_rerun_v1'));
COMMIT;
