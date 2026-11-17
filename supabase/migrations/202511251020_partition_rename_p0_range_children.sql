-- Migration: Normalize RANGE partition naming for p0 parents
-- Purpose: Ensure RANGE partitions under hash parent _p0 also end with `_p0` suffix for consistency
-- Date: 2025-11-25 10:20

BEGIN;

DO $$
DECLARE
  r_parent RECORD;
  r_part RECORD;
  v_old TEXT;
  v_new TEXT;
  r_idx RECORD;
  v_new_idx TEXT;
BEGIN
  -- For all HASH+RANGE tables, find hash parent p0 and rename its RANGE children lacking _pN suffix
  FOR r_parent IN
    SELECT c.relname AS parent_name
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN partitioning_config pc ON pc.table_name = p.relname
    WHERE pc.partition_strategy = 'HASH+RANGE'
      AND c.relname ~ '.*_p0$'
  LOOP
    FOR r_part IN
      SELECT c.relname AS part_name, c.oid AS part_oid
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = r_parent.parent_name
        AND c.relkind = 'r'
    LOOP
      v_old := r_part.part_name;
      -- Skip if already suffixed with _pN
      IF v_old ~ '.*_p[0-9]+$' THEN CONTINUE; END IF;

      v_new := v_old || '_p0';

      -- Only rename when target does not exist
      IF to_regclass('public.' || v_new) IS NULL THEN
        EXECUTE format('ALTER TABLE %I RENAME TO %I', v_old, v_new);

        -- Rename indexes attached to the partition to preserve clarity
        FOR r_idx IN
          SELECT i.relname AS indexname
          FROM pg_class i
          JOIN pg_index ix ON ix.indexrelid = i.oid
          WHERE ix.indrelid = r_part.part_oid
        LOOP
          v_new_idx := replace(r_idx.indexname, v_old, v_new);
          IF v_new_idx IS DISTINCT FROM r_idx.indexname THEN
            BEGIN
              EXECUTE format('ALTER INDEX %I RENAME TO %I', r_idx.indexname, v_new_idx);
            EXCEPTION WHEN duplicate_table THEN
              -- If collision, keep existing index name (safe, rare)
              CONTINUE;
            END;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;

