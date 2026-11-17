-- Migration: Fix partition_inventory RANGE bound parsing
-- Purpose: Ensure partition_inventory exposes start_at/end_at for RANGE and HASH+RANGE leaves.
--          A prior view update over-escaped the bound-regex, causing NULL start_at/end_at and
--          breaking partition window pgTAP assertions.
-- Date: 2025-12-30

BEGIN;

CREATE OR REPLACE VIEW public.partition_inventory AS
WITH leafs AS (
  SELECT c.oid AS oid,
         c.relname AS partition_name,
         c.relnamespace,
         p.oid AS parent_oid,
         p.relname AS parent_name,
         pg_get_expr(c.relpartbound, c.oid) AS part_expr,
         c.reltuples
  FROM pg_class c
  JOIN pg_inherits i ON i.inhrelid = c.oid
  JOIN pg_class p ON p.oid = i.inhparent
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname = 'public'
),
parents AS (
  SELECT l.*, gp.oid AS grandparent_oid, gp.relname AS grandparent_name
  FROM leafs l
  LEFT JOIN pg_inherits i2 ON i2.inhrelid = l.parent_oid
  LEFT JOIN pg_class gp ON gp.oid = i2.inhparent
),
base AS (
  SELECT partition_name,
         COALESCE(grandparent_name, parent_name) AS base_table_name,
         parent_name,
         part_expr,
         reltuples AS row_estimate
  FROM parents
),
bounds AS (
  SELECT b.*,
         regexp_replace((regexp_match(part_expr, 'FROM \(([^\)]+)\)'))[1], '^''|''$', '', 'g') AS from_text,
         regexp_replace((regexp_match(part_expr, 'TO \(([^\)]+)\)'))[1], '^''|''$', '', 'g') AS to_text
  FROM base b
)
SELECT
  base_table_name AS table_name,
  partition_name,
  parent_name,
  part_expr AS partition_expression,
  NULLIF(from_text,'')::timestamptz AS start_at,
  NULLIF(to_text,'')::timestamptz   AS end_at,
  GREATEST(EXTRACT(EPOCH FROM (now() - NULLIF(to_text,'')::timestamptz))/86400, 0)::numeric(12,2) AS age_days,
  row_estimate::bigint AS row_estimate,
  pc.partition_strategy,
  pc.partition_interval,
  pc.retention_months,
  COALESCE(pc.config->>'retention_policy','archive') AS retention_policy
FROM bounds b
LEFT JOIN partitioning_config pc ON pc.table_name = base_table_name;

COMMENT ON VIEW public.partition_inventory IS 'Inventory of partition leaves with bounds, age, and configured retention policy.';

REVOKE ALL ON public.partition_inventory FROM PUBLIC;
REVOKE ALL ON public.partition_inventory FROM anon;
REVOKE ALL ON public.partition_inventory FROM authenticated;
GRANT SELECT ON public.partition_inventory TO service_role;

COMMIT;

