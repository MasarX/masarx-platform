-- Migration: Logging retention policy alignment
-- Purpose: enforce explicit retention_policy on log/audit tables to drive archive/TTL behavior.

BEGIN;

UPDATE partitioning_config
SET retention_months = COALESCE(retention_months, 6),
    config = jsonb_set(COALESCE(config, '{}'::jsonb), '{retention_policy}', '"archive"', true)
WHERE table_name IN (
  'webhook_log',
  'api_call_log',
  'settings_resolution_log',
  'audit_table_changes'
);

UPDATE partitioning_config
SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{retention_policy}', '"archive"', true)
WHERE table_name = 'decision_log';

COMMIT;
