-- pgTAP: Global webhook_ingest_policy normalized to NULL scope_id and ack schema
BEGIN;
SELECT plan(4);

-- Global policy exists with NULL scope_id
SELECT ok(
  EXISTS (
    SELECT 1
    FROM settings
    WHERE category = 'webhook_ingest_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'Global webhook_ingest_policy present with NULL scope_id'
);

-- Global ack.mode is accepted_async
SELECT is(
  (
    SELECT sv.value->'ack'->>'mode'
    FROM settings s
    JOIN settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'webhook_ingest_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  'accepted_async',
  'Global ack.mode is accepted_async'
);

-- Global policy does not contain legacy response.* key
SELECT is(
  (
    SELECT ((sv.value ? 'response')::int)
    FROM settings s
    JOIN settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'webhook_ingest_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  0,
  'No legacy response.* key in global policy'
);

-- No policies contain legacy response.* keys
SELECT is(
  (
    SELECT count(*)::bigint
    FROM settings_versions
    WHERE category = 'webhook_ingest_policy'
      AND (value ? 'response')
  ),
  0::bigint,
  'No webhook_ingest_policy rows contain legacy response.* keys'
);

SELECT finish();
ROLLBACK;

