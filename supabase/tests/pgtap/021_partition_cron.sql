-- Test file: 021_partition_cron.sql
-- Purpose: Verify pg_cron is available and partition maintenance jobs are scheduled

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- pg_cron extension present
SELECT ok(
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'),
  'pg_cron extension is installed'
);

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

