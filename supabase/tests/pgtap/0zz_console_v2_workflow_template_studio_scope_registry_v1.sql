BEGIN;
SELECT plan(7);

-- These registry contract assertions run with the service read context.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
SELECT set_config('request.jwt.claim.role', 'service_role', TRUE);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item
     WHERE item->>'key' = 'workflow_template_directory'
  ),
  'workflow_template_directory is registered for Console V2 template studio reads'
);

SELECT is(
  (
    SELECT item->>'relation'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item
     WHERE item->>'key' = 'workflow_template_directory'
     LIMIT 1
  ),
  'public.v_workflow_template_directory',
  'workflow_template_directory reads the operator projection view'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item,
           jsonb_array_elements(item->'filters') filter
     WHERE item->>'key' = 'workflow_templates'
       AND filter->>'key' = 'scope_id'
       AND filter->>'column' = 'scope_id'
       AND filter->>'op' = 'eq'
  ),
  'workflow_templates supports tenant scope_id filtering'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item,
           jsonb_array_elements(item->'filters') filter
     WHERE item->>'key' = 'workflow_template_directory'
       AND filter->>'key' = 'scope_id'
       AND filter->>'column' = 'scope_id'
       AND filter->>'op' = 'eq'
  ),
  'workflow_template_directory supports tenant scope_id filtering'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('workflow_template_directory', '{}'::jsonb, 5, 0, '{"column":"created_at","direction":"desc"}'::jsonb) $$,
  'workflow_template_directory is readable through ui_list_resource_v1'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_resource_v1(
          'workflow_template_directory',
          '{}'::jsonb,
          5,
          0,
          '{"column":"created_at","direction":"desc"}'::jsonb
        )->'items'
      ) item
     WHERE item ? 'workflow_template_id'
       AND item ? 'name'
       AND item ? 'status'
       AND item ? 'scope_id'
  ),
  'workflow_template_directory returns operator display and scope fields'
);

WITH tenant_scope AS (
  SELECT scope_id::text AS scope_id
    FROM public.workflow_templates
   WHERE scope_type = 'tenant'
     AND scope_id IS NOT NULL
   GROUP BY scope_id
   ORDER BY count(*) DESC
   LIMIT 1
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM tenant_scope ts,
           jsonb_array_elements(
             public.ui_list_resource_v1(
               'workflow_templates',
               jsonb_build_object('scope_id', ts.scope_id),
               200,
               0,
               '{"column":"created_at","direction":"desc"}'::jsonb
             )->'items'
           ) item
     WHERE item->>'scope_id' <> ts.scope_id
  ),
  'workflow_templates scope_id filter does not leak other tenants'
);

SELECT * FROM finish();
ROLLBACK;
