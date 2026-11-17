-- Migration: Align partitioning_config with partition policy (SSOT)
-- Purpose:
-- - Ensure partitioning_config covers all top-level partitioned tables
-- - Fix partition_key drift (e.g., settings_versions uses scope_hash)
-- Notes: Configuration-only (DML) migration; safe and idempotent.

BEGIN;

-- settings_versions is HASH partitioned by scope_hash (not scope_id).
UPDATE public.partitioning_config
SET partition_key = 'scope_hash'
WHERE table_name = 'settings_versions';

-- Label-generation tables are HASH partitioned by organization_id; register them for monitoring/operations.
INSERT INTO public.partitioning_config (
  table_name,
  partition_strategy,
  partition_key,
  partition_interval,
  partitions_ahead,
  retention_months,
  config
) VALUES
  ('label_design_tokens',       'HASH', 'organization_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
  ('label_jobs',                'HASH', 'organization_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
  ('label_sections',            'HASH', 'organization_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
  ('label_template_specs',      'HASH', 'organization_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
  ('label_template_validation', 'HASH', 'organization_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb)
ON CONFLICT (table_name) DO UPDATE
SET partition_strategy = EXCLUDED.partition_strategy,
    partition_key = EXCLUDED.partition_key,
    partition_interval = EXCLUDED.partition_interval,
    partitions_ahead = EXCLUDED.partitions_ahead,
    retention_months = EXCLUDED.retention_months,
    config = EXCLUDED.config;

COMMIT;
