-- Plan: PLAN-202604-b06-closeout / Step: Backfill shipment related-node reference contracts into active ui_read_registry settings rows

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102200_ui_read_registry_related_node_reference_backfill_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_updated_resources JSONB;
  v_resource JSONB;
  v_columns JSONB;
  v_updated_columns JSONB;
  v_column JSONB;
  v_resource_key TEXT;
  v_column_key TEXT;
  v_import JSONB;
  v_reference JSONB;
  v_target_resource_key TEXT;
  v_target_resource JSONB;
  v_display_columns JSONB;
  v_label_column TEXT;
BEGIN
  FOR v_setting IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_updated_resources := '[]'::jsonb;

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
          v_reference := v_reference || jsonb_build_object(
            'allow_inline_node', TRUE,
            'inline_node_key', 'recipient',
            'inline_node_label', 'Recipient',
            'mapping_prefixes', jsonb_build_array('recipient', 'recipient_'),
            'match_fields', jsonb_build_array('external_id', 'phone_number', 'email'),
            'create_mode', 'match_or_create'
          );
        ELSIF v_resource_key = 'shipments' AND v_column_key = 'destination_address_id' THEN
          v_target_resource_key := 'addresses';
          v_reference := v_reference || jsonb_build_object(
            'allow_inline_node', TRUE,
            'inline_node_key', 'destination_address',
            'inline_node_label', 'Destination address',
            'mapping_prefixes', jsonb_build_array('destination_address', 'destination', 'address'),
            'match_fields', jsonb_build_array('normalized_line1', 'city', 'postal_code', 'country'),
            'create_mode', 'match_or_create'
          );
        ELSIF v_resource_key = 'shipments' AND v_column_key = 'origin_address_id' THEN
          v_target_resource_key := 'addresses';
          v_reference := v_reference || jsonb_build_object(
            'allow_inline_node', TRUE,
            'inline_node_key', 'origin_address',
            'inline_node_label', 'Origin address',
            'mapping_prefixes', jsonb_build_array('origin_address', 'origin'),
            'match_fields', jsonb_build_array('normalized_line1', 'city', 'postal_code', 'country'),
            'create_mode', 'match_or_create'
          );
        END IF;

        IF v_target_resource_key IS NOT NULL THEN
          SELECT value
            INTO v_target_resource
            FROM jsonb_array_elements(v_resources) AS value
           WHERE NULLIF(btrim(COALESCE(value->>'key', '')), '') = v_target_resource_key
           LIMIT 1;

          IF v_target_resource IS NOT NULL THEN
            SELECT COALESCE(
                     jsonb_agg(to_jsonb(display_key) ORDER BY sort_order),
                     '[]'::jsonb
                   )
              INTO v_display_columns
              FROM (
                SELECT display_key, MIN(sort_order) AS sort_order
                  FROM (
                    SELECT NULLIF(btrim(value), '') AS display_key, ordinality AS sort_order
                      FROM jsonb_array_elements_text(COALESCE(v_target_resource->'select', '[]'::jsonb))
                           WITH ORDINALITY AS select_columns(value, ordinality)
                    UNION ALL
                    SELECT NULLIF(btrim(COALESCE(column_value.value->>'key', '')), '') AS display_key,
                           1000 + ordinality AS sort_order
                      FROM jsonb_array_elements(COALESCE(v_target_resource->'columns', '[]'::jsonb))
                           WITH ORDINALITY AS column_value(value, ordinality)
                  ) candidates
                 WHERE display_key IS NOT NULL
                   AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_resource->>'id_column', '')), ''), 'id')
                   AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_resource#>>'{scope_columns,tenant}', '')), ''), '__none__')
                   AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_resource#>>'{scope_columns,client}', '')), ''), '__none__')
                   AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_resource#>>'{scope_columns,sender}', '')), ''), '__none__')
                   AND display_key NOT IN ('created_at', 'updated_at')
                 GROUP BY display_key
                 ORDER BY MIN(sort_order)
                 LIMIT 3
              ) ranked;

            SELECT ranked.display_key
              INTO v_label_column
              FROM (
                SELECT display_key, MIN(sort_order) AS sort_order
                  FROM (
                    SELECT NULLIF(btrim(value), '') AS display_key, ordinality AS sort_order
                      FROM jsonb_array_elements_text(COALESCE(v_target_resource->'select', '[]'::jsonb))
                           WITH ORDINALITY AS select_columns(value, ordinality)
                    UNION ALL
                    SELECT NULLIF(btrim(COALESCE(column_value.value->>'key', '')), '') AS display_key,
                           1000 + ordinality AS sort_order
                      FROM jsonb_array_elements(COALESCE(v_target_resource->'columns', '[]'::jsonb))
                           WITH ORDINALITY AS column_value(value, ordinality)
                  ) candidates
                 WHERE display_key IS NOT NULL
                   AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_resource->>'id_column', '')), ''), 'id')
                   AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_resource#>>'{scope_columns,tenant}', '')), ''), '__none__')
                   AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_resource#>>'{scope_columns,client}', '')), ''), '__none__')
                   AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_resource#>>'{scope_columns,sender}', '')), ''), '__none__')
                   AND display_key NOT IN ('created_at', 'updated_at')
                 GROUP BY display_key
                 ORDER BY MIN(sort_order)
                 LIMIT 1
              ) ranked;

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

    v_current := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           version = v_setting.version + 1,
           change_reason = 'Backfill shipment related-node reference contracts into active ui_read_registry rows',
           approved_at = now(),
           effective_from = now()
     WHERE id = v_setting.settings_version_id
       AND v_current IS DISTINCT FROM v_setting.value;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE id = v_setting.settings_id
       AND v_current IS DISTINCT FROM v_setting.value;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202604102200_ui_read_registry_related_node_reference_backfill_v1'));

COMMIT;
