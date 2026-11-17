-- Test Suite: Webhook system tables RLS

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- Verify RLS enabled on webhook_inbox
SELECT has_table('public', 'webhook_inbox', 'webhook_inbox exists');
SELECT col_is_pk('public', 'webhook_inbox', ARRAY['id']) IS NOT NULL AS ok \gset

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'webhook_inbox'),
  'RLS enabled on webhook_inbox'
);

-- Verify projection view for HTTP responses exists
SELECT has_view('public', 'webhook_response_events', 'webhook_response_events projection exists');

SELECT finish();

ROLLBACK;
