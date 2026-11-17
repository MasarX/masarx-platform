-- Test: Partition security (RLS + least-privilege grants)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

CREATE TEMP TABLE _partition_security AS
SELECT
  c.relname AS partition_name,
  p.relname AS parent_name,
  c.relrowsecurity AS rls_enabled,
  EXISTS (
    SELECT 1
    FROM pg_policies pol
    WHERE pol.schemaname = 'public'
      AND pol.tablename = c.relname
    LIMIT 1
  ) AS has_policy,
  (
    has_table_privilege('authenticated', c.oid, 'select')
    OR has_table_privilege('authenticated', c.oid, 'insert')
    OR has_table_privilege('authenticated', c.oid, 'update')
    OR has_table_privilege('authenticated', c.oid, 'delete')
    OR has_table_privilege('anon', c.oid, 'select')
    OR has_table_privilege('anon', c.oid, 'insert')
    OR has_table_privilege('anon', c.oid, 'update')
    OR has_table_privilege('anon', c.oid, 'delete')
  ) AS has_public_grants
FROM pg_class c
JOIN pg_inherits i ON i.inhrelid = c.oid
JOIN pg_class p ON p.oid = i.inhparent
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r';

SELECT plan((SELECT (COUNT(*) * 3)::int FROM _partition_security));

SELECT ok(
  rls_enabled,
  format('RLS enabled on partition %s (parent=%s)', partition_name, parent_name)
)
FROM _partition_security;

SELECT ok(
  has_policy,
  format('Partition %s has at least one policy', partition_name)
)
FROM _partition_security;

SELECT ok(
  NOT has_public_grants,
  format('Partition %s has no anon/auth grants', partition_name)
)
FROM _partition_security;

SELECT finish();

ROLLBACK;
