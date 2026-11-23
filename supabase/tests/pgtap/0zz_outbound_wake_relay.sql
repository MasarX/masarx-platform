BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT is(has_function_privilege(role_name, 'api.try_start_outbound_wake_v1()', 'EXECUTE'),
          role_name = 'edge_api_caller_role', role_name || ' wake admission privilege')
FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('edge_api_caller_role')) AS roles(role_name);

SELECT ok(EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'outbound_wake_sweep' AND active AND schedule = '*/3 * * * *'
), 'sweep runs every three minutes even without traffic');

SELECT is(interval_seconds, 60, 'one wake slot per rolling minute')
FROM public.cron_config WHERE worker_name = 'outbound_wake_relay';

UPDATE public.cron_config SET last_run_at = clock_timestamp() - interval '55 seconds'
WHERE worker_name = 'outbound_wake_relay';
SELECT is(api.try_start_outbound_wake_v1(), FALSE, 'coalesces a wake inside the interval');

UPDATE public.cron_config SET last_run_at = now() - interval '61 seconds'
WHERE worker_name = 'outbound_wake_relay';
DO $$ BEGIN PERFORM api.try_start_outbound_wake_v1(); END $$;
SELECT ok(last_run_at >= now(), 'reserves a new slot after the interval, including when idle')
FROM public.cron_config WHERE worker_name = 'outbound_wake_relay';
SELECT is(api.try_start_outbound_wake_v1(), FALSE, 'the new slot is visible to the next wake');

UPDATE public.cron_config SET last_run_at = NULL, enabled = FALSE WHERE worker_name = 'outbound_wake_relay';
SELECT is(api.try_start_outbound_wake_v1(), FALSE, 'disabled relay never starts a run');

SELECT * FROM finish();
ROLLBACK;
