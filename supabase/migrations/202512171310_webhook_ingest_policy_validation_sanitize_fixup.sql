-- Migration: Sanitize webhook_ingest_policy.validation shape (fixup)
-- Purpose:
--   - validate:configs enforces docs/ops/schemas/webhook_ingest_policy.schema.json
--     where validation.additionalProperties=false.
--   - Some environments may have drifted rows under settings/settings_versions with
--     extra keys under "validation", causing CI validation to fail.
--   - This migration normalizes "validation" by keeping only the allowed keys:
--       - idempotency
--       - hmac
--       - json_schema_id
-- Date: 2025-12-17

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Patch settings_versions first (source-of-truth history), then settings cached_value.
UPDATE settings_versions sv
SET value = jsonb_set(
    COALESCE(sv.value, '{}'::jsonb),
    '{validation}',
    jsonb_strip_nulls(
      jsonb_build_object(
        'idempotency', sv.value->'validation'->'idempotency',
        'hmac', sv.value->'validation'->'hmac',
        'json_schema_id', sv.value->'validation'->'json_schema_id'
      )
    ),
    true
  ),
  created_at = now()
WHERE sv.category = 'webhook_ingest_policy'
  AND sv.value ? 'validation'
  AND jsonb_typeof(sv.value->'validation') = 'object'
  AND (sv.value->'validation') <> jsonb_strip_nulls(
    jsonb_build_object(
      'idempotency', sv.value->'validation'->'idempotency',
      'hmac', sv.value->'validation'->'hmac',
      'json_schema_id', sv.value->'validation'->'json_schema_id'
    )
  );

UPDATE settings s
SET cached_value = jsonb_set(
    COALESCE(s.cached_value, '{}'::jsonb),
    '{validation}',
    jsonb_strip_nulls(
      jsonb_build_object(
        'idempotency', s.cached_value->'validation'->'idempotency',
        'hmac', s.cached_value->'validation'->'hmac',
        'json_schema_id', s.cached_value->'validation'->'json_schema_id'
      )
    ),
    true
  ),
  last_updated = now()
WHERE s.category = 'webhook_ingest_policy'
  AND s.cached_value ? 'validation'
  AND jsonb_typeof(s.cached_value->'validation') = 'object'
  AND (s.cached_value->'validation') <> jsonb_strip_nulls(
    jsonb_build_object(
      'idempotency', s.cached_value->'validation'->'idempotency',
      'hmac', s.cached_value->'validation'->'hmac',
      'json_schema_id', s.cached_value->'validation'->'json_schema_id'
    )
  );

COMMIT;

