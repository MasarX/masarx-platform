-- Plan: PLAN-202604-production-readiness-coverage-closure / Step: warehouse transfer items navigation restore
-- Purpose:
--   - Restore warehouse transfer manifest item discoverability across Console and Portal.
--   - Preserve grouped Console operations navigation and avoid duplicate nav entries.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('20261122029014_warehouse_transfer_items_navigation_restore_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE FUNCTION pg_temp.b26_nav_resource_exists(
  p_sections JSONB,
  p_resource TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  WITH RECURSIVE nav_items AS (
    SELECT item.value AS item
    FROM jsonb_array_elements(COALESCE(p_sections, '[]'::jsonb)) AS section(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
    UNION ALL
    SELECT child.value AS item
    FROM nav_items parent
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(parent.item->'items', '[]'::jsonb)) AS child(value)
  )
  SELECT EXISTS (
    SELECT 1
    FROM nav_items
    WHERE item->>'resource' = p_resource
  );
$function$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_source_sections JSONB;
  v_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_item JSONB;
  v_next_items JSONB;
  v_has_operations BOOLEAN;
  v_has_warehouse_group BOOLEAN;
  v_console_item JSONB := jsonb_build_object(
    'id', 'console-warehouse-transfer-items',
    'label', 'Warehouse Transfer Items',
    'href', '/console/resources/warehouse_transfer_items',
    'resource', 'warehouse_transfer_items',
    'capability', 'warehouse_transfers.read'
  );
  v_portal_item JSONB := jsonb_build_object(
    'id', 'portal-warehouse-transfer-items',
    'label', 'Warehouse Transfer Items',
    'href', '/portal/resources/warehouse_transfer_items',
    'resource', 'warehouse_transfer_items',
    'capability', 'warehouse_transfers.read'
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.schema_version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_navigation'
    ORDER BY s.id
    FOR UPDATE OF s, sv
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_next := v_current;

    v_source_sections := COALESCE(v_next#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    IF pg_temp.b26_nav_resource_exists(v_source_sections, 'warehouse_transfer_items') IS FALSE THEN
      v_sections := '[]'::jsonb;
      v_has_operations := FALSE;

      FOR v_section IN
        SELECT value
        FROM jsonb_array_elements(v_source_sections) AS value
      LOOP
        IF v_section->>'id' = 'operations' THEN
          v_has_operations := TRUE;
          v_items := COALESCE(v_section->'items', '[]'::jsonb);
          v_next_items := '[]'::jsonb;
          v_has_warehouse_group := FALSE;

          FOR v_item IN
            SELECT value
            FROM jsonb_array_elements(v_items) AS value
          LOOP
            IF v_item->>'id' = 'ops-group-warehouse' THEN
              v_has_warehouse_group := TRUE;
              v_item := jsonb_set(
                v_item,
                '{items}',
                COALESCE(v_item->'items', '[]'::jsonb) || jsonb_build_array(v_console_item),
                TRUE
              );
            END IF;

            v_next_items := v_next_items || jsonb_build_array(v_item);
          END LOOP;

          IF v_has_warehouse_group IS FALSE THEN
            v_next_items := v_next_items || jsonb_build_array(v_console_item);
          END IF;

          v_section := jsonb_set(v_section, '{items}', v_next_items, TRUE);
        END IF;

        v_sections := v_sections || jsonb_build_array(v_section);
      END LOOP;

      IF v_has_operations IS FALSE THEN
        IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
          v_sections := jsonb_build_array(
            v_sections->0,
            jsonb_build_object(
              'id', 'operations',
              'label', 'Operations',
              'icon', 'truck',
              'items', jsonb_build_array(
                jsonb_build_object(
                  'id', 'ops-group-warehouse',
                  'label', 'Warehouse',
                  'items', jsonb_build_array(v_console_item)
                )
              )
            )
          ) || (v_sections - 0);
        ELSE
          v_sections := jsonb_build_array(
            jsonb_build_object(
              'id', 'operations',
              'label', 'Operations',
              'icon', 'truck',
              'items', jsonb_build_array(
                jsonb_build_object(
                  'id', 'ops-group-warehouse',
                  'label', 'Warehouse',
                  'items', jsonb_build_array(v_console_item)
                )
              )
            )
          ) || v_sections;
        END IF;
      END IF;

      v_next := jsonb_set(v_next, '{apps,console,sections}', v_sections, TRUE);
    END IF;

    v_source_sections := COALESCE(v_next#>'{apps,portal,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    IF pg_temp.b26_nav_resource_exists(v_source_sections, 'warehouse_transfer_items') IS FALSE THEN
      v_sections := '[]'::jsonb;
      v_has_operations := FALSE;

      FOR v_section IN
        SELECT value
        FROM jsonb_array_elements(v_source_sections) AS value
      LOOP
        IF v_section->>'id' = 'operations' THEN
          v_has_operations := TRUE;
          v_section := jsonb_set(
            v_section,
            '{items}',
            COALESCE(v_section->'items', '[]'::jsonb) || jsonb_build_array(v_portal_item),
            TRUE
          );
        END IF;

        v_sections := v_sections || jsonb_build_array(v_section);
      END LOOP;

      IF v_has_operations IS FALSE THEN
        IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
          v_sections := jsonb_build_array(
            v_sections->0,
            jsonb_build_object(
              'id', 'operations',
              'label', 'Operations',
              'icon', 'truck',
              'items', jsonb_build_array(v_portal_item)
            )
          ) || (v_sections - 0);
        ELSE
          v_sections := jsonb_build_array(
            jsonb_build_object(
              'id', 'operations',
              'label', 'Operations',
              'icon', 'truck',
              'items', jsonb_build_array(v_portal_item)
            )
          ) || v_sections;
        END IF;
      END IF;

      v_next := jsonb_set(v_next, '{apps,portal,sections}', v_sections, TRUE);
    END IF;

    IF v_next IS DISTINCT FROM v_current THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_navigation', v_row.scope_type, v_row.scope_id,
        v_next, v_row.schema_version, 'Restore warehouse transfer manifest item navigation.'
      );
    END IF;
  END LOOP;
END;
$do$;


DROP FUNCTION pg_temp.b26_nav_resource_exists(JSONB, TEXT);
COMMIT;
