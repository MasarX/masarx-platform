-- Migration: Reapply webhook_ingest_policy version backfill (post-seed v2)
-- Purpose: keep validate:configs green for rows inserted after prior backfills.
BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH fixes AS (
  SELECT
    id,
    CASE
      WHEN value ? 'version' THEN value #- '{validation,idempotency,normalize}'
      ELSE jsonb_set(value #- '{validation,idempotency,normalize}', '{version}', to_jsonb(1), true)
    END AS new_value
  FROM settings_versions
  WHERE category = 'webhook_ingest_policy'
    AND (
      NOT (value ? 'version')
      OR (COALESCE(value #> '{validation,idempotency}', '{}'::jsonb) ? 'normalize')
    )
)
UPDATE settings_versions sv
SET value = fixes.new_value
FROM fixes
WHERE sv.id = fixes.id;

WITH fixes AS (
  SELECT
    id,
    CASE
      WHEN cached_value ? 'version' THEN cached_value #- '{validation,idempotency,normalize}'
      ELSE jsonb_set(cached_value #- '{validation,idempotency,normalize}', '{version}', to_jsonb(1), true)
    END AS new_value
  FROM settings
  WHERE category = 'webhook_ingest_policy'
    AND (
      NOT (cached_value ? 'version')
      OR (COALESCE(cached_value #> '{validation,idempotency}', '{}'::jsonb) ? 'normalize')
    )
)
UPDATE settings s
SET cached_value = fixes.new_value,
    last_updated = now()
FROM fixes
WHERE s.id = fixes.id;

COMMIT;
