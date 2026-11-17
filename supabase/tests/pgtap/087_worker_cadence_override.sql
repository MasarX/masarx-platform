-- Test: worker cadence overrides via settings
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'worker_cadence'
      AND version = 1
      AND is_active = TRUE
  ),
  'schema_registry includes worker_cadence v1'
);

UPDATE public.cron_config
   SET interval_seconds = 999,
       batch_size = 1,
       last_run_at = now() - interval '1 day'
 WHERE worker_name = 'workflow_engine_worker';

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'workers', jsonb_build_object(
      'workflow_engine_worker', jsonb_build_object(
        'interval_seconds', 7,
        'batch_size', 13
      )
    )
  ) AS value
),
updated_versions AS (
  UPDATE public.settings_versions sv
     SET value = payload.value,
         version = 999,
         schema_version = 1,
         created_at = now()
    FROM payload
   WHERE sv.category = 'worker_cadence'
     AND sv.scope_type = 'global'
     AND sv.scope_id IS NULL
  RETURNING sv.id, payload.value AS value
),
inserted_versions AS (
  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version,
    change_reason, approved_at, effective_from, created_at
  )
  SELECT
    'worker_cadence',
    'global',
    NULL::uuid,
    999,
    payload.value,
    1,
    'pgtap override worker_cadence',
    now(),
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (SELECT 1 FROM updated_versions)
  RETURNING id, value
),
version_row AS (
  SELECT id, value FROM updated_versions
  UNION ALL
  SELECT id, value FROM inserted_versions
  LIMIT 1
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'worker_cadence', 'global', NULL::uuid, version_row.id, version_row.value, now()
FROM version_row
ON CONFLICT (category, scope_type, scope_hash)
DO UPDATE SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = EXCLUDED.last_updated;

SELECT is(
  (SELECT interval_seconds_config FROM public.check_throttle('workflow_engine_worker')),
  7,
  'check_throttle uses worker_cadence interval override'
);

SELECT is(
  (SELECT batch_size FROM public.check_throttle('workflow_engine_worker')),
  13,
  'check_throttle uses worker_cadence batch_size override'
);

SELECT finish();
ROLLBACK;
