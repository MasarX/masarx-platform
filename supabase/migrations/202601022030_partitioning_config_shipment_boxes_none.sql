-- Migration: Align partitioning_config for shipment_boxes (SSOT)
-- Purpose:
-- - shipment_boxes is intentionally non-partitioned (child of shipments) per domain schema.
-- - partitioning_config must reflect reality to avoid misleading ops/tests.
-- Notes:
-- - DML-only, safe + idempotent.
-- - If shipment_boxes becomes partitioned in a future migration, that migration should set the strategy explicitly.
-- Date: 2026-01-02

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.partitioning_config') IS NULL THEN
    RAISE NOTICE 'Skipping shipment_boxes partitioning_config alignment (partitioning_config missing)';
    RETURN;
  END IF;

  IF to_regclass('public.shipment_boxes') IS NULL THEN
    RAISE NOTICE 'Skipping shipment_boxes partitioning_config alignment (shipment_boxes missing)';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_partitioned_table pt
    JOIN pg_class c ON c.oid = pt.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'shipment_boxes'
  ) THEN
    RAISE NOTICE 'shipment_boxes is partitioned; leaving partitioning_config unchanged';
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
    'NONE',
    'shipment_id',
    NULL,
    NULL,
    NULL,
    NULL
  )
  ON CONFLICT (table_name) DO UPDATE
  SET partition_strategy = EXCLUDED.partition_strategy,
      partition_key = EXCLUDED.partition_key,
      partition_interval = EXCLUDED.partition_interval,
      partitions_ahead = EXCLUDED.partitions_ahead,
      retention_months = EXCLUDED.retention_months,
      config = EXCLUDED.config,
      updated_at = now();
END $$;

COMMIT;

