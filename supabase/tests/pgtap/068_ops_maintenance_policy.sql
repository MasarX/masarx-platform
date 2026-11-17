-- Test file: 068_ops_maintenance_policy.sql
-- Purpose: Verify ops_maintenance_policy, handlers, and scheduling are present.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry sr
    WHERE sr.category = 'ops_maintenance_policy'
      AND sr.version = 1
      AND sr.is_active = TRUE
  ),
  'schema_registry has ops_maintenance_policy v1'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ops_maintenance_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'ops_maintenance_policy exists (global)'
);

WITH policy AS (
  SELECT s.cached_value AS v
  FROM public.settings s
  WHERE s.category = 'ops_maintenance_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  ORDER BY s.last_updated DESC
  LIMIT 1
),
task_keys AS (
  SELECT COALESCE(t->>'task_key', '') AS task_key
  FROM policy, jsonb_array_elements(policy.v->'tasks') t
)
SELECT is(
  (SELECT count(*) FROM task_keys WHERE task_key IN (
    'retry_webhook_inbox',
    'retry_domain_events',
    'quarantine_outbound_calls',
    'quarantine_label_jobs',
    'quarantine_stale_workflow_runs'
  )),
  5::bigint,
  'ops_maintenance_policy includes core tasks'
);

SELECT is(
  (SELECT count(*) FROM public.operation_handlers oh
    WHERE oh.handler_key IN (
      'ops_maintenance_retry_webhook_inbox',
      'ops_maintenance_retry_domain_events',
      'ops_maintenance_quarantine_outbound_calls',
      'ops_maintenance_quarantine_label_jobs',
      'ops_maintenance_quarantine_stale_workflow_runs'
    )
      AND oh.handler_schema = 'public'
      AND oh.handler_signature = '(jsonb)'
      AND oh.is_active = TRUE
  ),
  5::bigint,
  'operation_handlers has ops_maintenance handlers'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.worker_registry wr
    WHERE wr.worker_name = 'ops_maintenance_worker'
      AND wr.is_active = TRUE
  ),
  'worker_registry has ops_maintenance_worker'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.cron_config cc
    WHERE cc.worker_name = 'ops_maintenance_worker'
      AND cc.enabled = TRUE
  ),
  'cron_config has ops_maintenance_worker'
);

SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ops_maintenance_tick'),
  'ops_maintenance_tick scheduled'
);

SELECT finish();

ROLLBACK;
