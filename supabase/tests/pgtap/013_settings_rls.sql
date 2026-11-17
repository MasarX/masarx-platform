-- Test Suite: RLS on settings tables

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='settings'),
  'RLS enabled on settings'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='settings_versions'),
  'RLS enabled on settings_versions'
);

SELECT finish();

ROLLBACK;

