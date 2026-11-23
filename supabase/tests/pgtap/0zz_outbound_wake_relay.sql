BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT is(has_function_privilege(role_name, 'api.try_start_outbound_wake_v1()', 'EXECUTE'),
          role_name = 'edge_api_caller_role', role_name || ' wake admission privilege')
FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('edge_api_caller_role')) AS roles(role_name);

SELECT ok(EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'outbound_wake_sweep' AND active AND schedule = '* * * * *'
), 'sweep runs every minute even without traffic');

SELECT is(interval_seconds, 55, '55-second wake gap leaves room for schedule jitter')
FROM public.cron_config WHERE worker_name = 'outbound_wake_relay';

UPDATE public.cron_config SET last_run_at = clock_timestamp() - interval '50 seconds'
WHERE worker_name = 'outbound_wake_relay';
SELECT is(api.try_start_outbound_wake_v1(), FALSE, 'coalesces a wake inside the interval');

UPDATE public.cron_config SET last_run_at = clock_timestamp() - interval '56 seconds'
WHERE worker_name = 'outbound_wake_relay';
DO $$ BEGIN PERFORM api.try_start_outbound_wake_v1(); END $$;
SELECT ok(last_run_at >= now(), 'reserves a new slot after the interval, including when idle')
FROM public.cron_config WHERE worker_name = 'outbound_wake_relay';
SELECT is(api.try_start_outbound_wake_v1(), FALSE, 'the new slot is visible to the next wake');

UPDATE public.cron_config SET last_run_at = NULL, enabled = FALSE WHERE worker_name = 'outbound_wake_relay';
SELECT is(api.try_start_outbound_wake_v1(), FALSE, 'disabled relay never starts a run');

SELECT * FROM finish();
ROLLBACK;
