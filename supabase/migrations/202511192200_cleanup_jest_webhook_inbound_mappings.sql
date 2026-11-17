-- Cleanup test-only webhook_inbound mapping_configs rows created by historical Jest runs.
-- These rows use an older { fields: [...] } shape that no longer matches the canonical
-- mapping_configs.webhook_inbound schema and are not part of any production workflow.

BEGIN;

-- Normalize legacy test-only webhook_inbound mappings that used a { fields: [...] }
-- shape into the canonical schema form:
--   { external_id_path, event_type_path, transforms, description }
--
-- This preserves intent while making them valid against
-- mapping_configs.webhook_inbound.schema.json.

UPDATE mapping_configs
SET mapping_config = jsonb_build_object(
  'external_id_path',
  COALESCE(
    (
      SELECT f->>'pointer'
      FROM jsonb_array_elements(mapping_config->'fields') AS f
      WHERE f->>'as' = 'event_id'
      LIMIT 1
    ),
    'event.id'
  ),
  'event_type_path',
  COALESCE(
    (
      SELECT f->>'pointer'
      FROM jsonb_array_elements(mapping_config->'fields') AS f
      WHERE f->>'as' = 'event_type'
      LIMIT 1
    ),
    'event.type'
  ),
  'transforms',
  jsonb_build_object(
    'default',
    (
      SELECT jsonb_object_agg(f->>'as', f->>'pointer')
      FROM jsonb_array_elements(mapping_config->'fields') AS f
    )
  ),
  'description',
  mapping_config->>'description'
)
WHERE mapping_type = 'webhook_inbound'
  AND mapping_config ? 'fields';

COMMIT;
