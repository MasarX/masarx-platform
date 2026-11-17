BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT ok(
  resolve_settings('workflow_defaults', 'global', NULL) ? 'poll_seconds_min',
  'workflow_defaults includes poll_seconds_min'
);

SELECT ok(
  resolve_settings('workflow_defaults', 'global', NULL) ? 'poll_seconds_max',
  'workflow_defaults includes poll_seconds_max'
);

SELECT ok(
  resolve_settings('workflow_defaults', 'global', NULL) ? 'outbound_poll_seconds',
  'workflow_defaults includes outbound_poll_seconds'
);

SELECT ok(
  resolve_settings('workflow_defaults', 'global', NULL) ? 'inline_kick_on_start',
  'workflow_defaults includes inline_kick_on_start'
);

SELECT ok(
  resolve_settings('workflow_defaults', 'global', NULL) ? 'inline_outbound_dispatch',
  'workflow_defaults includes inline_outbound_dispatch'
);

SELECT ok(
  resolve_settings('workflow_defaults', 'global', NULL) ? 'inline_kick_on_outbound_complete',
  'workflow_defaults includes inline_kick_on_outbound_complete'
);

INSERT INTO worker_registry (
  worker_name,
  worker_type,
  description,
  schedule,
  config,
  is_active
)
VALUES (
  'forced_worker',
  'maintenance',
  'pgTAP forced worker',
  'manual',
  '{}'::jsonb,
  TRUE
)
ON CONFLICT (worker_name) DO NOTHING;

INSERT INTO cron_config (worker_name, interval_seconds, batch_size, last_run_at, enabled, notes)
VALUES ('forced_worker', 60, 1, now(), TRUE, 'check_throttle forced run test')
ON CONFLICT (worker_name) DO UPDATE
SET interval_seconds = EXCLUDED.interval_seconds,
    batch_size = EXCLUDED.batch_size,
    last_run_at = EXCLUDED.last_run_at,
    enabled = EXCLUDED.enabled,
    notes = EXCLUDED.notes;

SELECT is(
  (SELECT should_run FROM check_throttle('forced_worker')),
  FALSE,
  'check_throttle blocks when interval not elapsed'
);

SELECT set_config('app.force_worker', 'forced_worker', true);
SELECT is(
  (SELECT should_run FROM check_throttle('forced_worker')),
  TRUE,
  'check_throttle allows forced run'
);
SELECT set_config('app.force_worker', '', true);

SELECT finish();
ROLLBACK;
