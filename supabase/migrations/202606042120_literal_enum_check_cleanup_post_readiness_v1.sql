-- Migration: Literal enum CHECK cleanup post-readiness v1
-- Purpose:
--   - Keep lookup-governed values row-driven after late readiness migrations.
--   - Remove any remaining literal-list CHECK constraints from app schemas.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606042120_literal_enum_check_cleanup_post_readiness_v1'));

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
      AND public.constraint_has_literal_allowlist_v1(pg_get_constraintdef(con.oid))
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

SELECT pg_advisory_unlock(hashtext('202606042120_literal_enum_check_cleanup_post_readiness_v1'));
COMMIT;
