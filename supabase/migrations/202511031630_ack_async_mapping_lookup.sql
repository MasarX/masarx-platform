-- Migration: Replace hardcoded ACK mapping UUID with row-driven lookup
-- Purpose: Ensure webhook_ingest_policy.global uses mapping_configs.id resolved by mapping_key
--          'global::ack_async_v1', removing any hardcoded UUIDs.
-- Notes: Idempotent, non-destructive. Updates only when mapping exists.

BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH mc AS (
  SELECT id
  FROM mapping_configs
  WHERE mapping_type = 'webhook_response' AND mapping_key = 'global::ack_async_v1'
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1
)
UPDATE settings_versions sv
SET value = jsonb_set(
  COALESCE(sv.value, '{}'::jsonb),
  '{ack,response_mapping_id}',
  (SELECT to_jsonb(id::text) FROM mc),
  true
)
WHERE sv.category = 'webhook_ingest_policy'
  AND sv.scope_type = 'global'
  AND EXISTS (SELECT 1 FROM mc);

WITH mc AS (
  SELECT id
  FROM mapping_configs
  WHERE mapping_type = 'webhook_response' AND mapping_key = 'global::ack_async_v1'
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1
)
UPDATE settings s
SET cached_value = jsonb_set(
  COALESCE(s.cached_value, '{}'::jsonb),
  '{ack,response_mapping_id}',
  (SELECT to_jsonb(id::text) FROM mc),
  true
)
WHERE s.category = 'webhook_ingest_policy'
  AND s.scope_type = 'global'
  AND EXISTS (SELECT 1 FROM mc);

COMMIT;

