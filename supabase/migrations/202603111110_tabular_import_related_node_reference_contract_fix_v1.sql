-- Plan: PLAN-202603-resource-import-related-node-graph / Step: S04
-- Migration: Repair inline related-node reference contracts with canonical target resource metadata

BEGIN;

SELECT pg_advisory_lock(hashtext('202603111110_tabular_import_related_node_reference_contract_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_columns JSONB;
  v_updated_columns JSONB;
  v_column JSONB;
  v_column_key TEXT;
  v_resource_key TEXT;
  v_import JSONB;
  v_reference JSONB;
  v_target_resource_key TEXT;
  v_target_resource JSONB;
  v_display_columns JSONB;
  v_label_column TEXT;
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

  FOR v_resource IN
    SELECT value
    FROM jsonb_array_elements(v_resources) AS value
  LOOP
    v_resource_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');
    v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
    IF jsonb_typeof(v_columns) IS DISTINCT FROM 'array' THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
      CONTINUE;
    END IF;

    v_updated_columns := '[]'::jsonb;

    FOR v_column IN
      SELECT value
      FROM jsonb_array_elements(v_columns) AS value
    LOOP
      v_column_key := NULLIF(btrim(COALESCE(v_column->>'key', '')), '');
      v_import := COALESCE(v_column->'import', '{}'::jsonb);
      IF jsonb_typeof(v_import) IS DISTINCT FROM 'object' THEN
        v_import := '{}'::jsonb;
      END IF;

      v_reference := COALESCE(v_import->'reference', '{}'::jsonb);
      IF jsonb_typeof(v_reference) IS DISTINCT FROM 'object' THEN
        v_reference := '{}'::jsonb;
      END IF;

      v_target_resource_key := NULL;
      IF v_resource_key = 'shipments' AND v_column_key = 'recipient_id' THEN
        v_target_resource_key := 'recipients';
      ELSIF v_resource_key = 'shipments' AND v_column_key IN ('destination_address_id', 'origin_address_id') THEN
        v_target_resource_key := 'addresses';
      END IF;

      IF v_target_resource_key IS NOT NULL THEN
        SELECT value
          INTO v_target_resource
          FROM jsonb_array_elements(v_resources) AS value
         WHERE NULLIF(btrim(COALESCE(value->>'key', '')), '') = v_target_resource_key
         LIMIT 1;

        IF v_target_resource IS NOT NULL THEN
          SELECT COALESCE(
                   jsonb_agg(to_jsonb(column_value->>'key') ORDER BY column_value->>'key'),
                   '[]'::jsonb
                 )
            INTO v_display_columns
            FROM jsonb_array_elements(COALESCE(v_target_resource->'columns', '[]'::jsonb)) AS column_value
           WHERE NULLIF(btrim(COALESCE(column_value->>'key', '')), '') IS NOT NULL
             AND COALESCE(column_value->>'key', '') <> COALESCE(v_target_resource->>'id_column', 'id')
             AND (
               COALESCE(NULLIF(column_value#>>ARRAY['import','enabled'], '')::boolean, TRUE) IS TRUE
               OR lower(COALESCE(column_value->>'edit_mode', '')) NOT IN ('none', 'read')
             )
           LIMIT 3;

          v_label_column := NULL;
          SELECT NULLIF(btrim(COALESCE(column_value->>'key', '')), '')
            INTO v_label_column
            FROM jsonb_array_elements(COALESCE(v_target_resource->'columns', '[]'::jsonb)) AS column_value
           WHERE NULLIF(btrim(COALESCE(column_value->>'key', '')), '') IN ('name', 'title', 'normalized_line1', 'label', 'external_id')
           ORDER BY CASE column_value->>'key'
             WHEN 'name' THEN 1
             WHEN 'title' THEN 2
             WHEN 'normalized_line1' THEN 3
             WHEN 'label' THEN 4
             WHEN 'external_id' THEN 5
             ELSE 100
           END
           LIMIT 1;

          v_reference := v_reference || jsonb_strip_nulls(
            jsonb_build_object(
              'resource', v_target_resource_key,
              'relation', NULLIF(btrim(COALESCE(v_target_resource->>'relation', '')), ''),
              'id_column', COALESCE(NULLIF(btrim(COALESCE(v_target_resource->>'id_column', '')), ''), 'id'),
              'label', NULLIF(btrim(COALESCE(v_target_resource->>'label', '')), ''),
              'label_column', v_label_column,
              'display_columns', CASE
                WHEN jsonb_typeof(v_display_columns) = 'array' AND jsonb_array_length(v_display_columns) > 0
                  THEN v_display_columns
                ELSE NULL
              END
            )
          );
          v_import := jsonb_set(v_import, '{reference}', v_reference, TRUE);
          v_column := jsonb_set(v_column, '{import}', v_import, TRUE);
        END IF;
      END IF;

      v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
    END LOOP;

    v_updated_resources := v_updated_resources || jsonb_build_array(
      jsonb_set(v_resource, '{columns}', v_updated_columns, TRUE)
    );
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', COALESCE(v_updated_resources, '[]'::jsonb), TRUE);
  v_current := public.ui_read_registry_enrich_reference_import_v1(v_current);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
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
           change_reason = 'Repair inline related-node reference contracts with canonical target resource metadata',
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

SELECT pg_advisory_unlock(hashtext('202603111110_tabular_import_related_node_reference_contract_fix_v1'));

COMMIT;
