-- Migration: Trim runaway future RANGE partitions (config-driven)
-- Purpose:
-- - Remove excessive future RANGE leaf partitions beyond the configured window_end
--   (date_trunc(now) + partitions_ahead * interval) for RANGE and HASH+RANGE tables.
-- - This repairs legacy environments where older create_next_partitions behavior created
--   partitions far into the future (e.g., 2028+), increasing planning overhead and lock memory.
-- Safety:
-- - Drops ONLY partitions whose start_at >= window_end
-- - Drops ONLY partitions that are empty (SELECT ... LIMIT 1)
-- - Acquires the same advisory lock key as create_next_partitions() to avoid racing DDL
-- Notes:
-- - Dynamic: thresholds are derived from partitioning_config and resolve_settings(partition_defaults)
-- - Idempotent: re-running after cleanup is a no-op

BEGIN;

DO $$
DECLARE
  rec RECORD;
  v_has_row BOOLEAN;
  v_dropped INT := 0;
  v_non_empty INT := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('public'), hashtext('create_next_partitions'));

  FOR rec IN
    WITH conf AS (
      SELECT
        pc.table_name,
        pc.partition_interval,
        COALESCE(
          pc.partitions_ahead,
          COALESCE((resolve_settings('partition_defaults','global', NULL)->>'partitions_ahead')::int, 4)
        ) AS partitions_ahead
      FROM public.partitioning_config pc
      WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
    ),
    cutoff AS (
      SELECT
        table_name,
        date_trunc(CASE WHEN partition_interval = 'weekly' THEN 'week' ELSE 'month' END, now()) AS window_start,
        CASE WHEN partition_interval = 'weekly' THEN INTERVAL '1 week' ELSE INTERVAL '1 month' END AS step,
        partitions_ahead
      FROM conf
    ),
    thresholds AS (
      SELECT
        table_name,
        window_start + (partitions_ahead * step) AS window_end
      FROM cutoff
    )
    SELECT
      pi.table_name,
      pi.partition_name,
      pi.start_at,
      pi.end_at
    FROM public.partition_inventory pi
    JOIN thresholds t ON t.table_name = pi.table_name
    WHERE pi.start_at IS NOT NULL
      AND pi.start_at >= t.window_end
    ORDER BY pi.table_name, pi.start_at DESC
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)', rec.partition_name)
      INTO v_has_row;

    IF v_has_row THEN
      v_non_empty := v_non_empty + 1;
      RAISE NOTICE 'skip non-empty future partition %.% (% -> %)', rec.table_name, rec.partition_name, rec.start_at, rec.end_at;
      CONTINUE;
    END IF;

    RAISE NOTICE 'dropping future partition %.% (% -> %)', rec.table_name, rec.partition_name, rec.start_at, rec.end_at;
    EXECUTE format('DROP TABLE IF EXISTS public.%I', rec.partition_name);
    v_dropped := v_dropped + 1;
  END LOOP;

  RAISE NOTICE 'trim_runaway_future_partitions: dropped=% non_empty_skipped=%', v_dropped, v_non_empty;

  IF v_non_empty > 0 THEN
    RAISE EXCEPTION 'Refusing to complete migration: found % non-empty future partitions beyond window_end', v_non_empty;
  END IF;
END $$;

COMMIT;

