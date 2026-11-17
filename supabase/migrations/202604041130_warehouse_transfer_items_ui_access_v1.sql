-- Plan: PLAN-202604-b05-transfer-manifest-ui-closure / Step: S01
-- Migration: Warehouse transfer items UI access closure v1
-- Date: 2026-04-04
--
-- Goals:
--   - Expose warehouse_transfer_items through access_control_policy, ui_read_registry,
--     and ui_navigation so transfer manifest membership is visible in Console/Portal.
--   - Reuse existing warehouse_transfers capabilities instead of forking a second
--     manifest-membership capability family.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604041130_warehouse_transfer_items_ui_access_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) access_control_policy: wire warehouse_transfer_items to warehouse_transfers
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resource_map JSONB := '{}'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    v_resource_map := jsonb_set(
      v_resource_map,
      '{warehouse_transfer_items}',
      public.deep_merge_jsonb(
        jsonb_build_object(
          'read', 'warehouse_transfers.read',
          'write', 'warehouse_transfers.write'
        ),
        COALESCE(v_resource_map->'warehouse_transfer_items', '{}'::jsonb)
      ),
      TRUE
    );

    v_next := jsonb_set(v_current, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose warehouse transfer manifest membership through access_control_policy.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 2) ui_read_registry: add warehouse_transfer_items across all scopes
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB := NULL;
  v_resource_key TEXT := NULL;
  v_canonical_resource JSONB := jsonb_build_object(
    'key', 'warehouse_transfer_items',
    'label', 'Warehouse Transfer Items',
    'relation', 'public.warehouse_transfer_items',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'warehouse_transfers.read',
    'capability_write', 'warehouse_transfers.write',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'transfer_id',
      'client_id',
      'shipment_id',
      'added_by_user_id',
      'metadata',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'transfer_id', 'column', 'transfer_id', 'op', 'eq'),
      jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq'),
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'added_by_user_id', 'column', 'added_by_user_id', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'transfer_id', 'label', 'Transfer'),
      jsonb_build_object('key', 'client_id', 'label', 'Client'),
      jsonb_build_object('key', 'shipment_id', 'label', 'Shipment'),
      jsonb_build_object('key', 'added_by_user_id', 'label', 'Added by'),
      jsonb_build_object('key', 'created_at', 'label', 'Added at')
    ),
    'column_labels', jsonb_build_object(
      'transfer_id', 'Transfer',
      'client_id', 'Client',
      'shipment_id', 'Shipment',
      'added_by_user_id', 'Added by',
      'created_at', 'Added at'
    ),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_updated_resources := '[]'::jsonb;
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      v_resource_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');
      IF v_resource_key = 'warehouse_transfer_items' THEN
        v_resource := public.deep_merge_jsonb(v_canonical_resource, v_resource);
      END IF;
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_updated_resources) AS item
      WHERE item->>'key' = 'warehouse_transfer_items'
    ) THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_canonical_resource);
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose warehouse transfer manifest membership through ui_read_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 3) ui_navigation: add warehouse_transfer_items to operations navigation
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_source_sections JSONB := '[]'::jsonb;
  v_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB := '[]'::jsonb;
  v_has_operations BOOLEAN := FALSE;
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
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_source_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;
    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_source_sections) AS value
    LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE item->>'id' <> 'console-warehouse-transfer-items';
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || jsonb_build_array(v_console_item),
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', jsonb_build_array(v_console_item))
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', jsonb_build_array(v_console_item))
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_sections, TRUE);

    v_source_sections := COALESCE(v_next#>'{apps,portal,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;
    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_source_sections) AS value
    LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE item->>'id' <> 'portal-warehouse-transfer-items';
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

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
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', jsonb_build_array(v_portal_item))
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', jsonb_build_array(v_portal_item))
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_next, '{apps,portal,sections}', v_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose warehouse transfer manifest membership through ui_navigation.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604041130_warehouse_transfer_items_ui_access_v1'));
COMMIT;
