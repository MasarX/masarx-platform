-- Verify metrics_webhook_events structure and policies
-- Plan: PLAN-202512-rls-metrics-webhook-events-grants / Step: S04
SELECT plan(10);

SELECT has_table('public', 'metrics_webhook_events', 'metrics_webhook_events table exists');
SELECT col_type_is('public', 'metrics_webhook_events', 'metric', 'text', 'metric is text');
SELECT col_type_is('public', 'metrics_webhook_events', 'labels', 'jsonb', 'labels is jsonb');
SELECT col_type_is('public', 'metrics_webhook_events', 'data', 'jsonb', 'data is jsonb');
SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.metrics_webhook_events'::regclass),
  true,
  'RLS enabled on metrics_webhook_events'
);

-- Internal SSOT only: must not be accessible to anon/authenticated directly.
SELECT ok(
  NOT (
    has_table_privilege('anon', 'public.metrics_webhook_events', 'select')
    OR has_table_privilege('anon', 'public.metrics_webhook_events', 'insert')
    OR has_table_privilege('anon', 'public.metrics_webhook_events', 'update')
    OR has_table_privilege('anon', 'public.metrics_webhook_events', 'delete')
  ),
  'anon has no DML privileges on metrics_webhook_events'
);

SELECT ok(
  NOT (
    has_table_privilege('authenticated', 'public.metrics_webhook_events', 'select')
    OR has_table_privilege('authenticated', 'public.metrics_webhook_events', 'insert')
    OR has_table_privilege('authenticated', 'public.metrics_webhook_events', 'update')
    OR has_table_privilege('authenticated', 'public.metrics_webhook_events', 'delete')
  ),
  'authenticated has no DML privileges on metrics_webhook_events'
);

SELECT ok(
  has_table_privilege('service_role', 'public.metrics_webhook_events', 'select'),
  'service_role can read metrics_webhook_events'
);

SELECT ok(
  has_table_privilege('service_role', 'public.metrics_webhook_events', 'insert'),
  'service_role can write metrics_webhook_events'
);

SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role')
  OR (
    has_table_privilege('edge_label_renderer_role', 'public.metrics_webhook_events', 'select')
    AND has_table_privilege('edge_label_renderer_role', 'public.metrics_webhook_events', 'insert')
  ),
  'edge_label_renderer_role can read/write metrics_webhook_events (when present)'
);

SELECT * FROM finish();
