-- Test file: 029_ops_sweeper_policy.sql
-- Purpose: Verify ops_sweeper_policy is present and includes core cron guard tasks.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

-- 1) Policy exists
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ops_sweeper_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'ops_sweeper_policy exists (global)'
);

-- 2) ensure_cron_jobs task present
WITH policy AS (
  SELECT s.cached_value AS v
  FROM public.settings s
  WHERE s.category = 'ops_sweeper_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  ORDER BY s.last_updated DESC
  LIMIT 1
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM policy
    WHERE jsonb_typeof(v->'tasks') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v->'tasks') t
        WHERE COALESCE(t->>'task_key', '') = 'ensure_cron_jobs'
      )
  ),
  'ops_sweeper_policy includes ensure_cron_jobs task'
);

-- 3) Geocoding reclaim job enforced
WITH policy AS (
  SELECT s.cached_value AS v
  FROM public.settings s
  WHERE s.category = 'ops_sweeper_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  ORDER BY s.last_updated DESC
  LIMIT 1
),
task AS (
  SELECT t
  FROM policy, jsonb_array_elements(policy.v->'tasks') t
  WHERE COALESCE(t->>'task_key', '') = 'ensure_cron_jobs'
  LIMIT 1
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM task
    WHERE jsonb_typeof(task.t#>'{arguments,jobs}') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(task.t#>'{arguments,jobs}') j
        WHERE COALESCE(j->>'jobname', '') = 'geocoding_reclaim_in_progress'
      )
  ),
  'ensure_cron_jobs enforces geocoding_reclaim_in_progress'
);

-- 4) Alert aggregation tick enforced
WITH policy AS (
  SELECT s.cached_value AS v
  FROM public.settings s
  WHERE s.category = 'ops_sweeper_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  ORDER BY s.last_updated DESC
  LIMIT 1
),
task AS (
  SELECT t
  FROM policy, jsonb_array_elements(policy.v->'tasks') t
  WHERE COALESCE(t->>'task_key', '') = 'ensure_cron_jobs'
  LIMIT 1
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM task
    WHERE jsonb_typeof(task.t#>'{arguments,jobs}') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(task.t#>'{arguments,jobs}') j
        WHERE COALESCE(j->>'jobname', '') = 'alert_aggregation_tick'
      )
  ),
  'ensure_cron_jobs enforces alert_aggregation_tick'
);

-- 5) Label renderer cron guard task present
WITH policy AS (
  SELECT s.cached_value AS v
  FROM public.settings s
  WHERE s.category = 'ops_sweeper_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  ORDER BY s.last_updated DESC
  LIMIT 1
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM policy, jsonb_array_elements(policy.v->'tasks') t
    WHERE COALESCE(t->>'handler_key', '') = 'ops_sweeper_label_renderer_cron_guard'
  ),
  'ops_sweeper_policy includes ops_sweeper_label_renderer_cron_guard task'
);

-- 6) Handler is registered for safe dynamic dispatch
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.operation_handlers oh
    WHERE oh.handler_key = 'ops_sweeper_label_renderer_cron_guard'
      AND oh.handler_schema = 'public'
      AND oh.handler_name = 'ops_sweeper_label_renderer_cron_guard'
      AND oh.handler_signature = '(jsonb)'
      AND oh.is_active = TRUE
  ),
  'operation_handlers has ops_sweeper_label_renderer_cron_guard'
);

SELECT finish();

ROLLBACK;

