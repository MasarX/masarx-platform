-- Migration: UI read registry operation_handlers plugin editing
-- Purpose: Expose operation handler UI metadata as editable fields for ops (no hardcoding; SSOT via operation_handlers rows).
-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04

BEGIN;
SELECT pg_advisory_lock(hashtext('202601211640_ui_read_registry_operation_handlers_plugin_editing'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_found BOOLEAN := false;
  v_columns JSONB;
  v_capability_write TEXT := 'operation_handlers.write';
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
    IF v_resource->>'key' = 'operation_handlers' THEN
      v_found := true;

      -- Ensure operation_handlers is editable via explicit capability_write and safe column-level edit metadata.
      v_resource := v_resource - 'select';
      v_resource := jsonb_set(v_resource, '{capability_write}', to_jsonb(v_capability_write), true);

      SELECT jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'key', cols.column_name,
            'label',
              CASE cols.column_name
                WHEN 'ui_label' THEN 'Label'
                WHEN 'ui_category' THEN 'Category'
                WHEN 'ui_description' THEN 'Description'
                WHEN 'config_schema_category' THEN 'Inspector schema'
                WHEN 'handler_key' THEN 'Handler key'
                WHEN 'handler_schema' THEN 'Handler schema'
                WHEN 'handler_name' THEN 'Handler name'
                WHEN 'handler_signature' THEN 'Handler signature'
                WHEN 'handler_version' THEN 'Handler version'
                ELSE initcap(replace(cols.column_name, '_', ' '))
              END,
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
                WHEN cols.column_name IN (
                  'ui_label',
                  'ui_category',
                  'ui_description',
                  'config_schema_category',
                  'is_active',
                  'notes',
                  'doc_url'
                ) THEN 'inline'
                ELSE 'none'
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
                WHEN cols.column_name IN (
                  'ui_label',
                  'ui_category',
                  'ui_description',
                  'config_schema_category',
                  'is_active',
                  'notes',
                  'doc_url'
                ) THEN v_capability_write
                ELSE NULL
              END
          )
        )
        ORDER BY cols.ordinal_position
      )
      INTO v_columns
      FROM information_schema.columns cols
      WHERE cols.table_schema = 'public'
        AND cols.table_name = 'operation_handlers';

      v_resource := jsonb_set(v_resource, '{columns}', COALESCE(v_columns, '[]'::jsonb), true);
    END IF;

    v_updated := v_updated || jsonb_build_array(v_resource);
  END LOOP;

  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ui_read_registry missing operation_handlers resource';
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
           change_reason = 'Operation handlers: enable plugin metadata editing',
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

SELECT pg_advisory_unlock(hashtext('202601211640_ui_read_registry_operation_handlers_plugin_editing'));
COMMIT;

