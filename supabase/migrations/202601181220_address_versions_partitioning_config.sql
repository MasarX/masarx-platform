-- Plan: PLAN-202601-address-versioned-addresses-pitch-progress / Step: S04
-- Purpose: Register public.address_versions in partitioning_config (SSOT) to satisfy partition integrity checks.

BEGIN;

SET search_path TO public, extensions, pg_temp;

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
  'address_versions',
  'HASH',
  'client_id',
  NULL,
  NULL,
  NULL,
  '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET
  partition_strategy = EXCLUDED.partition_strategy,
  partition_key = EXCLUDED.partition_key,
  partition_interval = EXCLUDED.partition_interval,
  partitions_ahead = EXCLUDED.partitions_ahead,
  retention_months = EXCLUDED.retention_months,
  config = EXCLUDED.config,
  updated_at = now();

COMMIT;

