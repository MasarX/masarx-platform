-- Migration: Backfill webhook_ingest_policy to canonical ack schema across all scopes
-- Purpose: Remove legacy response.* usage; ensure ack.* is present consistently

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Update settings_versions: promote response.* to ack.* where ack missing; remove response key
WITH m AS (
  SELECT id AS mapping_id
  FROM mapping_configs
  WHERE mapping_type = 'webhook_response' AND mapping_key = 'global::ack_async_v1'
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1
)
UPDATE settings_versions sv
SET value = (
  (sv.value - 'response')
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
           jsonb_build_object('mode', 'accepted_async')
         END
       )
     )
)
WHERE sv.category = 'webhook_ingest_policy';

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
           jsonb_build_object('mode', 'accepted_async')
         END
       )
     )
)
WHERE s.category = 'webhook_ingest_policy';

COMMIT;

