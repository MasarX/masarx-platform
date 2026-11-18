-- pgTAP: Console V2 warehouse scan correction UI contract v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_warehouse_scan_correction_ui_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_registry JSONB := NULL;
  v_scan_resource JSONB := NULL;
  v_public_def TEXT := pg_get_functiondef(
    'public.ui_request_warehouse_scan_correction_v1(uuid, text, text, jsonb)'::regprocedure
  );
BEGIN
  RETURN NEXT has_view(
    'public',
    'warehouse_checkpoint_scans',
    'warehouse_checkpoint_scans projection exists'
  );
  RETURN NEXT has_column('public', 'warehouse_checkpoint_scans', 'scan_type', 'checkpoint scan projection exposes scan_type');
  RETURN NEXT has_column('public', 'warehouse_checkpoint_scans', 'barcode', 'checkpoint scan projection exposes barcode');
  RETURN NEXT has_column('public', 'warehouse_checkpoint_scans', 'correction_of_scan_event_id', 'checkpoint scan projection exposes correction_of_scan_event_id');
  RETURN NEXT has_column('public', 'warehouse_checkpoint_scans', 'correction_reason', 'checkpoint scan projection exposes correction_reason');
  RETURN NEXT has_column('public', 'warehouse_checkpoint_scans', 'correction_approval_task_id', 'checkpoint scan projection exposes correction_approval_task_id');

  RETURN NEXT has_function(
    'public',
    'ui_request_warehouse_scan_correction_v1',
    ARRAY['uuid', 'text', 'text', 'jsonb'],
    'public.ui_request_warehouse_scan_correction_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_request_warehouse_scan_correction_v1',
    ARRAY['uuid', 'text', 'text', 'jsonb'],
    'api.ui_request_warehouse_scan_correction_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'public.ui_request_warehouse_scan_correction_v1(uuid, text, text, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute public scan correction request wrapper'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_request_warehouse_scan_correction_v1(uuid, text, text, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api scan correction request wrapper'
  );
  RETURN NEXT ok(
    NOT has_function_privilege(
      'anon',
      'public.ui_request_warehouse_scan_correction_v1(uuid, text, text, jsonb)',
      'EXECUTE'
    ),
    'anon cannot execute public scan correction request wrapper'
  );

  RETURN NEXT ok(
    position('create_task_system_v1' IN v_public_def) > 0
      AND position('warehouse_scan_supervisor_approval' IN v_public_def) > 0
      AND position('''role'', ''service_role''' IN v_public_def) > 0,
    'public scan correction wrapper creates supervisor approval tasks through guarded service claim'
  );
  RETURN NEXT ok(
    position('ui_get_resource_v1(''warehouse_checkpoint_scans''' IN v_public_def) > 0,
    'public scan correction wrapper validates scan visibility through ui_get_resource_v1'
  );

  SELECT COALESCE(s.cached_value, sv.value, '{}'::jsonb)
    INTO v_registry
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
   LIMIT 1;

  SELECT item.value
    INTO v_scan_resource
    FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
   WHERE item.value->>'key' = 'warehouse_checkpoint_scans'
   LIMIT 1;

  RETURN NEXT ok(
    v_scan_resource->>'relation' = 'public.warehouse_checkpoint_scans'
      AND v_scan_resource->>'capability_read' = 'warehouse.read',
    'ui_read_registry maps warehouse_checkpoint_scans to the correction-aware projection'
  );
  RETURN NEXT ok(
    COALESCE(v_scan_resource->'select', '[]'::jsonb) ? 'correction_reason'
      AND COALESCE(v_scan_resource->'select', '[]'::jsonb) ? 'correction_approval_task_id',
    'ui_read_registry exposes scan correction fields'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_scan_resource->'filters', '[]'::jsonb)) AS filter(value)
      WHERE filter.value->>'key' = 'scan_type'
        AND filter.value->>'column' = 'scan_type'
        AND filter.value->>'op' = 'eq'
    ),
    'ui_read_registry supports scan_type filtering for correction rows'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_warehouse_scan_correction_ui_v1();

SELECT * FROM finish();

ROLLBACK;
