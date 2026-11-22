-- The sweeper reads global ops_sweeper_policy (202512280040_ops_sweeper_worker.sql:269).
-- Settings UI writes resolve scope before upsert (202605182230_console_v2_settings_auto_apply_v1.sql:56).
-- Global UI scope requires a platform user (202601090846_settings_scope_tenant_default.sql:34).
-- Direct settings writes are restricted to trusted roles by the table policies and upsert ACL
-- (202511130006_settings_rls.sql:7, 20260909122000_settings_upsert_service_acl_v1.sql:3).

BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(67);

CREATE TEMP TABLE worker_tick_acl (
  signature text PRIMARY KEY,
  job_name text NOT NULL,
  worker_name text
);

INSERT INTO worker_tick_acl VALUES
  ('public.run_api_caller_batch(integer)', 'api_caller_batch_tick', 'edge_api_caller_worker'),
  ('public.run_ops_maintenance_worker()', 'ops_maintenance_tick', 'ops_maintenance_worker'),
  ('public.ensure_audit_triggers()', 'audit_ensure_triggers', NULL),
  ('public.run_campaign_enrollment_worker()', 'campaign_enrollment_worker_tick', 'campaign_enrollment_worker'),
  ('public.run_campaign_dispatcher_worker()', 'campaign_dispatcher_worker_tick', 'campaign_dispatcher_worker'),
  ('public.run_circuit_breaker_recovery_worker()', 'circuit_breaker_recovery_worker_tick', 'circuit_breaker_recovery_worker'),
  ('public.run_cache_cleanup_worker()', 'cache_cleanup_worker_tick', 'cache_cleanup_worker'),
  ('public.run_domain_events_worker()', 'domain_events_worker_tick', 'domain_events_worker'),
  ('public.run_webhook_processor_worker()', 'webhook_processor_worker_tick', 'webhook_processor_worker'),
  ('public.run_ops_cron_health_worker()', 'ops_cron_health_tick', 'ops_cron_health_worker'),
  ('public.run_ops_queue_health_worker()', 'ops_queue_health_tick', 'ops_queue_health_worker'),
  ('public.run_alert_aggregation_worker()', 'alert_aggregation_tick', 'alert_aggregation_worker'),
  ('public.run_outbound_worker()', 'outbound_worker_tick', 'outbound_worker');

SELECT ok(NOT EXISTS (
  SELECT 1
  FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS acl
  WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
), 'PUBLIC lacks EXECUTE on ' || tick.signature)
FROM worker_tick_acl AS tick
JOIN pg_proc AS proc ON proc.oid = tick.signature::regprocedure;

SELECT is(has_function_privilege(role_name, signature, 'EXECUTE'),
          role_name = 'authenticated' AND signature = 'public.run_outbound_worker()',
          format('%s EXECUTE on %s', role_name, signature))
FROM worker_tick_acl
CROSS JOIN (VALUES ('anon'), ('authenticated')) AS roles(role_name);

SELECT ok(has_function_privilege('service_role', 'public.run_outbound_worker()', 'EXECUTE'),
          'service_role retains outbound tick access');

SET LOCAL ROLE postgres;

SELECT ok(EXISTS (
  SELECT 1 FROM cron.job AS job
  WHERE job.jobname = tick.job_name
    AND job.command = CASE WHEN tick.worker_name IS NULL THEN 'SELECT * FROM ' || tick.signature || ';'
                           ELSE format('SELECT public.run_%s();', tick.worker_name)
                      END
    AND job.username = current_user
    AND has_function_privilege(job.username, tick.signature, 'EXECUTE')
    AND (tick.worker_name IS DISTINCT FROM 'edge_api_caller_worker'
         OR has_function_privilege(job.username, 'public.run_edge_api_caller_worker()', 'EXECUTE'))
), tick.job_name || ' retains its command and scheduler privileges')
FROM worker_tick_acl AS tick;

-- Exercise scheduler entry points without processing work or dispatching requests.
UPDATE public.cron_config
SET enabled = false
WHERE worker_name IN (SELECT worker_name FROM worker_tick_acl);

SELECT results_eq(format('SELECT public.run_%s()->>''reason''', worker_name),
                  $$VALUES ('Worker disabled in cron_config'::text)$$,
                  job_name || ' reaches its cadence check as postgres')
FROM worker_tick_acl
WHERE worker_name IS NOT NULL;

SET LOCAL ROLE authenticated;
SELECT is(public.run_outbound_worker()->>'reason', 'Worker disabled in cron_config',
          'authenticated can enter the outbound tick for inline workflow dispatch');

SET LOCAL ROLE service_role;
SELECT is(public.run_outbound_worker()->>'reason', 'Worker disabled in cron_config',
          'service_role can enter the outbound tick');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
