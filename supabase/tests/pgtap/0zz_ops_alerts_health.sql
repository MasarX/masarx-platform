-- Test: ops_alerts and provider_health_logs partitioning + RLS + retention

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='ops_alerts'),
  'ops_alerts table exists'
);

SELECT ok(
  EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='provider_health_logs'),
  'provider_health_logs table exists'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename IN ('ops_alerts','provider_health_logs') AND rowsecurity = false
  ),
  'ops_alerts and provider_health_logs have RLS enabled'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM partitioning_config
     WHERE table_name IN ('ops_alerts','provider_health_logs')
       AND partition_strategy <> 'HASH+RANGE'
  ),
  'ops_alerts/provider_health_logs use HASH+RANGE partitioning'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM partitioning_config
     WHERE table_name IN ('ops_alerts','provider_health_logs')
       AND COALESCE(retention_months,0) <= 0
  ),
  'ops_alerts/provider_health_logs have retention configured'
);

SELECT finish();

ROLLBACK;
