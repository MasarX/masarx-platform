-- Migration: label_print_defaults policy (settings-driven fallbacks)
-- Purpose: Ensure all bundle fallbacks are configuration-driven (no hardcoding)

BEGIN;

SET search_path TO public, pg_temp;

WITH doc AS (
  SELECT 'label_print_defaults'::text AS category,
         1 AS version,
         $$
         {
           "$schema": "https://json-schema.org/draft/2020-12/schema",
           "$id": "label_print_defaults.schema.json",
           "title": "label_print_defaults",
           "type": "object",
           "properties": {
             "synthesize_from_existing": { "type": "boolean" },
             "prefer_signed_url": { "type": "boolean" }
           },
           "additionalProperties": true
         }
         $$::jsonb AS schema_doc,
         $$[{"synthesize_from_existing": true, "prefer_signed_url": true}]$$::jsonb AS examples
)
INSERT INTO schema_registry (id, category, version, schema, description, examples, is_active, created_at)
SELECT gen_random_uuid(), category, version, schema_doc, 'Defaults for label print fallbacks', examples, TRUE, now()
FROM doc
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema, description = EXCLUDED.description, examples = EXCLUDED.examples, is_active = TRUE, created_at = now();

WITH s AS (
  SELECT 'label_print_defaults'::text AS category,
         jsonb_build_object('synthesize_from_existing', true, 'prefer_signed_url', true) AS payload
),
ins_ver AS (
  INSERT INTO settings_versions (id, category, scope_type, scope_id, scope_hash, version, value, schema_version, change_reason, approved_at, effective_from)
  SELECT gen_random_uuid(), s.category, 'global', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 1, s.payload, 1,
         'Label print defaults baseline', now(), now()
  FROM s
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'label_print_defaults','global', NULL,
       COALESCE((SELECT id FROM ins_ver), (SELECT id FROM settings_versions WHERE category='label_print_defaults' AND scope_type='global' AND scope_id IS NULL ORDER BY version DESC LIMIT 1)),
       (SELECT payload FROM s), now()
ON CONFLICT (category, scope_type, scope_id)
DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = now();

COMMIT;