-- Migration: tracking_policy.v1 schema and global seed
-- Purpose: Introduce dynamic, ladder-driven tracking number policy

BEGIN;

-- 1) Register tracking_policy in schema_registry
INSERT INTO schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'tracking_policy',
  1,
  -- JSON Schema (draft-07 style)
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Tracking Number Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "unique_scope": { "type": "string", "enum": ["tenant", "client", "global"] },
      "format": { "type": "string" },
      "alphabet": { "type": "string", "enum": ["BASE36", "CROCKFORD32"] },
      "checksum": { "type": ["string", "null"], "enum": [null, "iso7064_mod_37_36", "damm"] },
      "prefix": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "value": { "type": ["string", "null"] },
          "separator": { "type": ["string", "null"] },
          "max_len": { "type": ["integer", "null"], "minimum": 1, "maximum": 8 }
        }
      },
      "sequence": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "scope": { "type": "string", "enum": ["tenant", "client", "sender"] },
          "strategy": { "type": "string", "enum": ["pg_sequence", "counter_block"] },
          "cache": { "type": ["integer", "null"], "minimum": 1 },
          "block_size": { "type": ["integer", "null"], "minimum": 1 },
          "start": { "type": ["integer", "null"], "minimum": 0 }
        }
      },
      "tokens": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "type": { "type": "string", "enum": ["prefix", "date", "seq", "chk"] },
            "pattern": { "type": ["string", "null"] },
            "len": { "type": ["integer", "null"], "minimum": 1 }
          },
          "required": ["type"]
        }
      },
      "sync_generate": { "type": ["boolean", "null"] }
    }
  }'::jsonb,
  'Dynamic policy for tracking number generation with tokenized format and ladder overrides.',
  '[
    {
      "version": 1,
      "unique_scope": "tenant",
      "alphabet": "BASE36",
      "checksum": "iso7064_mod_37_36",
      "prefix": { "value": null, "separator": "", "max_len": 4 },
      "sequence": { "scope": "tenant", "strategy": "pg_sequence", "cache": 1000, "start": 1 },
      "tokens": [
        {"type":"prefix"},
        {"type":"date", "pattern":"YY"},
        {"type":"seq", "len": 6},
        {"type":"chk"}
      ],
      "sync_generate": true
    }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version)
DO UPDATE SET schema = EXCLUDED.schema,
              description = EXCLUDED.description,
              examples = EXCLUDED.examples,
              is_active = TRUE;

-- 2) Seed a global tracking_policy default
WITH upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'unique_scope', 'tenant',
    'alphabet', 'BASE36',
    'checksum', 'iso7064_mod_37_36',
    'prefix', jsonb_build_object('value', null, 'separator', '', 'max_len', 4),
    'sequence', jsonb_build_object('scope','tenant','strategy','pg_sequence','cache',1000,'start',1),
    'tokens', jsonb_build_array(
      jsonb_build_object('type','prefix'),
      jsonb_build_object('type','date','pattern','YY'),
      jsonb_build_object('type','seq','len',6),
      jsonb_build_object('type','chk')
    ),
    'sync_generate', true
  ) AS body
)
INSERT INTO settings_versions (category, scope_type, scope_id, version, value, approved_at)
SELECT 'tracking_policy', 'global', NULL, 1, body, now() FROM upsert
ON CONFLICT DO NOTHING;

INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM settings_versions sv
WHERE sv.category = 'tracking_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_id IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM settings s
       WHERE s.category = sv.category AND s.scope_type = sv.scope_type AND s.scope_id IS NULL
  );

COMMIT;

