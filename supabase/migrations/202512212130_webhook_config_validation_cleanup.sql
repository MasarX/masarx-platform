-- Migration: Normalize webhook ingest policy + webhook_inbound mappings for config validation
-- Date: 2025-12-21

BEGIN;

-- Fix webhook_ingest_policy JSON: add missing "version" and drop deprecated validation.idempotency.normalize.
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

-- Normalize legacy webhook_inbound mapping_configs that still use a { fields: [...] } shape.
UPDATE mapping_configs
SET mapping_config = jsonb_strip_nulls(
  jsonb_build_object(
    'external_id_path',
    COALESCE(
      (
        SELECT replace(trim(both '/' from (f->>'pointer')), '/', '.')
        FROM jsonb_array_elements(mapping_config->'fields') AS f
        WHERE f->>'as' = 'event_id'
        LIMIT 1
      ),
      'event.id'
    ),
    'event_type_path',
    COALESCE(
      (
        SELECT replace(trim(both '/' from (f->>'pointer')), '/', '.')
        FROM jsonb_array_elements(mapping_config->'fields') AS f
        WHERE f->>'as' = 'event_type'
        LIMIT 1
      ),
      'event.type'
    ),
    'transforms',
    jsonb_build_object(
      'default',
      COALESCE(
        (
          SELECT jsonb_object_agg(
            f->>'as',
            replace(trim(both '/' from (f->>'pointer')), '/', '.')
          )
          FROM jsonb_array_elements(mapping_config->'fields') AS f
          WHERE f ? 'as' AND f ? 'pointer'
        ),
        '{}'::jsonb
      )
    ),
    'description',
    mapping_config->>'description'
  )
)
WHERE mapping_type = 'webhook_inbound'
  AND mapping_config ? 'fields';

COMMIT;
