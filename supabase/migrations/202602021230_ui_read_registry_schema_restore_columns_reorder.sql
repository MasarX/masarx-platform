-- Migration: Restore ui_read_registry schema fields (columns/capability_write/reorder)
-- Context: A prior migration overwrote the ui_read_registry schema with an older shape that
-- did not include columns metadata, capability_write, or reorder config. This breaks UI
-- registry contract tests and feature behavior.
BEGIN;
SELECT pg_advisory_lock(hashtext('202602021230_ui_read_registry_schema_restore_columns_reorder'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry sr
SET schema = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          sr.schema,
          '{properties,resources,items,properties,capability_write}',
          jsonb_build_object('type', 'string'),
          true
        ),
        '{properties,resources,items,properties,column_labels}',
        jsonb_build_object(
          'type', 'object',
          'additionalProperties', jsonb_build_object('type', 'string')
        ),
        true
      ),
      '{properties,resources,items,properties,columns}',
      '{
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
      }'::jsonb,
      true
    ),
    '{properties,resources,items,properties,related}',
    '{
      "type":"array",
      "items":{
        "type":"object",
        "properties":{
          "resource":{"type":"string"},
          "label":{"type":"string"},
          "filter_key":{"type":"string"},
          "from":{"type":"string"},
          "limit":{"type":"integer","minimum":1}
        },
        "required":["resource","filter_key","from"]
      }
    }'::jsonb,
    true
  ),
  '{properties,resources,items,properties,reorder}',
  '{
    "type":"object",
    "properties":{
      "order_column":{"type":"string"},
      "group_column":{"type":"string"},
      "require_full":{"type":"boolean"},
      "capability":{"type":"string"},
      "post_action":{"type":"string"}
    },
    "required":["order_column"]
  }'::jsonb,
  true
),
    description = 'UI read registry (v1)'
WHERE sr.category = 'ui_read_registry'
  AND sr.version = 1;

SELECT pg_advisory_unlock(hashtext('202602021230_ui_read_registry_schema_restore_columns_reorder'));
COMMIT;
