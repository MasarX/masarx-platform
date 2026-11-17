-- Test file: 028_partition_naming_convention.sql
-- Purpose: Ensure RANGE partitions under hash parents include _p{remainder} suffix (including p0)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- 1) No RANGE child under any HASH parent lacks _p{n} suffix
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_class child
    JOIN pg_inherits i ON i.inhrelid = child.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_inherits ip ON ip.inhrelid = parent.oid
    JOIN pg_class base ON base.oid = ip.inhparent
    JOIN partitioning_config pc ON pc.table_name = base.relname AND pc.partition_strategy = 'HASH+RANGE'
    WHERE parent.relname ~ '.*_p[0-9]+$'
      AND child.relkind = 'r'
      AND child.relname !~ '.*_p[0-9]+$'
  ),
  'All RANGE partitions under hash parents have _p{remainder} suffix'
);

-- 2) For each RANGE child, the suffix remainder matches its direct parent remainder
SELECT ok(
  NOT EXISTS (
    WITH parents AS (
      SELECT child.relname AS child_name,
             parent.relname AS parent_name,
             COALESCE(NULLIF(regexp_replace(parent.relname, '.*_p([0-9]+)$', '\1'),''), '0')::int AS parent_rem,
             COALESCE(NULLIF(regexp_replace(child.relname,  '.*_p([0-9]+)$', '\1'),''), NULL)::int AS child_rem
      FROM pg_class child
      JOIN pg_inherits i ON i.inhrelid = child.oid
      JOIN pg_class parent ON parent.oid = i.inhparent
      WHERE child.relkind = 'r' AND parent.relname ~ '.*_p[0-9]+$'
    )
    SELECT 1 FROM parents
    WHERE child_rem IS NULL OR child_rem <> parent_rem
  ),
  'RANGE child suffix matches direct parent remainder'
);

SELECT finish();

ROLLBACK;
