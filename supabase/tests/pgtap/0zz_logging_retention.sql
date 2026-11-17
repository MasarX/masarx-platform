-- Test: Logging retention policies are configured for archive/TTL

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- Retention months present and > 0
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM partitioning_config
     WHERE table_name IN ('decision_log','webhook_log','api_call_log','settings_resolution_log','audit_table_changes')
       AND COALESCE(retention_months, 0) <= 0
  ),
  'Log tables have retention_months configured'
);

-- Retention policy set to archive for log tables
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM partitioning_config
     WHERE table_name IN ('decision_log','webhook_log','api_call_log','settings_resolution_log','audit_table_changes')
       AND (config ->> 'retention_policy') IS DISTINCT FROM 'archive'
  ),
  'Log tables have retention_policy=archive'
);

SELECT finish();

ROLLBACK;
