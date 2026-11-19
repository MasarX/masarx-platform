-- pgTAP: Console V2 task row actions and fleet driver creation must be
-- backed by live backend metadata, not frontend seed-only fallbacks.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
    WHERE r.value->>'key' = 'fleet_user_options'
      AND r.value->>'relation' = 'public.users'
      AND r.value->>'capability_read' = 'fleet.write'
  ),
  'fleet_user_options is live-registry gated by fleet.write'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('manual_review', '/workflows/review-queue', 'focus', 'id'),
      ('dispatch_exception_review', '/operate/exceptions', 'task', 'id'),
      ('tenant_signup_review', '/platform/organizations', 'task', 'id'),
      ('shipment_amend_review', '/operate/amend-cancel', 'focus', 'id'),
      ('warehouse_supervisor_approval', '/platform/warehouse', 'task', 'id'),
      ('warehouse_scan_supervisor_approval', '/platform/warehouse', 'task', 'id'),
      ('route_stop_execute', '/operate/dispatch', 'route_stop', 'resource_id')
    ) AS expected(task_type, console_path, console_focus_param, console_focus_source)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
      WHERE ld.category = 'task_type'
        AND lv.value = expected.task_type
        AND lv.status = 'active'
        AND lv.metadata->>'console_path' = expected.console_path
        AND lv.metadata->>'console_focus_param' = expected.console_focus_param
        AND lv.metadata->>'console_focus_source' = expected.console_focus_source
    )
  ),
  'task_type lookup rows carry Console V2 operator route targets'
);

SELECT * FROM finish();

ROLLBACK;
