-- Migration: Reset log partition lookahead to global defaults
-- Purpose: Reduce future partition clutter by deferring to partition_defaults.
-- Date: 2025-12-28

BEGIN;

UPDATE partitioning_config
SET partitions_ahead = NULL,
    updated_at = now()
WHERE table_name IN (
  'webhook_log',
  'api_call_log',
  'decision_log',
  'settings_resolution_log',
  'audit_table_changes',
  'ops_alerts',
  'provider_health_logs',
  'webhook_events'
)
  AND partition_strategy IN ('RANGE', 'HASH+RANGE');

COMMIT;
