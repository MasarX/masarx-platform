-- Migration: Rename unsuffixed RANGE partitions under _p0 parents to include _p0 suffix
-- Date: 2025-11-25 11:20

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
  FOR r_parent IN
    SELECT c.relname AS parent_name
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class base ON base.oid = i.inhparent
    WHERE c.relname ~ '.*_p0$'
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
      IF v_old ~ '.*_p[0-9]+$' THEN CONTINUE; END IF;
      v_new := v_old || '_p0';
      IF to_regclass('public.' || v_new) IS NULL THEN
        EXECUTE format('ALTER TABLE %I RENAME TO %I', v_old, v_new);
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
            EXCEPTION WHEN duplicate_table THEN CONTINUE;
            END;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;

