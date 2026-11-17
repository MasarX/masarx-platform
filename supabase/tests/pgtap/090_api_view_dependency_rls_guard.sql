-- Test Suite: API view dependency RLS guard
-- Purpose: Ensure every base table reachable via PostgREST `api` schema views (and its partitions)
--          has RLS enabled and at least one policy defined.
--
-- Why:
-- - The `api` schema is the PostgREST exposure surface (hardened via `scripts/ops/workspace/harden-data-api.js`).
-- - Views are invoker-context; security must be enforced by underlying table RLS/policies.
-- - This guard is dependency-driven (no hardcoded table list) to prevent drift as views evolve.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

CREATE TEMP TABLE tmp_api_view_relations AS
WITH RECURSIVE api_views AS (
  SELECT c.oid AS view_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'api'
    AND c.relkind = 'v'
),
rel_closure AS (
  -- Start at the PostgREST `api` contract views.
  SELECT view_oid AS rel_oid
  FROM api_views
  UNION
  -- Follow view -> relation dependencies transitively (views can depend on other views).
  SELECT d.refobjid AS rel_oid
  FROM rel_closure rc
  JOIN pg_class src ON src.oid = rc.rel_oid
  JOIN pg_rewrite r ON r.ev_class = rc.rel_oid
  JOIN pg_depend d ON d.objid = r.oid
  WHERE src.relkind IN ('v', 'm')
    AND d.refclassid = 'pg_class'::regclass
),
base_relations AS (
  -- Only tables / partitioned tables need RLS + policies.
  SELECT DISTINCT c.oid
  FROM rel_closure rc
  JOIN pg_class c ON c.oid = rc.rel_oid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
),
rel_tree AS (
  -- Expand to all descendant partitions (if any) so the guard covers leaf tables too.
  SELECT oid
  FROM base_relations
  UNION ALL
  SELECT i.inhrelid
  FROM rel_tree t
  JOIN pg_inherits i ON i.inhparent = t.oid
),
policy_counts AS (
  SELECT polrelid, count(*)::int AS policy_count
  FROM pg_policy
  GROUP BY polrelid
)
SELECT
  n.nspname AS schema_name,
  c.relname AS relation_name,
  c.relkind,
  c.relrowsecurity AS rls_enabled,
  COALESCE(pc.policy_count, 0) AS policy_count
FROM (SELECT DISTINCT oid FROM rel_tree) t
JOIN pg_class c ON c.oid = t.oid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN policy_counts pc ON pc.polrelid = c.oid
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');

-- 2 assertions per relation.
SELECT plan(((SELECT count(*) FROM tmp_api_view_relations) * 2)::int);

SELECT ok(
  rls_enabled,
  format('RLS enabled for %I.%I', schema_name, relation_name)
)
FROM tmp_api_view_relations
ORDER BY schema_name, relation_name;

SELECT ok(
  policy_count > 0,
  format('Policy present for %I.%I', schema_name, relation_name)
)
FROM tmp_api_view_relations
ORDER BY schema_name, relation_name;

SELECT * FROM finish();

ROLLBACK;
