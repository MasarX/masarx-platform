-- Plan: PLAN-202603-b03-branch-intake-wave1 / Step: S05
-- Migration: Warehouse Batch 3 UI access scope sync + exception metadata v1
-- Date: 2026-03-19
--
-- Goals:
--   - Backfill Batch 3 access_control_policy, ui_read_registry, and ui_navigation
--     exposure into every scoped settings row, not only global.
--   - Keep the route/exceptions workspace row-driven by registry metadata rather
--     than app-side hardcoding.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191910_warehouse_batch3_ui_access_scope_sync_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) access_control_policy: sync Batch 3 capabilities + role caps + resource map
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
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

    v_roles := '[]'::jsonb;
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
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    v_resource_map := jsonb_set(
      v_resource_map,
      '{warehouse_transfers}',
      public.deep_merge_jsonb(
        jsonb_build_object(
          'read', 'warehouse_transfers.read',
          'write', 'warehouse_transfers.write'
        ),
        COALESCE(v_resource_map->'warehouse_transfers', '{}'::jsonb)
      ),
      TRUE
    );
    v_resource_map := jsonb_set(
      v_resource_map,
      '{handling_units}',
      public.deep_merge_jsonb(
        jsonb_build_object(
          'read', 'handling_units.read',
          'write', 'handling_units.write'
        ),
        COALESCE(v_resource_map->'handling_units', '{}'::jsonb)
      ),
      TRUE
    );
    v_resource_map := jsonb_set(
      v_resource_map,
      '{scan_events}',
      public.deep_merge_jsonb(
        jsonb_build_object(
          'read', 'scan_events.read',
          'write', 'scan_events.write'
        ),
        COALESCE(v_resource_map->'scan_events', '{}'::jsonb)
      ),
      TRUE
    );

    v_next := jsonb_set(v_current, '{capabilities}', v_caps, TRUE);
    v_next := jsonb_set(v_next, '{roles}', v_roles, TRUE);
    v_next := jsonb_set(v_next, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Sync warehouse Batch 3 access exposure into scoped access_control_policy rows.',
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
-- 2) ui_read_registry: sync Batch 3 resources into every scope + add exception
--    metadata so /operations/exceptions can discover warehouse lanes.
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_global JSONB := NULL;
  v_canonical_resources JSONB := '{}'::jsonb;
  v_canonical_resource JSONB := NULL;
  v_patch JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_resource_key TEXT := NULL;
  v_target_key TEXT := NULL;
  v_next JSONB := NULL;
BEGIN
  SELECT sv.value
    INTO v_global
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_global IS NULL OR jsonb_typeof(v_global) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'warehouse_batch3_ui_access_scope_sync_v1: ui_read_registry global settings missing';
  END IF;

  FOREACH v_target_key IN ARRAY ARRAY['warehouse_transfers', 'handling_units', 'scan_events']
  LOOP
    SELECT item
      INTO v_canonical_resource
      FROM jsonb_array_elements(COALESCE(v_global->'resources', '[]'::jsonb)) AS item
     WHERE item->>'key' = v_target_key
     LIMIT 1;

    IF v_canonical_resource IS NULL THEN
      RAISE EXCEPTION 'warehouse_batch3_ui_access_scope_sync_v1: global ui_read_registry resource missing for %', v_target_key;
    END IF;

    v_patch := '{}'::jsonb;
    IF v_target_key = 'warehouse_transfers' THEN
      v_patch := jsonb_build_object(
        'columns', jsonb_build_array(
          jsonb_build_object('key', 'status', 'label', 'Transfer status'),
          jsonb_build_object('key', 'planned_receive_at', 'label', 'Receive deadline'),
          jsonb_build_object('key', 'driver_user_id', 'label', 'Assigned driver'),
          jsonb_build_object('key', 'damaged_shipment_count', 'label', 'Damage alerts'),
          jsonb_build_object('key', 'missing_shipment_count', 'label', 'Missing shipment incidents'),
          jsonb_build_object('key', 'unmanifested_shipment_count', 'label', 'Unmanifested exceptions')
        ),
        'column_labels', jsonb_build_object(
          'status', 'Transfer status',
          'planned_receive_at', 'Receive deadline',
          'driver_user_id', 'Assigned driver',
          'damaged_shipment_count', 'Damage alerts',
          'missing_shipment_count', 'Missing shipment incidents',
          'unmanifested_shipment_count', 'Unmanifested exceptions'
        )
      );
    ELSIF v_target_key = 'scan_events' THEN
      v_patch := jsonb_build_object(
        'columns', jsonb_build_array(
          jsonb_build_object('key', 'checkpoint_key', 'label', 'Checkpoint issue'),
          jsonb_build_object('key', 'correction_reason', 'label', 'Correction exception reason'),
          jsonb_build_object('key', 'correction_approval_task_id', 'label', 'Manual review approval task'),
          jsonb_build_object('key', 'actor_user_id', 'label', 'Assigned operator'),
          jsonb_build_object('key', 'captured_at', 'label', 'Incident captured at')
        ),
        'column_labels', jsonb_build_object(
          'checkpoint_key', 'Checkpoint issue',
          'correction_reason', 'Correction exception reason',
          'correction_approval_task_id', 'Manual review approval task',
          'actor_user_id', 'Assigned operator',
          'captured_at', 'Incident captured at'
        )
      );
    END IF;

    v_canonical_resources := jsonb_set(
      v_canonical_resources,
      ARRAY[v_target_key],
      public.deep_merge_jsonb(v_canonical_resource, v_patch),
      TRUE
    );
  END LOOP;

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
      IF v_resource_key IS NOT NULL AND (v_canonical_resources ? v_resource_key) THEN
        v_resource := public.deep_merge_jsonb(v_canonical_resources->v_resource_key, v_resource);
      END IF;
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END LOOP;

    FOREACH v_target_key IN ARRAY ARRAY['warehouse_transfers', 'handling_units', 'scan_events']
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_updated_resources) AS item
        WHERE item->>'key' = v_target_key
      ) THEN
        v_updated_resources := v_updated_resources || jsonb_build_array(v_canonical_resources->v_target_key);
      END IF;
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Sync warehouse Batch 3 resources into scoped ui_read_registry rows.',
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
-- 3) ui_navigation: sync Console + Portal operations items into every scope
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
    FOR v_section IN SELECT * FROM jsonb_array_elements(v_source_sections) LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE item->>'id' NOT IN (
           'console-warehouse-transfers',
           'console-handling-units',
           'console-scan-events'
         );
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || v_console_items,
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_console_items)
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_console_items)
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
    FOR v_section IN SELECT * FROM jsonb_array_elements(v_source_sections) LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE item->>'id' NOT IN (
           'portal-warehouse-transfers',
           'portal-handling-units',
           'portal-scan-events'
         );
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || v_portal_items,
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_portal_items)
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_portal_items)
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_next, '{apps,portal,sections}', v_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Sync warehouse Batch 3 navigation into scoped ui_navigation rows.',
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

SELECT pg_advisory_unlock(hashtext('202603191910_warehouse_batch3_ui_access_scope_sync_v1'));
COMMIT;
