-- Migration: UI read registry column metadata
BEGIN;
SELECT pg_advisory_lock(hashtext('202601111100_ui_read_registry_columns'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
          "capability_write":{"type":"string"},
          "select":{"type":"array","items":{"type":"string"}},
          "column_labels":{"type":"object","additionalProperties":{"type":"string"}},
          "columns":{
            "type":"array",
            "items":{
              "type":"object",
              "properties":{
                "key":{"type":"string"},
                "label":{"type":"string"},
                "render_type":{"type":"string"},
                "format_options":{"type":"object"},
                "edit_mode":{"type":"string","enum":["none","read","inline","modal","form"]},
                "edit_type":{"type":"string"},
                "edit_permission":{"type":"string"},
                "aggregation":{
                  "type":"object",
                  "properties":{
                    "enabled":{"type":"boolean"},
                    "methods":{"type":"array","items":{"type":"string"}}
                  }
                }
              },
              "required":["key"]
            }
          },
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
      WHEN derived.capability_write IS NOT NULL AND derived.columns IS NOT NULL THEN
        jsonb_set(
          jsonb_set(resource, '{columns}', derived.columns, true),
          '{capability_write}', to_jsonb(derived.capability_write), true
        )
      WHEN derived.capability_write IS NOT NULL THEN
        jsonb_set(resource, '{capability_write}', to_jsonb(derived.capability_write), true)
      WHEN derived.columns IS NOT NULL THEN
        jsonb_set(resource, '{columns}', derived.columns, true)
      ELSE resource
    END
  ) AS resources
  FROM current,
    jsonb_array_elements(current.value->'resources') AS resource
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN resource ? 'columns' THEN NULL
        ELSE (
          SELECT jsonb_agg(
            jsonb_strip_nulls(
              jsonb_build_object(
                'key', value,
                'label', resource->'column_labels'->>value
              )
            )
          )
          FROM jsonb_array_elements_text(COALESCE(resource->'select', '[]'::jsonb)) AS value
        )
      END AS columns,
      CASE
        WHEN resource ? 'capability_write' THEN NULL
        WHEN (resource->>'capability_read') ~ '\\.read$' THEN
          regexp_replace(resource->>'capability_read', '\\.read$', '.write')
        ELSE NULL
      END AS capability_write
  ) AS derived
),
updated AS (
  SELECT current.*, jsonb_set(current.value, '{resources}', resources.resources, true) AS next_value
  FROM current, resources
),
applied AS (
  UPDATE public.settings_versions sv
  SET value = updated.next_value,
      version = updated.version + 1,
      change_reason = 'Add column metadata defaults to ui_read_registry',
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

SELECT pg_advisory_unlock(hashtext('202601111100_ui_read_registry_columns'));
COMMIT;
