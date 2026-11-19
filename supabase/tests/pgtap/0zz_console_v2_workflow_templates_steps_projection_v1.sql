-- Console V2 workflow template studio must read templates with backend steps attached.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- These registry contract assertions run with the service read context.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
SELECT set_config('request.jwt.claim.role', 'service_role', TRUE);

SELECT has_view(
  'public',
  'workflow_templates_console_v1',
  'workflow template console projection exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS resource
     WHERE resource->>'key' = 'workflow_templates'
       AND resource->>'relation' = 'public.workflow_templates_console_v1'
  ),
  'ui_read_registry routes workflow_templates to the consolidated projection'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS resource
     WHERE resource->>'key' = 'workflow_templates'
       AND resource->>'capability_read' = 'workflows.read'
       AND resource->>'capability_write' = 'workflows.write'
  ),
  'workflow_templates registry uses Console V2 workflow capabilities'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS resource
     WHERE resource->>'key' = 'workflow_templates'
       AND resource #>> '{import,capability}' = 'workflows.write'
  ),
  'workflow_templates import capability uses Console V2 workflow write capability'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates_console_v1
     WHERE jsonb_typeof(steps) = 'array'
       AND jsonb_array_length(steps) > 0
  ),
  'workflow template projection carries step arrays'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates_console_v1
     WHERE steps->0 ? 'workflow_template_id'
       AND steps->0 ? 'operation_name'
       AND steps->0 ? 'sequence_order'
  ),
  'workflow template step projection carries canonical step fields'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        (public.ui_list_resource_v1('workflow_templates', '{"name":"shipment_manual_create_v1","status":"active"}'::jsonb, 10, 0, NULL)->'items')
      ) AS item
     WHERE jsonb_typeof(item->'steps') = 'array'
       AND jsonb_array_length(item->'steps') > 0
  ),
  'ui_list_resource_v1 returns workflow templates with steps attached'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        (public.ui_list_resource_v1('workflow_templates', '{"name":"shipment_manual_create_v1","status":"active"}'::jsonb, 10, 0, NULL)->'items')
      ) AS item
     WHERE item->>'name' = 'shipment_manual_create_v1'
       AND NULLIF(item->>'template_id', '') IS NOT NULL
       AND NULLIF(item->>'trigger', '') IS NOT NULL
  ),
  'workflow template projection carries display labels required by the studio'
);

SELECT * FROM finish();

ROLLBACK;
