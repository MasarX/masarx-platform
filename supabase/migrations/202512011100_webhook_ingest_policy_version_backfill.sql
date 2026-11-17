-- Backfill webhook_ingest_policy version for rows missing it (schema alignment for config validation)
BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH updated AS (
  UPDATE settings_versions sv
  SET value = jsonb_set(
        sv.value,
        '{version}',
        to_jsonb(COALESCE(NULLIF(sv.value->>'version', '')::int, 1)),
        true
      ),
      change_reason = COALESCE(change_reason, 'Backfill webhook_ingest_policy.version'),
      approved_at = COALESCE(approved_at, now()),
      effective_from = COALESCE(effective_from, now())
  WHERE sv.category = 'webhook_ingest_policy'
    AND ((NOT (sv.value ? 'version')) OR (sv.value->>'version') IS NULL)
  RETURNING id
)
UPDATE settings s
SET cached_value = sv.value,
    last_updated = now()
FROM settings_versions sv
WHERE s.settings_version_id = sv.id
  AND s.category = 'webhook_ingest_policy'
  AND sv.id IN (SELECT id FROM updated)
  AND ((NOT (s.cached_value ? 'version')) OR (s.cached_value->>'version') IS NULL);

COMMIT;
