-- Plan: PLAN-202603-resource-import-related-node-graph / Step: S04
-- Migration: Restore shipment inline related-node reference metadata at read time

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101320_ui_registry_inline_related_node_reference_restore_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_read_registry_enrich_inline_related_node_import_v1(
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_current JSONB := COALESCE(p_value, '{}'::jsonb);
  v_resources JSONB := COALESCE(v_current->'resources', '[]'::jsonb);
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_resource_key TEXT;
  v_columns JSONB;
  v_updated_columns JSONB;
  v_column JSONB;
  v_column_key TEXT;
  v_column_import JSONB;
  v_reference JSONB;
  v_target_resource_key TEXT;
  v_target_resource JSONB;
  v_target_scope_columns JSONB;
  v_target_id_column TEXT;
  v_display_columns JSONB;
  v_label_column TEXT;
  v_inline_defaults JSONB;
BEGIN
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RETURN v_current;
  END IF;

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
      v_target_resource_key := NULL;
      v_inline_defaults := NULL;

      IF v_resource_key = 'shipments' AND v_column_key = 'recipient_id' THEN
        v_target_resource_key := 'recipients';
        v_inline_defaults := jsonb_build_object(
          'allow_inline_node', TRUE,
          'inline_node_key', 'recipient',
          'inline_node_label', 'Recipient',
          'mapping_prefixes', jsonb_build_array('recipient', 'recipient_'),
          'match_fields', jsonb_build_array('external_id', 'phone_number', 'email'),
          'create_mode', 'match_or_create'
        );
      ELSIF v_resource_key = 'shipments' AND v_column_key = 'destination_address_id' THEN
        v_target_resource_key := 'addresses';
        v_inline_defaults := jsonb_build_object(
          'allow_inline_node', TRUE,
          'inline_node_key', 'destination_address',
          'inline_node_label', 'Destination address',
          'mapping_prefixes', jsonb_build_array('destination_address', 'destination', 'address'),
          'match_fields', jsonb_build_array('normalized_line1', 'city', 'postal_code', 'country'),
          'create_mode', 'match_or_create'
        );
      ELSIF v_resource_key = 'shipments' AND v_column_key = 'origin_address_id' THEN
        v_target_resource_key := 'addresses';
        v_inline_defaults := jsonb_build_object(
          'allow_inline_node', TRUE,
          'inline_node_key', 'origin_address',
          'inline_node_label', 'Origin address',
          'mapping_prefixes', jsonb_build_array('origin_address', 'origin'),
          'match_fields', jsonb_build_array('normalized_line1', 'city', 'postal_code', 'country'),
          'create_mode', 'match_or_create'
        );
      END IF;

      IF v_target_resource_key IS NULL THEN
        v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
        CONTINUE;
      END IF;

      SELECT value
        INTO v_target_resource
        FROM jsonb_array_elements(v_resources) AS value
       WHERE NULLIF(btrim(COALESCE(value->>'key', '')), '') = v_target_resource_key
       LIMIT 1;

      IF v_target_resource IS NULL THEN
        v_updated_columns := v_updated_columns || jsonb_build_array(v_column);
        CONTINUE;
      END IF;

      v_target_scope_columns := COALESCE(v_target_resource->'scope_columns', '{}'::jsonb);
      v_target_id_column := COALESCE(
        NULLIF(btrim(COALESCE(v_target_resource->>'id_column', '')), ''),
        'id'
      );

      SELECT COALESCE(jsonb_agg(to_jsonb(display_key) ORDER BY sort_order), '[]'::jsonb)
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
            AND display_key <> v_target_id_column
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'tenant', '')), ''), '__none__')
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'client', '')), ''), '__none__')
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'sender', '')), ''), '__none__')
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
            AND display_key <> v_target_id_column
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'tenant', '')), ''), '__none__')
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'client', '')), ''), '__none__')
            AND display_key <> COALESCE(NULLIF(btrim(COALESCE(v_target_scope_columns->>'sender', '')), ''), '__none__')
            AND display_key NOT IN ('created_at', 'updated_at')
          GROUP BY display_key
          ORDER BY MIN(sort_order)
          LIMIT 1
        ) ranked;

      v_column_import := COALESCE(v_column->'import', '{}'::jsonb);
      IF jsonb_typeof(v_column_import) IS DISTINCT FROM 'object' THEN
        v_column_import := '{}'::jsonb;
      END IF;

      v_reference := COALESCE(v_column_import->'reference', '{}'::jsonb);
      IF jsonb_typeof(v_reference) IS DISTINCT FROM 'object' THEN
        v_reference := '{}'::jsonb;
      END IF;

      v_reference := jsonb_strip_nulls(
        jsonb_build_object(
          'resource', v_target_resource_key,
          'relation', NULLIF(btrim(COALESCE(v_target_resource->>'relation', '')), ''),
          'id_column', v_target_id_column,
          'label', NULLIF(btrim(COALESCE(v_target_resource->>'label', '')), ''),
          'label_column', NULLIF(btrim(COALESCE(v_label_column, '')), ''),
          'display_columns', CASE
            WHEN jsonb_typeof(v_display_columns) = 'array' AND jsonb_array_length(v_display_columns) > 0
              THEN v_display_columns
            ELSE NULL
          END
        )
      ) || COALESCE(v_inline_defaults, '{}'::jsonb) || v_reference;

      v_column_import := jsonb_set(v_column_import, '{reference}', jsonb_strip_nulls(v_reference), TRUE);

      v_updated_columns := v_updated_columns || jsonb_build_array(
        jsonb_set(v_column, '{import}', v_column_import, TRUE)
      );
    END LOOP;

    v_updated_resources := v_updated_resources || jsonb_build_array(
      jsonb_set(v_resource, '{columns}', COALESCE(v_updated_columns, '[]'::jsonb), TRUE)
    );
  END LOOP;

  RETURN jsonb_set(v_current, '{resources}', COALESCE(v_updated_resources, '[]'::jsonb), TRUE);
END;
$function$;

COMMENT ON FUNCTION public.ui_read_registry_enrich_inline_related_node_import_v1(JSONB)
  IS 'Restore canonical inline related-node import contracts for shipment recipient and address references after generic reference enrichment.';

CREATE OR REPLACE FUNCTION public.ui_read_registry_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB;
BEGIN
  v_registry := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  RETURN public.ui_read_registry_enrich_inline_related_node_import_v1(
    public.ui_read_registry_enrich_reference_import_v1(
      public.ui_read_registry_enrich_lookup_import_v1(
        public.ui_read_registry_apply_required_import_contracts_v1(
          public.normalize_ui_read_registry_import_v1(v_registry)
        )
      )
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_read_registry_enrich_inline_related_node_import_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_enrich_inline_related_node_import_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604101320_ui_registry_inline_related_node_reference_restore_v1'));

COMMIT;
