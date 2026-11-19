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
     WHERE resource->>'key' = 'workflow_templates_console'
       AND resource->>'relation' = 'public.workflow_templates_console_v1'
  ),
  'ui_read_registry routes workflow_templates_console to the consolidated projection'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS resource
     WHERE resource->>'key' = 'workflow_templates_console'
       AND resource->>'capability_read' = 'workflows.read'
       AND NOT (resource ?| ARRAY['capability_write', 'write_relation', 'import'])
  ),
  'workflow_templates_console is read-only and requires workflows.read'
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

CREATE TEMP TABLE test_workflow_template_projection AS
SELECT id, name, template_id, trigger
  FROM public.workflow_templates_console_v1
 WHERE scope_type = 'global' AND status = 'active' AND jsonb_array_length(steps) > 0
 ORDER BY id
 LIMIT 1;

SELECT ok(
  EXISTS (
    SELECT 1 FROM test_workflow_template_projection t
    CROSS JOIN LATERAL jsonb_array_elements(
      public.ui_list_resource_v1('workflow_templates_console', jsonb_build_object('name', t.name), 100, 0, NULL)->'items'
    ) AS item
    WHERE item->>'id' = t.id::text AND jsonb_typeof(item->'steps') = 'array'
      AND jsonb_array_length(item->'steps') > 0
  ),
  'ui_list_resource_v1 returns workflow templates with steps attached'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM test_workflow_template_projection t
    CROSS JOIN LATERAL public.ui_get_resource_v1('workflow_templates_console', t.id) AS readback(item)
    WHERE item->>'id' = t.id::text AND item->>'template_id' = t.template_id
      AND item->>'trigger' = t.trigger
  ),
  'workflow template projection carries display labels required by the studio'
);

SELECT * FROM finish();

ROLLBACK;
