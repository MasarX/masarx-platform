-- Plan: PLAN-202603-b03-branch-intake-wave1 / Step: S05
-- pgTAP: Warehouse Batch 3 UI access + registry exposure v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(28);

CREATE OR REPLACE FUNCTION pg_temp.test_warehouse_batch3_ui_access_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_access JSONB := NULL;
  v_registry JSONB := NULL;
  v_navigation JSONB := NULL;
BEGIN
  SELECT cached_value
    INTO v_access
    FROM public.settings
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_navigation
    FROM public.settings
   WHERE category = 'ui_navigation'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT ok(v_access IS NOT NULL, 'access_control_policy global settings present');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'capabilities', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.read'
    ),
    'access_control_policy exposes warehouse_transfers.read capability'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'capabilities', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.write'
    ),
    'access_control_policy exposes warehouse_transfers.write capability'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'capabilities', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'handling_units.read'
    ),
    'access_control_policy exposes handling_units.read capability'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'capabilities', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'handling_units.write'
    ),
    'access_control_policy exposes handling_units.write capability'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'capabilities', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'scan_events.read'
    ),
    'access_control_policy exposes scan_events.read capability'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'roles', '[]'::jsonb)) AS role(value)
      WHERE role.value->>'key' = 'ops_admin'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(role.value->'capability_keys', '[]'::jsonb)) AS cap(value)
          WHERE cap.value = 'warehouse_transfers.read'
        )
    ),
    'ops_admin includes warehouse_transfers.read capability'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'roles', '[]'::jsonb)) AS role(value)
      WHERE role.value->>'key' = 'ops_admin'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(role.value->'capability_keys', '[]'::jsonb)) AS cap(value)
          WHERE cap.value = 'handling_units.read'
        )
    ),
    'ops_admin includes handling_units.read capability'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'roles', '[]'::jsonb)) AS role(value)
      WHERE role.value->>'key' = 'ops_admin'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(role.value->'capability_keys', '[]'::jsonb)) AS cap(value)
          WHERE cap.value = 'scan_events.read'
        )
    ),
    'ops_admin includes scan_events.read capability'
  );
  RETURN NEXT is(v_access#>>'{resource_map,warehouse_transfers,read}', 'warehouse_transfers.read', 'resource_map wires warehouse_transfers read capability');
  RETURN NEXT is(v_access#>>'{resource_map,handling_units,read}', 'handling_units.read', 'resource_map wires handling_units read capability');
  RETURN NEXT is(v_access#>>'{resource_map,scan_events,read}', 'scan_events.read', 'resource_map wires scan_events read capability');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'access_control_policy'
        AND s.scope_type IN ('tenant', 'client', 'sender')
        AND s.cached_value#>>'{resource_map,warehouse_transfers,read}' = 'warehouse_transfers.read'
        AND s.cached_value#>>'{resource_map,handling_units,read}' = 'handling_units.read'
        AND s.cached_value#>>'{resource_map,scan_events,read}' = 'scan_events.read'
    ),
    'scoped access_control_policy rows inherit Batch 3 resource map entries'
  );

  RETURN NEXT ok(v_registry IS NOT NULL, 'ui_read_registry global settings present');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers'
    ),
    'ui_read_registry includes warehouse_transfers resource'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'handling_units'
    ),
    'ui_read_registry includes handling_units resource'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'scan_events'
    ),
    'ui_read_registry includes scan_events resource'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS item(value)
      WHERE s.category = 'ui_read_registry'
        AND s.scope_type IN ('tenant', 'client', 'sender')
        AND item.value->>'key' IN ('warehouse_transfers', 'handling_units', 'scan_events')
      GROUP BY s.id
      HAVING COUNT(DISTINCT item.value->>'key') = 3
    ),
    'scoped ui_read_registry rows include Batch 3 resources'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers'
        AND item.value#>>'{column_labels,unmanifested_shipment_count}' = 'Unmanifested exceptions'
        AND item.value#>>'{column_labels,missing_shipment_count}' = 'Missing shipment incidents'
        AND item.value#>>'{column_labels,damaged_shipment_count}' = 'Damage alerts'
    ),
    'warehouse_transfers registry includes exception signal labels'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'scan_events'
        AND item.value#>>'{column_labels,correction_approval_task_id}' = 'Manual review approval task'
        AND item.value#>>'{column_labels,correction_reason}' = 'Correction exception reason'
    ),
    'scan_events registry includes manual review exception labels'
  );

  RETURN NEXT ok(v_navigation IS NOT NULL, 'ui_navigation global settings present');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'warehouse_transfers'
    ),
    'console operations navigation includes warehouse_transfers'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'handling_units'
    ),
    'console operations navigation includes handling_units'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'scan_events'
    ),
    'console operations navigation includes scan_events'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,portal,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'warehouse_transfers'
    ),
    'portal operations navigation includes warehouse_transfers'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,portal,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'handling_units'
    ),
    'portal operations navigation includes handling_units'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,portal,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'scan_events'
    ),
    'portal operations navigation includes scan_events'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'ui_navigation'
        AND s.scope_type IN ('tenant', 'client', 'sender')
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
          WHERE section.value->>'id' = 'operations'
            AND item.value->>'resource' IN ('warehouse_transfers', 'handling_units', 'scan_events')
          GROUP BY section.value
          HAVING COUNT(DISTINCT item.value->>'resource') = 3
        )
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(s.cached_value#>'{apps,portal,sections}', '[]'::jsonb)) AS section(value)
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
          WHERE section.value->>'id' = 'operations'
            AND item.value->>'resource' IN ('warehouse_transfers', 'handling_units', 'scan_events')
          GROUP BY section.value
          HAVING COUNT(DISTINCT item.value->>'resource') = 3
        )
    ),
    'scoped ui_navigation rows expose Batch 3 resources in console and portal operations'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_warehouse_batch3_ui_access_v1();

SELECT * FROM finish();
ROLLBACK;
