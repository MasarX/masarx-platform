-- Partition Health Dashboard (read-only)
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/sql/partition-health.sql

\pset pager off
\timing on

-- 1) Coverage per table/parent vs configured window
WITH cfg AS (
  SELECT table_name, partition_strategy, partition_interval,
         COALESCE(partitions_ahead, 4) AS ahead
  FROM partitioning_config
  WHERE partition_strategy IN ('RANGE','HASH+RANGE')
), parents AS (
  SELECT c.table_name,
         CASE WHEN c.partition_strategy = 'HASH+RANGE' THEN p.parent_name ELSE c.table_name END AS parent_name,
         c.partition_interval,
         c.ahead
  FROM cfg c
  LEFT JOIN LATERAL (
    SELECT relname AS parent_name
    FROM pg_class hc
    JOIN pg_inherits i ON i.inhrelid = hc.oid
    JOIN pg_class b ON b.oid = i.inhparent
    WHERE b.relname = c.table_name
  ) p ON TRUE
), parents_norm AS (
  SELECT table_name, COALESCE(parent_name, table_name) AS parent_name, partition_interval, ahead
  FROM parents
), counts AS (
  SELECT pn.table_name, pn.parent_name, pn.partition_interval, pn.ahead,
         COUNT(*) FILTER (
           WHERE pi.end_at IS NOT NULL
             AND (
               (pn.partition_interval = 'weekly'  AND pi.end_at BETWEEN date_trunc('week',  now()) AND date_trunc('week',  now()) + (pn.ahead || ' weeks')::interval)
            OR (pn.partition_interval = 'monthly' AND pi.end_at BETWEEN date_trunc('month', now()) AND date_trunc('month', now()) + (pn.ahead || ' months')::interval)
             )
         ) AS in_window
  FROM parents_norm pn
  LEFT JOIN public.partition_inventory pi ON pi.table_name = pn.table_name AND pi.parent_name = pn.parent_name
  GROUP BY pn.table_name, pn.parent_name, pn.partition_interval, pn.ahead
)
SELECT * FROM counts ORDER BY table_name, parent_name;

-- 2) Overdue partitions (past retention)
WITH cfg AS (
  SELECT table_name, retention_months, COALESCE(config->>'retention_policy','archive') AS policy
  FROM partitioning_config
  WHERE partition_strategy IN ('RANGE','HASH+RANGE') AND retention_months IS NOT NULL
)
SELECT pi.table_name, pi.parent_name, pi.partition_name, pi.end_at,
       c.retention_months, c.policy
FROM public.partition_inventory pi
JOIN cfg c ON c.table_name = pi.table_name
WHERE pi.end_at IS NOT NULL AND pi.end_at < now() - (c.retention_months || ' months')::interval
ORDER BY pi.table_name, pi.parent_name, pi.end_at;

-- 3) Manual retention command (safe to copy/paste)
\echo
\echo '-- To run retention manually:'
\echo 'SELECT * FROM public.archive_old_partitions();'

