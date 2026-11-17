-- Migration: Partition security hardening (hash + range)
-- Purpose: include hash leaves in partition inventory and lock down partition grants/policies
-- Date: 2025-12-27

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
  WHERE c.relkind = 'r'
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

CREATE OR REPLACE FUNCTION public.sync_partition_security()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    rec RECORD;
    pol_name TEXT;
BEGIN
    FOR rec IN
        SELECT c.relname AS partition_name,
               p.relname AS parent_name
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rec.partition_name);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', rec.partition_name);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', rec.partition_name);
        pol_name := rec.partition_name || '_service_policy';
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = rec.partition_name
              AND policyname = pol_name
        ) THEN
            EXECUTE format(
                'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
                pol_name, rec.partition_name
            );
        END IF;
    END LOOP;
END;
$$;

ALTER FUNCTION public.sync_partition_security()
  SET search_path = public, extensions, pg_temp;

COMMENT ON FUNCTION public.sync_partition_security() IS
  'Enforces RLS + least-privilege grants for all partition leaf tables (hash and range).';

SELECT public.sync_partition_security();

COMMIT;
