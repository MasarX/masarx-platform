-- Migration: Normalize global webhook_ingest_policy to NULL scope_id and canonical ack schema
-- Purpose: Ensure resolver can find global policy (scope_id IS NULL) and defaults to accepted_async (202)
-- Strategy: (1) Normalize scope for global rows, (2) Ensure ack.* exists with accepted_async, (3) Leave ladder precedence intact

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- 1) Normalize global settings_versions rows: scope_id must be NULL for global scope.
UPDATE settings_versions
SET scope_id = NULL,
    scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
WHERE category = 'webhook_ingest_policy'
  AND scope_type = 'global'
  AND scope_id IS NOT NULL;

-- 2) Normalize global settings rows: scope_id must be NULL for global scope.
UPDATE settings
SET scope_id = NULL,
    scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
WHERE category = 'webhook_ingest_policy'
  AND scope_type = 'global'
  AND scope_id IS NOT NULL;

-- 3) Ensure canonical ack schema at global scope.
--    If a legacy response.* exists (or ack missing), map to ack.mode and ack.response_mapping_id.
WITH m AS (
  SELECT id AS mapping_id
  FROM mapping_configs
  WHERE mapping_type = 'webhook_response' AND mapping_key = 'global::ack_async_v1'
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1
)
UPDATE settings_versions sv
SET value = (
  -- Start from value without legacy 'response'
  (sv.value - 'response')
  -- Ensure 'ack' exists with accepted_async and mapping id
  || jsonb_build_object(
       'ack',
       COALESCE(
         sv.value->'ack',
         CASE WHEN sv.value ? 'response' THEN
           jsonb_strip_nulls(
             jsonb_build_object(
               'mode', COALESCE(sv.value->'response'->>'mode', 'accepted_async'),
               'response_mapping_id', (SELECT to_jsonb(m.mapping_id::text) FROM m)
             )
           )
         ELSE
           jsonb_strip_nulls(
             jsonb_build_object(
               'mode', 'accepted_async',
               'response_mapping_id', (SELECT to_jsonb(m.mapping_id::text) FROM m)
             )
           )
         END
       )
     )
)
WHERE sv.category = 'webhook_ingest_policy'
  AND sv.scope_type = 'global';

-- Mirror cached_value in settings
WITH m AS (
  SELECT id AS mapping_id
  FROM mapping_configs
  WHERE mapping_type = 'webhook_response' AND mapping_key = 'global::ack_async_v1'
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1
)
UPDATE settings s
SET cached_value = (
  (s.cached_value - 'response')
  || jsonb_build_object(
       'ack',
       COALESCE(
         s.cached_value->'ack',
         CASE WHEN s.cached_value ? 'response' THEN
           jsonb_strip_nulls(
             jsonb_build_object(
               'mode', COALESCE(s.cached_value->'response'->>'mode', 'accepted_async'),
               'response_mapping_id', (SELECT to_jsonb(m.mapping_id::text) FROM m)
             )
           )
         ELSE
           jsonb_strip_nulls(
             jsonb_build_object(
               'mode', 'accepted_async',
               'response_mapping_id', (SELECT to_jsonb(m.mapping_id::text) FROM m)
             )
           )
         END
       )
     )
)
WHERE s.category = 'webhook_ingest_policy'
  AND s.scope_type = 'global';

COMMIT;

