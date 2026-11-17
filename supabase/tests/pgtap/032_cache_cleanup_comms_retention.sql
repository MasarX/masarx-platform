-- Test Suite: Cache cleanup worker comms retention

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  public.resolve_settings('maintenance_cleanup_policy', 'global', NULL) IS NOT NULL,
  'maintenance_cleanup_policy global setting is present'
);

-- Seed minimal org + client for comms_reply_sessions row.
INSERT INTO public.organizations (id, name, slug)
VALUES ('dddddddd-0000-0000-0000-000000000032', 'Cleanup Org', 'cleanup-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'dddddddd-0000-0000-0000-000000000033',
  'dddddddd-0000-0000-0000-000000000032',
  'Cleanup Client',
  'cleanup-client',
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- Insert an expired comms_reply_session older than the default retention window (7 days).
INSERT INTO public.comms_reply_sessions (
  id,
  organization_id,
  client_id,
  webhook_source_id,
  recipient_id,
  recipient_phone_normalized,
  session_type,
  requested_intent,
  state,
  expires_at,
  created_at,
  updated_at
)
VALUES (
  'dddddddd-0000-0000-0000-000000000034',
  'dddddddd-0000-0000-0000-000000000032',
  'dddddddd-0000-0000-0000-000000000033',
  NULL,
  NULL,
  '+12025550123',
  'shipment_disambiguation',
  'status',
  '{}'::jsonb,
  now() - interval '10 days',
  now() - interval '10 days',
  now() - interval '10 days'
)
ON CONFLICT (id) DO NOTHING;

-- Insert an old comms_reply_rate_limits row older than the default retention window (30 days).
WITH ws AS (
  SELECT id AS webhook_source_id
  FROM public.webhook_sources
  ORDER BY created_at DESC
  LIMIT 1
)
INSERT INTO public.comms_reply_rate_limits (
  organization_id,
  webhook_source_id,
  recipient_phone_normalized,
  window_started_at,
  reply_count,
  updated_at
)
SELECT
  'dddddddd-0000-0000-0000-000000000032',
  ws.webhook_source_id,
  '+12025550123',
  now() - interval '40 days',
  5,
  now() - interval '40 days'
FROM ws
ON CONFLICT (organization_id, webhook_source_id, recipient_phone_normalized)
DO UPDATE SET
  window_started_at = EXCLUDED.window_started_at,
  reply_count = EXCLUDED.reply_count,
  updated_at = EXCLUDED.updated_at;

-- Reset throttle so worker can run immediately.
UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'cache_cleanup_worker';

SELECT is(
  (SELECT (public.run_cache_cleanup_worker())->>'status'),
  'completed',
  'run_cache_cleanup_worker completes'
);

SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.comms_reply_sessions WHERE id = 'dddddddd-0000-0000-0000-000000000034'),
  'run_cache_cleanup_worker prunes expired comms_reply_sessions rows'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.comms_reply_rate_limits
    WHERE organization_id = 'dddddddd-0000-0000-0000-000000000032'
      AND recipient_phone_normalized = '+12025550123'
  ),
  'run_cache_cleanup_worker prunes stale comms_reply_rate_limits rows'
);

SELECT ok(
  (SELECT (public.run_cache_cleanup_worker())->>'status') IN ('completed', 'throttled'),
  'cache cleanup worker remains callable after pruning (idempotent)'
);

SELECT finish();

ROLLBACK;

