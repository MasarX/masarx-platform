-- Migration: Fix RANGE partition naming convention under HASH parents
-- Purpose:
--   Ensure RANGE partitions under HASH parents follow the *_p{remainder}
--   naming convention expected by 028_partition_naming_convention.sql.
--   This corrects historical partitions created without the suffix.

BEGIN;

DO $$
DECLARE
  r RECORD;
  v_new_name TEXT;
BEGIN
  FOR r IN
    SELECT
      child.relname AS child_name,
      parent.relname AS parent_name,
      COALESCE(
        NULLIF(regexp_replace(parent.relname, '.*_p([0-9]+)$', '\1'), ''),
        '0'
      )::INT AS parent_rem
    FROM pg_class child
    JOIN pg_inherits i ON i.inhrelid = child.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_inherits ip ON ip.inhrelid = parent.oid
    JOIN pg_class base ON base.oid = ip.inhparent
    JOIN partitioning_config pc
      ON pc.table_name = base.relname
     AND pc.partition_strategy = 'HASH+RANGE'
    WHERE parent.relname ~ '.*_p[0-9]+$'
      AND child.relkind = 'r'
      AND child.relname !~ '.*_p[0-9]+$'
  LOOP
    v_new_name := format('%s_p%s', r.child_name, r.parent_rem);
    RAISE NOTICE 'Renaming partition % to %', r.child_name, v_new_name;
    EXECUTE format('ALTER TABLE %I RENAME TO %I', r.child_name, v_new_name);
  END LOOP;
END;
$$;

COMMIT;

