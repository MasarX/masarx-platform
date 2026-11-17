-- Migration: Partition naming convention fixup (suffix leaf RANGE children)
-- Purpose: Rename any HASH+RANGE leaf partitions missing _p{remainder} suffix so pgtap naming tests pass
--          and create_next_partitions() cannot create overlapping duplicates.
-- Alignment: SIMPLE · SCALABLE · DYNAMIC · ZERO HARD CODING
-- Date: 2025-12-13

BEGIN;

DO $$
DECLARE
  r RECORD;
  v_new_name TEXT;
  r_idx RECORD;
  v_new_idx TEXT;
BEGIN
  FOR r IN
    SELECT
      child.relname AS child_name,
      child.oid AS child_oid,
      parent.relname AS parent_name,
      COALESCE(NULLIF(regexp_replace(parent.relname, '.*_p([0-9]+)$', '\1'), ''), '0')::int AS parent_rem
    FROM pg_class child
    JOIN pg_inherits i ON i.inhrelid = child.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_inherits ip ON ip.inhrelid = parent.oid
    JOIN pg_class base ON base.oid = ip.inhparent
    JOIN public.partitioning_config pc
      ON pc.table_name = base.relname
     AND pc.partition_strategy = 'HASH+RANGE'
    WHERE parent.relname ~ '.*_p[0-9]+$'
      AND child.relkind = 'r'
      AND child.relname !~ '.*_p[0-9]+$'
    ORDER BY base.relname, parent.relname, child.relname
  LOOP
    v_new_name := format('%s_p%s', r.child_name, r.parent_rem);

    IF to_regclass('public.' || v_new_name) IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', r.child_name, v_new_name);

      FOR r_idx IN
        SELECT i.relname AS indexname
        FROM pg_class i
        JOIN pg_index ix ON ix.indexrelid = i.oid
        WHERE ix.indrelid = r.child_oid
      LOOP
        v_new_idx := replace(r_idx.indexname, r.child_name, v_new_name);
        IF v_new_idx IS DISTINCT FROM r_idx.indexname THEN
          BEGIN
            EXECUTE format('ALTER INDEX %I RENAME TO %I', r_idx.indexname, v_new_idx);
          EXCEPTION WHEN duplicate_table THEN
            CONTINUE;
          END;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;

COMMIT;
