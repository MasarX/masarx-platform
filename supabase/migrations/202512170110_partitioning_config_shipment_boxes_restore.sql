-- Migration: Restore partitioning_config entry for shipment_boxes
-- Purpose:
--   - Cloud drift can mark earlier alignment migrations as applied without the intended row.
--   - Seed/tests expect shipment_boxes to be tracked in partitioning_config (HASH strategy).
-- Notes: HASH entries are not processed by create_next_partitions; this is safe and idempotent.
-- Date: 2025-12-17

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.shipment_boxes') IS NULL THEN
    RAISE NOTICE 'Skipping partitioning_config upsert for shipment_boxes (table missing)';
    RETURN;
  END IF;

  INSERT INTO public.partitioning_config (
    table_name,
    partition_strategy,
    partition_key,
    partition_interval,
    partitions_ahead,
    retention_months,
    config
  )
  VALUES (
    'shipment_boxes',
    'HASH',
    'shipment_id',
    NULL,
    NULL,
    NULL,
    jsonb_build_object('modulus', 1, 'expandable_to', jsonb_build_array(4, 16))
  )
  ON CONFLICT (table_name) DO UPDATE
  SET partition_strategy = EXCLUDED.partition_strategy,
      partition_key = EXCLUDED.partition_key,
      partition_interval = EXCLUDED.partition_interval,
      partitions_ahead = EXCLUDED.partitions_ahead,
      retention_months = EXCLUDED.retention_months,
      config = EXCLUDED.config;
END $$;

COMMIT;

