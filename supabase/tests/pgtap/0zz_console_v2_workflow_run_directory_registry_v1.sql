BEGIN;
SELECT plan(7);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_template UUID := '00000000-0000-0000-0000-000000071001';
  v_run UUID := '00000000-0000-0000-0000-000000071002';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (
    v_org,
    'Workflow Run Directory Registry Org',
    'workflow-run-directory-registry-' || left(v_org::text, 8)
  );

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_user,
    v_org,
    'workflow-run-directory-registry-' || left(v_user::text, 8) || '@example.com',
    'Workflow Run Directory Registry Operator',
    'super_admin',
    'platform',
    NULL
  );

  INSERT INTO public.workflow_templates (
    id,
    name,
    version,
    status,
    scope_type
  )
  VALUES (
    v_template,
    'Console V2 workflow run directory registry proof',
    1,
    'active',
    'global'
  )
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        version = EXCLUDED.version,
        status = EXCLUDED.status,
        scope_type = EXCLUDED.scope_type,
        updated_at = now();

  PERFORM set_config('app.workflow_run_id', v_run::text, true);

  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    started_at,
    completed_at,
    retry_count
  )
  VALUES (
    v_run,
    v_template,
    1,
    'webhook',
    'completed',
    now() - interval '2 minutes',
    now() - interval '1 minute',
    0
  )
  ON CONFLICT (id) DO UPDATE
    SET workflow_template_id = EXCLUDED.workflow_template_id,
        workflow_template_version = EXCLUDED.workflow_template_version,
        entry_point = EXCLUDED.entry_point,
        workflow_status = EXCLUDED.workflow_status,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        retry_count = EXCLUDED.retry_count,
        updated_at = now();

  PERFORM set_config('test.workflow_run_directory_ops', v_user::text, true);
  EXECUTE 'RESET ROLE';
END;
$$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.workflow_run_directory_ops'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.workflow_run_directory_ops'), 'role', 'authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item
     WHERE item->>'key' = 'workflow_run_directory'
  ),
  'workflow_run_directory is registered for Console V2 reads'
);

SELECT is(
  (
    SELECT item->>'relation'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item
     WHERE item->>'key' = 'workflow_run_directory'
     LIMIT 1
  ),
  'public.v_workflow_run_directory',
  'workflow_run_directory reads the projection view'
);

SELECT is(
  (
    SELECT item->>'id_column'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item
     WHERE item->>'key' = 'workflow_run_directory'
     LIMIT 1
  ),
  'id',
  'workflow_run_directory uses the canonical id column'
);

SELECT is(
  (
    SELECT item->>'capability_read'
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') item
     WHERE item->>'key' = 'workflow_run_directory'
     LIMIT 1
  ),
  'workflows.read',
  'workflow_run_directory is gated by workflows.read'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('workflow_run_directory', '{}'::jsonb, 5, 0, '{"column":"created_at","direction":"desc"}'::jsonb) $$,
  'workflow_run_directory is readable through ui_list_resource_v1'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_resource_v1(
          'workflow_run_directory',
          '{}'::jsonb,
          5,
          0,
          '{"column":"created_at","direction":"desc"}'::jsonb
        )->'items'
      ) item
     WHERE item ? 'run_id'
       AND item ? 'template_name'
       AND item ? 'status'
  ),
  'workflow_run_directory returns operator display fields'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_resource_v1(
          'workflow_run_directory',
          '{}'::jsonb,
          20,
          0,
          '{"column":"created_at","direction":"desc"}'::jsonb
        )->'items'
      ) item
     WHERE COALESCE(item->>'run_id', '') = ''
        OR COALESCE(item->>'status', '') = ''
  ),
  'workflow_run_directory does not return blank run_id/status values'
);

SELECT * FROM finish();
ROLLBACK;
