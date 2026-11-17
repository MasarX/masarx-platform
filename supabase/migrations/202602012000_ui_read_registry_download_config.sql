-- Migration: UI read registry download config
BEGIN;
SELECT pg_advisory_lock(hashtext('202602012000_ui_read_registry_download_config'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Update ui_read_registry schema to include download metadata.
UPDATE public.schema_registry
SET schema = '{
  "$schema":"http://json-schema.org/draft-07/schema#",
  "type":"object",
  "properties":{
    "resources":{
      "type":"array",
      "items":{
        "type":"object",
        "properties":{
          "key":{"type":"string"},
          "label":{"type":"string"},
          "relation":{"type":"string"},
          "id_column":{"type":"string"},
          "scope_columns":{"type":"object","additionalProperties":{"type":"string"}},
          "capability_read":{"type":"string"},
          "select":{"type":"array","items":{"type":"string"}},
          "filters":{
            "type":"array",
            "items":{
              "type":"object",
              "properties":{
                "key":{"type":"string"},
                "column":{"type":"string"},
                "op":{"type":"string","enum":["eq","ne","gt","gte","lt","lte","ilike"]}
              },
              "required":["key","column"]
            }
          },
          "download":{
            "type":"object",
            "properties":{
              "capability":{"type":"string"},
              "bucket":{"type":"string"},
              "path_column":{"type":"string"},
              "file_name_column":{"type":"string"},
              "expires_seconds":{"type":"integer"}
            }
          },
          "default_sort":{
            "type":"object",
            "properties":{
              "column":{"type":"string"},
              "direction":{"type":"string","enum":["asc","desc"]}
            }
          }
        },
        "required":["key","relation","id_column","capability_read"]
      }
    }
  },
  "required":["resources"]
}'::jsonb,
    description = 'UI read registry (v1)',
    is_active = true
WHERE category = 'ui_read_registry'
  AND version = 1;

-- Update global ui_read_registry to add label download config.
WITH current AS (
  SELECT s.settings_version_id,
         sv.version,
         sv.value,
         sv.schema_version
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
resources AS (
  SELECT jsonb_agg(
    CASE
      WHEN resource->>'key' = 'labels' THEN
        jsonb_set(
          resource,
          '{download}',
          jsonb_build_object(
            'capability', 'labels.download',
            'bucket', 'labels',
            'path_column', 'file_url',
            'expires_seconds', 900
          ),
          true
        )
      ELSE resource
    END
  ) AS resources
  FROM current, jsonb_array_elements(current.value->'resources') resource
),
updated AS (
  SELECT current.*, jsonb_set(current.value, '{resources}', resources.resources, true) AS next_value
  FROM current, resources
),
applied AS (
  UPDATE public.settings_versions sv
  SET value = updated.next_value,
      version = updated.version + 1,
      change_reason = 'Add labels download config to ui_read_registry',
      approved_at = now(),
      effective_from = now()
  FROM updated
  WHERE sv.id = updated.settings_version_id
    AND updated.next_value IS DISTINCT FROM updated.value
  RETURNING sv.id, sv.value
)
UPDATE public.settings s
SET cached_value = applied.value,
    last_updated = now()
FROM applied
WHERE s.category = 'ui_read_registry'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL
  AND s.settings_version_id = applied.id;

SELECT pg_advisory_unlock(hashtext('202602012000_ui_read_registry_download_config'));
COMMIT;
