-- Plan: PLAN-202603-b03-branch-intake-wave1 / Step: S05
-- Migration: Warehouse Batch 3 UI access + registry exposure v1
-- Date: 2026-03-19
--
-- Goals:
--   - Expose warehouse Batch 3 resources through access_control_policy, ui_read_registry, and ui_navigation.
--   - Keep Console/Portal route-operations workspace row-driven by settings, not app-specific hardcoding.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191725_warehouse_batch3_ui_access_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) access_control_policy: capabilities + roles + resource map
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_current JSONB := NULL;
  v_caps JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_cap JSONB;
  v_role JSONB;
  v_new_caps JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'warehouse_transfers.read',
      'label', 'Warehouse transfers read',
      'category', 'operations',
      'description', 'Read warehouse transfer intake and reconciliation records.'
    ),
    jsonb_build_object(
      'key', 'warehouse_transfers.write',
      'label', 'Warehouse transfers write',
      'category', 'operations',
      'description', 'Create and update warehouse transfer intake records.'
    ),
    jsonb_build_object(
      'key', 'handling_units.read',
      'label', 'Handling units read',
      'category', 'operations',
      'description', 'Read handling-unit inventory and chain-of-custody records.'
    ),
    jsonb_build_object(
      'key', 'handling_units.write',
      'label', 'Handling units write',
      'category', 'operations',
      'description', 'Create and update handling-unit inventory records.'
    ),
    jsonb_build_object(
      'key', 'scan_events.read',
      'label', 'Scan events read',
      'category', 'operations',
      'description', 'Read warehouse and FieldOps scan-event ledgers.'
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL OR jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'warehouse_batch3_ui_access_v1: access_control_policy global settings missing';
  END IF;

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
    v_caps := '[]'::jsonb;
  END IF;

  FOR v_cap IN
    SELECT value
    FROM jsonb_array_elements(v_new_caps) AS value
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_caps) AS item
      WHERE item->>'key' = v_cap->>'key'
    ) THEN
      v_caps := v_caps || jsonb_build_array(v_cap);
    END IF;
  END LOOP;

  FOR v_role IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(v_current->'roles', '[]'::jsonb)) AS value
  LOOP
    IF v_role->>'key' = 'ops_admin' THEN
      v_role := jsonb_set(
        v_role,
        '{capability_keys}',
        to_jsonb(ARRAY(
          SELECT DISTINCT cap
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(v_role->'capability_keys', '[]'::jsonb)) AS cap
            UNION ALL
            SELECT unnest(ARRAY[
              'warehouse_transfers.read',
              'warehouse_transfers.write',
              'handling_units.read',
              'handling_units.write',
              'scan_events.read'
            ]) AS cap
          ) AS caps
          ORDER BY cap
        )),
        FALSE
      );
    END IF;

    v_roles := v_roles || jsonb_build_array(v_role);
  END LOOP;

  v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
  IF NOT (v_resource_map ? 'warehouse_transfers') THEN
    v_resource_map := jsonb_set(
      v_resource_map,
      '{warehouse_transfers}',
      jsonb_build_object(
        'read', 'warehouse_transfers.read',
        'write', 'warehouse_transfers.write'
      ),
      TRUE
    );
  END IF;
  IF NOT (v_resource_map ? 'handling_units') THEN
    v_resource_map := jsonb_set(
      v_resource_map,
      '{handling_units}',
      jsonb_build_object(
        'read', 'handling_units.read',
        'write', 'handling_units.write'
      ),
      TRUE
    );
  END IF;
  IF NOT (v_resource_map ? 'scan_events') THEN
    v_resource_map := jsonb_set(
      v_resource_map,
      '{scan_events}',
      jsonb_build_object(
        'read', 'scan_events.read',
        'write', 'scan_events.write'
      ),
      TRUE
    );
  END IF;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps, TRUE);
  v_current := jsonb_set(v_current, '{roles}', v_roles, TRUE);
  v_current := jsonb_set(v_current, '{resource_map}', v_resource_map, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Expose warehouse Batch 3 resources through access_control_policy',
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
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END;
$do$;

-------------------------------------------------------------------------------
-- 2) ui_read_registry: add warehouse_transfers + handling_units + scan_events
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_current JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_new JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'warehouse_transfers',
      'label', 'Warehouse Transfers',
      'relation', 'public.warehouse_transfers',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'warehouse_transfers.read',
      'capability_write', 'warehouse_transfers.write',
      'select', jsonb_build_array(
        'id',
        'organization_id',
        'from_branch_id',
        'to_branch_id',
        'status',
        'transfer_code',
        'vehicle_id',
        'driver_user_id',
        'created_by_user_id',
        'planned_dispatch_at',
        'planned_receive_at',
        'dispatched_at',
        'received_at',
        'reconciled_at',
        'received_shipment_count',
        'damaged_shipment_count',
        'missing_shipment_count',
        'unmanifested_shipment_count',
        'metadata',
        'created_at',
        'updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'transfer_code', 'column', 'transfer_code', 'op', 'ilike'),
        jsonb_build_object('key', 'from_branch_id', 'column', 'from_branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'to_branch_id', 'column', 'to_branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'handling_units',
      'label', 'Handling Units',
      'relation', 'public.handling_units',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'handling_units.read',
      'capability_write', 'handling_units.write',
      'select', jsonb_build_array(
        'id',
        'organization_id',
        'branch_id',
        'unit_type',
        'status',
        'code',
        'metadata',
        'created_at',
        'updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'unit_type', 'column', 'unit_type', 'op', 'eq'),
        jsonb_build_object('key', 'code', 'column', 'code', 'op', 'ilike'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'scan_events',
      'label', 'Scan Events',
      'relation', 'public.scan_events',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id'),
      'capability_read', 'scan_events.read',
      'capability_write', 'scan_events.write',
      'select', jsonb_build_array(
        'id',
        'organization_id',
        'actor_user_id',
        'device_id',
        'route_run_id',
        'route_stop_id',
        'branch_id',
        'client_id',
        'shipment_id',
        'handling_unit_id',
        'warehouse_transfer_id',
        'ops_session_id',
        'scan_type',
        'barcode',
        'checkpoint_key',
        'checkpoint_sequence',
        'correction_of_scan_event_id',
        'correction_reason',
        'correction_approval_task_id',
        'metadata',
        'captured_at',
        'received_at',
        'created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'scan_type', 'column', 'scan_type', 'op', 'eq'),
        jsonb_build_object('key', 'barcode', 'column', 'barcode', 'op', 'ilike'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
        jsonb_build_object('key', 'handling_unit_id', 'column', 'handling_unit_id', 'op', 'eq'),
        jsonb_build_object('key', 'warehouse_transfer_id', 'column', 'warehouse_transfer_id', 'op', 'eq'),
        jsonb_build_object('key', 'checkpoint_key', 'column', 'checkpoint_key', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'captured_at', 'direction', 'desc')
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

  IF v_current IS NULL OR jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'warehouse_batch3_ui_access_v1: ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    v_resources := '[]'::jsonb;
  END IF;

  FOR v_resource IN
    SELECT value
    FROM jsonb_array_elements(v_new) AS value
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
      WHERE item->>'key' = v_resource->>'key'
    ) THEN
      v_resources := v_resources || jsonb_build_array(v_resource);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

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
           change_reason = 'Expose warehouse Batch 3 resources through ui_read_registry',
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
END;
$do$;

-------------------------------------------------------------------------------
-- 3) ui_navigation: expose resources in Console + Portal operations sections
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_current JSONB := NULL;
  v_sections JSONB := '[]'::jsonb;
  v_base JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_candidate JSONB;
  v_has_operations BOOLEAN := FALSE;
  v_console_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-warehouse-transfers',
      'label', 'Warehouse Transfers',
      'href', '/console/resources/warehouse_transfers',
      'resource', 'warehouse_transfers',
      'capability', 'warehouse_transfers.read'
    ),
    jsonb_build_object(
      'id', 'console-handling-units',
      'label', 'Handling Units',
      'href', '/console/resources/handling_units',
      'resource', 'handling_units',
      'capability', 'handling_units.read'
    ),
    jsonb_build_object(
      'id', 'console-scan-events',
      'label', 'Scan Events',
      'href', '/console/resources/scan_events',
      'resource', 'scan_events',
      'capability', 'scan_events.read'
    )
  );
  v_portal_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-warehouse-transfers',
      'label', 'Warehouse Transfers',
      'href', '/portal/resources/warehouse_transfers',
      'resource', 'warehouse_transfers',
      'capability', 'warehouse_transfers.read'
    ),
    jsonb_build_object(
      'id', 'portal-handling-units',
      'label', 'Handling Units',
      'href', '/portal/resources/handling_units',
      'resource', 'handling_units',
      'capability', 'handling_units.read'
    ),
    jsonb_build_object(
      'id', 'portal-scan-events',
      'label', 'Scan Events',
      'href', '/portal/resources/scan_events',
      'resource', 'scan_events',
      'capability', 'scan_events.read'
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL OR jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'warehouse_batch3_ui_access_v1: ui_navigation global settings missing';
  END IF;

  v_base := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
  v_sections := '[]'::jsonb;
  v_has_operations := FALSE;

  FOR v_section IN
    SELECT value
    FROM jsonb_array_elements(v_base) AS value
  LOOP
    IF v_section->>'id' = 'operations' THEN
      v_has_operations := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN
        SELECT value
        FROM jsonb_array_elements(v_console_items) AS value
      LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_items) AS item
          WHERE item->>'id' = v_candidate->>'id'
        ) THEN
          v_items := v_items || jsonb_build_array(v_candidate);
        END IF;
      END LOOP;
      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
    END IF;

    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_operations IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'operations',
        'label', 'Operations',
        'items', v_console_items
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, TRUE);

  v_base := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);
  v_sections := '[]'::jsonb;
  v_has_operations := FALSE;

  FOR v_section IN
    SELECT value
    FROM jsonb_array_elements(v_base) AS value
  LOOP
    IF v_section->>'id' = 'operations' THEN
      v_has_operations := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN
        SELECT value
        FROM jsonb_array_elements(v_portal_items) AS value
      LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_items) AS item
          WHERE item->>'id' = v_candidate->>'id'
        ) THEN
          v_items := v_items || jsonb_build_array(v_candidate);
        END IF;
      END LOOP;
      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
    END IF;

    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_operations IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'operations',
        'label', 'Operations',
        'items', v_portal_items
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,portal,sections}', v_sections, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Expose warehouse Batch 3 resources through ui_navigation',
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
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202603191725_warehouse_batch3_ui_access_v1'));
COMMIT;
