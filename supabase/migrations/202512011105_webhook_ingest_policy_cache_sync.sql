-- Sync webhook_ingest_policy cached_value with settings_versions (ensures version is present for validation)
BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH src AS (
  SELECT s.id, sv.value
  FROM settings s
  JOIN settings_versions sv ON s.settings_version_id = sv.id
  WHERE s.category = 'webhook_ingest_policy'
)
UPDATE settings s
SET cached_value = src.value,
    last_updated = now()
FROM src
WHERE s.id = src.id
  AND s.cached_value IS DISTINCT FROM src.value;

COMMIT;
