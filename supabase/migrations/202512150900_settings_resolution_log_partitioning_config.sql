-- Migration: Register settings_resolution_log for automatic RANGE partition maintenance
-- Purpose:
--   Prevent webhook intake failures caused by missing monthly partitions for
--   settings_resolution_log (HASH+RANGE table written by decision_log trigger).
-- Date: 2025-12-15 09:00 UTC

BEGIN;

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
  3,
  12,
  '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET partition_strategy = EXCLUDED.partition_strategy,
    partition_key = EXCLUDED.partition_key,
    partition_interval = EXCLUDED.partition_interval,
    partitions_ahead = EXCLUDED.partitions_ahead,
    retention_months = EXCLUDED.retention_months,
    config = EXCLUDED.config;

-- Bootstrap partitions now (idempotent). Ensures the current month partition exists immediately.
SELECT * FROM public.create_next_partitions();

COMMIT;

