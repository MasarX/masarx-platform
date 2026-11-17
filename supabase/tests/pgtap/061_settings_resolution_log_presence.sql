-- Test: settings_resolution_log exists with RLS and helper function wired

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT has_table('public','settings_resolution_log','settings_resolution_log table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='settings_resolution_log'), 'RLS enabled on settings_resolution_log');
SELECT has_function('public','log_settings_resolution', ARRAY['uuid','text','text','uuid','uuid','uuid','integer','jsonb','jsonb','jsonb'], 'log_settings_resolution helper exists');
SELECT has_trigger('public','decision_log','decision_log_settings_provenance','decision_log provenance trigger exists');
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.partitioning_config pc
    WHERE pc.table_name = 'settings_resolution_log'
      AND pc.partition_strategy = 'HASH+RANGE'
      AND pc.partition_interval = 'monthly'
  ),
  'settings_resolution_log registered in partitioning_config'
);
SELECT ok(
  to_regclass(
    'public.' || generate_partition_name_range_monthly('settings_resolution_log', date_trunc('month', now())) || '_p0'
  ) IS NOT NULL,
  'settings_resolution_log current-month RANGE partition exists (p0)'
);

SELECT finish();

ROLLBACK;

