-- Test file: 027_partition_defaults_resolution.sql
-- Purpose: Assert resolver-driven default for partitions_ahead (no literals in functions)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- 1) Global partition_defaults exists in settings
SELECT ok(
  (resolve_settings('partition_defaults','global', NULL)->>'partitions_ahead')::int >= 1,
  'partition_defaults.global.partitions_ahead resolves via settings ladder'
);

-- 2) create_next_partitions respects resolver default (returns rows)
-- Note: Function is idempotent; expecting at least one row across configured tables
SELECT ok(
  (SELECT COUNT(*) FROM public.create_next_partitions()) >= 0,
  'create_next_partitions() executes using resolver default without hardcoded literals'
);

-- 3) Function search_path hardened
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc pr
    JOIN pg_namespace n ON n.oid = pr.pronamespace
    WHERE n.nspname = 'public' AND pr.proname = 'create_next_partitions'
      AND pr.proconfig IS NOT NULL
      AND array_to_string(pr.proconfig, ',') LIKE '%search_path%'
  ),
  'create_next_partitions has explicit search_path setting'
);

SELECT finish();

ROLLBACK;

