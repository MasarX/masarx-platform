-- Test Suite: Global webhook_ingest_policy async ack defaults

BEGIN;

SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT is(
  (
    SELECT cached_value->'ack'->>'mode'
    FROM settings
    WHERE category = 'webhook_ingest_policy'
      AND scope_type = 'global'
    ORDER BY last_updated DESC
    LIMIT 1
  ),
  'accepted_async',
  'Global webhook_ingest_policy ack.mode is accepted_async'
);

SELECT cmp_ok(
  (
    SELECT (cached_value->'ack'->>'status_code')::INT
    FROM settings
    WHERE category = 'webhook_ingest_policy'
      AND scope_type = 'global'
    ORDER BY last_updated DESC
    LIMIT 1
  ),
  '=',
  202,
  'Global webhook_ingest_policy ack.status_code is 202'
);

SELECT * FROM finish();

ROLLBACK;

