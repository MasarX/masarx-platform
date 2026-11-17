-- Test: RLS + service_role policy coverage for partition leaves

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM partition_inventory pi
    JOIN pg_class c ON c.relname = pi.partition_name
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relrowsecurity = false
  ),
  'Partition leaves have RLS enabled'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM partition_inventory pi
    WHERE EXISTS (
        SELECT 1
        FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = pi.table_name
          AND p.roles @> ARRAY['service_role']::name[]
    )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = pi.partition_name
          AND p.roles @> ARRAY['service_role']::name[]
    )
  ),
  'Partition leaves inherit service_role policies when parents define them'
);

SELECT * FROM finish();

ROLLBACK;
