BEGIN;
SELECT plan(8);

SELECT is(
  (
    SELECT count(*)::int
      FROM public.operation_templates
     WHERE provider_id = '99990000-0000-0000-0000-000000460000'::uuid
       AND operation_name = ANY (ARRAY[
         'binding_request_received_notify',
         'binding_post_apply_notify',
         'binding_post_reject_notify',
         'binding_review_requested_task',
         'binding_tenant_signup_review_task',
         'binding_marketing_lead_review_task'
       ])
  ),
  6,
  'tenant bootstrap binding operations exist in the canonical operation catalog'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_operation_template_directory
     WHERE operation_name = 'binding_tenant_signup_review_task'
       AND kind = 'action'
       AND category = 'review tasks'
       AND description <> ''
       AND output_schema IS NOT NULL
  ),
  'operation directory projection exposes operator-safe metadata for tenant signup review'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_operation_template_directory
     WHERE operation_name = 'binding_post_reject_notify'
       AND kind = 'action'
       AND category = 'notifications'
       AND description <> ''
       AND output_schema IS NOT NULL
  ),
  'operation directory projection exposes operator-safe metadata for notification operations'
);

SELECT is(
  (
    SELECT item->>'relation'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item
     WHERE item->>'key' = 'operation_templates'
     LIMIT 1
  ),
  'public.v_operation_template_directory',
  'operation_templates registry reads the operator projection view'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item,
           jsonb_array_elements(item->'filters') filter
     WHERE item->>'key' = 'operation_templates'
       AND filter->>'key' = 'operation_name'
       AND filter->>'column' = 'operation_name'
       AND filter->>'op' = 'eq'
  ),
  'operation_templates supports operation_name filtering'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('operation_templates', '{"operation_name":"binding_post_reject_notify"}'::jsonb, 5, 0, '{"column":"operation_name","direction":"asc"}'::jsonb) $$,
  'operation_templates is readable through ui_list_resource_v1'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_resource_v1(
          'operation_templates',
          '{"operation_name":"binding_post_reject_notify"}'::jsonb,
          5,
          0,
          '{"column":"operation_name","direction":"asc"}'::jsonb
        )->'items'
      ) item
     WHERE item->>'operation_name' = 'binding_post_reject_notify'
       AND item->>'kind' = 'action'
       AND item->>'category' = 'notifications'
       AND COALESCE(item->>'description', '') <> ''
       AND item ? 'output_schema'
  ),
  'ui_list_resource_v1 returns operation metadata needed by Console V2'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_resource_v1(
          'operation_templates',
          '{"operation_name":"binding_post_reject_notify"}'::jsonb,
          5,
          0,
          '{"column":"operation_name","direction":"asc"}'::jsonb
        )->'items'
      ) item
     WHERE item ? 'url_template'
        OR item ? 'headers_template'
        OR item ? 'body_template'
        OR item ? 'request_mappings'
  ),
  'operation_templates projection does not expose raw provider request internals to Console V2'
);

SELECT * FROM finish();
ROLLBACK;
