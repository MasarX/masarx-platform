BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT is(ARRAY(
  SELECT DISTINCT acl.grantee
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(p.proacl) AS acl
  WHERE p.oid = 'api.try_start_outbound_wake_v1()'::regprocedure
    AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee <> p.proowner
), ARRAY['edge_api_caller_role'::regrole::oid],
  'direct wake admission grants besides the owner are limited to edge_api_caller_role');

SELECT is(has_function_privilege(role_name, 'api.try_start_outbound_wake_v1()', 'EXECUTE'),
          expected, role_name || ' effective wake admission privilege')
FROM (VALUES ('anon', FALSE), ('authenticated', FALSE),
             ('service_role', TRUE), ('edge_api_caller_role', TRUE)) AS roles(role_name, expected);

SELECT ok(pg_has_role('service_role', 'edge_api_caller_role', 'USAGE')
          AND NOT pg_has_role('service_role', p.proowner, 'USAGE'),
          'service_role inherits wake admission through edge_api_caller_role')
FROM pg_proc p
WHERE p.oid = 'api.try_start_outbound_wake_v1()'::regprocedure;

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
