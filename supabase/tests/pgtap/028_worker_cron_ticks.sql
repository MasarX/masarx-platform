-- Test file: 028_worker_cron_ticks.sql
-- Purpose: Verify core workers are scheduled via pg_cron (no missed background jobs).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT ok(
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'),
  'pg_cron extension is installed'
);

SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'domain_events_worker_tick'),
  'domain_events_worker_tick scheduled'
);

SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cache_cleanup_worker_tick'),
  'cache_cleanup_worker_tick scheduled'
);

SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'campaign_enrollment_worker_tick'),
  'campaign_enrollment_worker_tick scheduled'
);

SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'campaign_dispatcher_worker_tick'),
  'campaign_dispatcher_worker_tick scheduled'
);

SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'circuit_breaker_recovery_worker_tick'),
  'circuit_breaker_recovery_worker_tick scheduled'
);

SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ops_sweeper_tick'),
  'ops_sweeper_tick scheduled'
);

SELECT finish();

ROLLBACK;
