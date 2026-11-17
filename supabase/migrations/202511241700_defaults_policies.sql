-- Migration: Global defaults policies (workflow_defaults, partition_defaults, edge_defaults)
-- Purpose: Provide dynamic, ladder-resolved defaults to remove code literals

BEGIN;

SET search_path TO public, pg_temp;

-- Schema registry entries (idempotent)
WITH docs AS (
  SELECT
    'workflow_defaults'::text AS category,
    1 AS version,
    $$
    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "workflow_defaults.schema.json",
      "title": "workflow_defaults",
      "type": "object",
      "properties": {
        "max_retries": { "type": "integer", "minimum": 0 },
        "default_priority": { "type": "integer", "minimum": 0 },
        "poll_seconds": { "type": "integer", "minimum": 0 },
        "max_wait_seconds": { "type": "integer", "minimum": 0 },
        "handler_timeout_seconds": { "type": "integer", "minimum": 1 }
      },
      "additionalProperties": true
    }
    $$::jsonb AS schema_doc,
    $$[{"max_retries":200,"default_priority":90,"poll_seconds":60,"max_wait_seconds":900,"handler_timeout_seconds":30}]$$::jsonb AS examples
),
part AS (
  SELECT
    'partition_defaults'::text AS category,
    1 AS version,
    $$
    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "partition_defaults.schema.json",
      "title": "partition_defaults",
      "type": "object",
      "properties": {
        "partitions_ahead": { "type": "integer", "minimum": 1 },
        "interval": { "type": "string", "enum": ["weekly","monthly"] }
      },
      "additionalProperties": true
    }
    $$::jsonb AS schema_doc,
    $$[{"partitions_ahead":4,"interval":"monthly"}]$$::jsonb AS examples
),
edge AS (
  SELECT
    'edge_defaults'::text AS category,
    1 AS version,
    $$
    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "edge_defaults.schema.json",
      "title": "edge_defaults",
      "type": "object",
      "properties": {
        "timeout_seconds": { "type": "integer", "minimum": 1 },
        "auth_scheme": { "type": "string" },
        "base_headers": { "type": "object" }
      },
      "additionalProperties": true
    }
    $$::jsonb AS schema_doc,
    $$[{"timeout_seconds":30,"auth_scheme":"Bearer","base_headers":{"content-type":"application/json"}}]$$::jsonb AS examples
)
INSERT INTO schema_registry (id, category, version, schema, description, examples, is_active, created_at)
SELECT gen_random_uuid(), d.category, d.version, d.schema_doc, d.category||' policy (global defaults)', d.examples, TRUE, now()
FROM (SELECT * FROM docs UNION ALL SELECT * FROM part UNION ALL SELECT * FROM edge) d
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema, description = EXCLUDED.description, examples = EXCLUDED.examples, is_active = TRUE, created_at = now();

-- Seed global settings (idempotent)
WITH seeds AS (
  SELECT 'workflow_defaults'::text AS category, jsonb_build_object(
    'max_retries',200,'default_priority',90,'poll_seconds',60,'max_wait_seconds',900,'handler_timeout_seconds',30) AS payload
  UNION ALL
  SELECT 'partition_defaults', jsonb_build_object('partitions_ahead',4,'interval','monthly')
  UNION ALL
  SELECT 'edge_defaults', jsonb_build_object('timeout_seconds',30,'auth_scheme','Bearer','base_headers', jsonb_build_object('content-type','application/json'))
),
ins_ver AS (
  INSERT INTO settings_versions (id, category, scope_type, scope_id, scope_hash, version, value, schema_version, change_reason, approved_at, effective_from)
  SELECT gen_random_uuid(), s.category, 'global', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 1, s.payload, 1,
         'Global defaults baseline', now(), now()
  FROM seeds s
  ON CONFLICT DO NOTHING
  RETURNING category, id
)
INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT s.category, 'global', NULL,
       COALESCE(v.id, (SELECT id FROM settings_versions WHERE category=s.category AND scope_type='global' AND scope_id IS NULL ORDER BY version DESC LIMIT 1)),
       s.payload, now()
FROM seeds s
LEFT JOIN ins_ver v ON v.category = s.category
ON CONFLICT (category, scope_type, scope_id)
DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = now();

COMMIT;