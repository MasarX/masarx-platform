-- Test Suite: webhook_nonce_dedupe RLS and privileges

BEGIN;

SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  to_regclass('public.webhook_nonce_dedupe') IS NOT NULL,
  'webhook_nonce_dedupe table exists'
);

SELECT ok(
  COALESCE((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'webhook_nonce_dedupe'), false),
  'webhook_nonce_dedupe has RLS enabled'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.webhook_nonce_dedupe', 'SELECT'),
  'authenticated cannot SELECT webhook_nonce_dedupe'
);

SELECT ok(
  has_table_privilege('service_role', 'public.webhook_nonce_dedupe', 'SELECT'),
  'service_role can SELECT webhook_nonce_dedupe'
);

SELECT * FROM finish();

ROLLBACK;

