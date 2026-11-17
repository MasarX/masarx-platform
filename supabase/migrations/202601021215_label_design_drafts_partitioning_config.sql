-- Migration: Register label_design_drafts in partitioning_config (SSOT)
-- Purpose: Ensure partitioning_config covers all top-level partitioned tables.
-- Notes: Idempotent; HASH partitioned by organization_id.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.label_design_drafts') IS NULL THEN
    RAISE NOTICE 'Skipping label_design_drafts partitioning_config (table missing)';
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
    'label_design_drafts',
    'HASH',
    'organization_id',
    NULL,
    NULL,
    NULL,
    '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb
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
