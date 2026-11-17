-- Migration: Register settings_resolution_log with partitioning_config + bootstrap
-- Purpose: Ensure settings_resolution_log RANGE partitions are auto-created ahead of inserts
--          (via cron and/or on-demand calls to public.create_next_partitions()).
-- Date: 2025-12-12 17:15 UTC

BEGIN;

-- Register HASH+RANGE management so create_next_partitions() covers this table (no hardcoding).
INSERT INTO public.partitioning_config (
  table_name,
  partition_strategy,
  partition_key,
  partition_interval,
  partitions_ahead,
  retention_months,
  config
) VALUES (
  'settings_resolution_log',
  'HASH+RANGE',
  'organization_id|resolved_at',
  'monthly',
  NULL,
  12,
  '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE SET
  partition_strategy = EXCLUDED.partition_strategy,
  partition_key = EXCLUDED.partition_key,
  partition_interval = EXCLUDED.partition_interval,
  partitions_ahead = EXCLUDED.partitions_ahead,
  retention_months = EXCLUDED.retention_months,
  config = EXCLUDED.config,
  updated_at = now();

-- Bootstrap: create near-future partitions immediately (idempotent).
SELECT * FROM public.create_next_partitions();

COMMIT;

