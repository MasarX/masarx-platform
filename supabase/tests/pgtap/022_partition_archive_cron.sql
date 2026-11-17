-- Test file: 022_partition_archive_cron.sql
-- Purpose: Verify pg_cron archive job, archive schema, and observability artifacts exist

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

-- pg_cron present
SELECT ok(
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'),
  'pg_cron extension is installed'
);

-- archive schema exists
SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'archive'
  ),
  'archive schema exists'
);

-- archiving_history table exists
SELECT ok(
  to_regclass('public.archiving_history') IS NOT NULL,
  'archiving_history table exists'
);

-- partition_inventory view exists
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'partition_inventory' AND c.relkind = 'v'
  ),
  'partition_inventory view exists'
);

-- partition_archive_old job scheduled
SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partition_archive_old'),
  'partition_archive_old monthly job scheduled'
);

SELECT finish();

ROLLBACK;

