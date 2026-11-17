-- Test file: 022a_partition_create_index_cron.sql
-- Purpose: Verify pg_cron jobs for create_next_partitions and index propagation exist

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- partition_create_next job scheduled
SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partition_create_next'),
  'partition_create_next weekly job scheduled'
);

-- partition_apply_index_templates job scheduled
SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partition_apply_index_templates'),
  'partition_apply_index_templates weekly job scheduled'
);

SELECT finish();

ROLLBACK;

