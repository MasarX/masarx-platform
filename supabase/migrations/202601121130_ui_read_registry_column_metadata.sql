-- Migration: UI read registry column metadata defaults (render/edit)
-- Purpose: Populate render_type/edit metadata for ui_read_registry columns based on schema.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601121130_ui_read_registry_column_metadata'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
    jsonb_set(resource, '{columns}', COALESCE(derived.columns, '[]'::jsonb), true)
  ) AS resources
  FROM current,
       jsonb_array_elements(current.value->'resources') AS resource
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'key', col.key,
          'label', col.label,
          'render_type', col.render_type,
          'format_options', col.format_options,
          'edit_mode', col.edit_mode,
          'edit_type', col.edit_type,
          'edit_permission', col.edit_permission
        )
      )
    ) AS columns
    FROM (
      SELECT DISTINCT
        key,
        COALESCE(resource->'column_labels'->>key, initcap(replace(key, '_', ' '))) AS label,
        CASE
          WHEN data_type IN ('timestamp with time zone', 'timestamp without time zone') THEN 'datetime'
          WHEN data_type = 'date' THEN 'date'
          WHEN data_type IN ('integer','bigint','smallint','numeric','double precision','real') THEN 'number'
          WHEN data_type = 'boolean' THEN 'boolean'
          WHEN data_type = 'uuid' THEN 'id'
          WHEN data_type IN ('json','jsonb') THEN 'json'
          WHEN key ~* '_at$' THEN 'datetime'
          WHEN key ~* '_date$' THEN 'date'
          ELSE 'text'
        END AS render_type,
        NULL::jsonb AS format_options,
        CASE
          WHEN resource->>'capability_write' IS NULL THEN 'none'
          WHEN key IN (
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
        END AS edit_mode,
        CASE
          WHEN data_type IN ('timestamp with time zone', 'timestamp without time zone') THEN 'datetime'
          WHEN data_type = 'date' THEN 'date'
          WHEN data_type IN ('integer','bigint','smallint','numeric','double precision','real') THEN 'number'
          WHEN data_type = 'boolean' THEN 'boolean'
          WHEN data_type = 'uuid' THEN 'text'
          WHEN data_type IN ('json','jsonb') THEN 'text'
          WHEN key ~* '_at$' THEN 'datetime'
          WHEN key ~* '_date$' THEN 'date'
          ELSE 'text'
        END AS edit_type,
        CASE
          WHEN resource->>'capability_write' IS NULL THEN NULL
          WHEN key IN (
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
          ELSE resource->>'capability_write'
        END AS edit_permission
      FROM (
        SELECT jsonb_array_elements_text(COALESCE(resource->'select', '[]'::jsonb)) AS key
        UNION
        SELECT jsonb_object_keys(COALESCE(resource->'column_labels', '{}'::jsonb)) AS key
      ) AS keys
      LEFT JOIN information_schema.columns cols
        ON cols.table_schema = 'public'
       AND cols.table_name = resource->>'relation'
       AND cols.column_name = keys.key
    ) AS col
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
      change_reason = 'Add render/edit metadata to ui_read_registry columns',
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

SELECT pg_advisory_unlock(hashtext('202601121130_ui_read_registry_column_metadata'));
COMMIT;
