BEGIN;
SELECT plan(9);

-- These registry contract assertions run with the service read context.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
SELECT set_config('request.jwt.claim.role', 'service_role', TRUE);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_step_kind'
       AND lv.value = 'trigger'
       AND lv.metadata->>'is_trigger' = 'true'
       AND lv.metadata->>'requires_error_path' = 'false'
  ),
  'workflow_step_kind.trigger is row-flagged as the trigger step kind'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_step_kind'
       AND lv.value = 'action'
       AND lv.metadata->>'is_trigger' = 'false'
       AND lv.metadata->>'is_default' = 'true'
  ),
  'workflow_step_kind.action remains the row-driven default non-trigger kind'
);

SELECT is(
  (
    SELECT count(*)::int
      FROM public.v_operation_template_directory
     WHERE operation_name = ANY (ARRAY[
       'webhook.receive',
       'event.consume',
       'command.execute',
       'task.transition'
     ])
       AND kind = 'trigger'
       AND category = 'triggers'
       AND handler_key = 'workflow_binding_noop'
  ),
  4,
  'Workflow Studio trigger operations exist in the operator-safe operation catalog'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('operation_templates', '{"kind":"trigger"}'::jsonb, 10, 0, '{"column":"operation_name","direction":"asc"}'::jsonb) $$,
  'trigger operation catalog is readable through ui_list_resource_v1'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_resource_v1(
          'operation_templates',
          '{"kind":"trigger"}'::jsonb,
          10,
          0,
          '{"column":"operation_name","direction":"asc"}'::jsonb
        )->'items'
      ) item
     WHERE item->>'operation_name' = 'webhook.receive'
       AND item->>'kind' = 'trigger'
       AND item->>'category' = 'triggers'
       AND COALESCE(item->>'description', '') <> ''
  ),
  'ui_list_resource_v1 returns webhook.receive as a trigger operation'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_resource_v1(
          'operation_templates',
          '{"kind":"trigger"}'::jsonb,
          10,
          0,
          '{"column":"operation_name","direction":"asc"}'::jsonb
        )->'items'
      ) item
     WHERE item->>'operation_name' = 'command.execute'
       AND item->>'kind' = 'trigger'
       AND item ? 'output_schema'
  ),
  'ui_list_resource_v1 returns command.execute trigger metadata needed by Console V2'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_resource_v1(
          'operation_templates',
          '{"kind":"trigger"}'::jsonb,
          10,
          0,
          '{"column":"operation_name","direction":"asc"}'::jsonb
        )->'items'
      ) item
     WHERE item ? 'url_template'
        OR item ? 'headers_template'
        OR item ? 'body_template'
        OR item ? 'request_mappings'
  ),
  'trigger operation projection hides raw provider request internals'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item,
           jsonb_array_elements(item->'filters') filter
     WHERE item->>'key' = 'operation_templates'
       AND filter->>'key' = 'kind'
       AND filter->>'column' = 'kind'
       AND filter->>'op' = 'eq'
  ),
  'operation_templates registry supports kind filtering for trigger-only palettes'
);

SELECT ok(
  pg_get_functiondef('public.ui_create_workflow_template_step_v1(jsonb)'::regprocedure) LIKE '%FROM public.operation_templates ot%'
  AND pg_get_functiondef('public.ui_create_workflow_template_step_v1(jsonb)'::regprocedure) LIKE '%v_operation_handler_key%',
  'workflow step create resolves handler metadata from operation_templates instead of requiring frontend handler fields'
);

SELECT * FROM finish();
ROLLBACK;
