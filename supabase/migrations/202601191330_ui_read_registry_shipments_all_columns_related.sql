-- Migration: Shipments resource shows all columns + related sections (UI read registry)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191330_ui_read_registry_shipments_all_columns_related'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Extend ui_read_registry schema to support related sections in detail views.
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
          "related":{
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

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_found BOOLEAN := false;
  v_capability_write TEXT;
  v_columns JSONB;
  v_related JSONB := jsonb_build_array(
    jsonb_build_object(
      'resource','labels',
      'label','Labels',
      'filter_key','shipment_id',
      'from','id',
      'limit', 25
    ),
    jsonb_build_object(
      'resource','label_jobs',
      'label','Label jobs',
      'filter_key','shipment_id',
      'from','id',
      'limit', 25
    ),
    jsonb_build_object(
      'resource','shipment_boxes',
      'label','Boxes',
      'filter_key','shipment_id',
      'from','id',
      'limit', 25
    ),
    jsonb_build_object(
      'resource','shipment_actions',
      'label','Actions',
      'filter_key','shipment_id',
      'from','id',
      'limit', 50
    ),
    jsonb_build_object(
      'resource','shipment_reference_numbers',
      'label','References',
      'filter_key','shipment_id',
      'from','id',
      'limit', 25
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_resource->>'key' = 'shipments' THEN
      v_found := true;
      v_capability_write := NULLIF(v_resource->>'capability_write', '');
      IF v_capability_write IS NULL AND (v_resource->>'capability_read') ~ '\\.read$' THEN
        v_capability_write := regexp_replace(v_resource->>'capability_read', '\\.read$', '.write');
      END IF;

      SELECT jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'key', cols.column_name,
            'label', COALESCE(v_resource->'column_labels'->>cols.column_name, initcap(replace(cols.column_name, '_', ' '))),
            'render_type',
              CASE
                WHEN cols.data_type IN ('timestamp with time zone', 'timestamp without time zone') THEN 'datetime'
                WHEN cols.data_type = 'date' THEN 'date'
                WHEN cols.data_type IN ('integer','bigint','smallint','numeric','double precision','real') THEN 'number'
                WHEN cols.data_type = 'boolean' THEN 'boolean'
                WHEN cols.data_type = 'uuid' THEN 'id'
                WHEN cols.data_type IN ('json','jsonb') THEN 'json'
                WHEN cols.column_name ~* '_at$' THEN 'datetime'
                WHEN cols.column_name ~* '_date$' THEN 'date'
                ELSE 'text'
              END,
            'format_options', NULL,
            'edit_mode',
              CASE
                WHEN v_capability_write IS NULL THEN 'none'
                WHEN cols.column_name IN (
                  'id',
                  'created_at',
                  'updated_at',
                  'deleted_at',
                  'inserted_at',
                  'created_by',
                  'updated_by',
                  'created_by_id',
                  'updated_by_id'
                ) THEN 'none'
                ELSE 'inline'
              END,
            'edit_type',
              CASE
                WHEN cols.data_type IN ('timestamp with time zone', 'timestamp without time zone') THEN 'datetime'
                WHEN cols.data_type = 'date' THEN 'date'
                WHEN cols.data_type IN ('integer','bigint','smallint','numeric','double precision','real') THEN 'number'
                WHEN cols.data_type = 'boolean' THEN 'boolean'
                WHEN cols.data_type = 'uuid' THEN 'text'
                WHEN cols.data_type IN ('json','jsonb') THEN 'text'
                WHEN cols.column_name ~* '_at$' THEN 'datetime'
                WHEN cols.column_name ~* '_date$' THEN 'date'
                ELSE 'text'
              END,
            'edit_permission',
              CASE
                WHEN v_capability_write IS NULL THEN NULL
                WHEN cols.column_name IN (
                  'id',
                  'created_at',
                  'updated_at',
                  'deleted_at',
                  'inserted_at',
                  'created_by',
                  'updated_by',
                  'created_by_id',
                  'updated_by_id'
                ) THEN NULL
                ELSE v_capability_write
              END
          )
        )
        ORDER BY cols.ordinal_position
      )
      INTO v_columns
      FROM information_schema.columns cols
      WHERE cols.table_schema = 'public'
        AND cols.table_name = 'shipments';

      v_resource := v_resource - 'select';
      v_resource := jsonb_set(v_resource, '{columns}', COALESCE(v_columns, '[]'::jsonb), true);
      v_resource := jsonb_set(v_resource, '{related}', v_related, true);
    END IF;
    v_updated := v_updated || jsonb_build_array(v_resource);
  END LOOP;

  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ui_read_registry missing shipments resource';
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated, true);

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
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Shipments: show all columns + related sections',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
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
END $$;

SELECT pg_advisory_unlock(hashtext('202601191330_ui_read_registry_shipments_all_columns_related'));
COMMIT;

