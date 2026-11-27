BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(1);

CREATE FUNCTION pg_temp.test_workflow_task_organization()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $test$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_run public.workflow_runs%ROWTYPE;
  v_step public.workflow_run_steps%ROWTYPE;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Synthetic Workflow Tenant', 'workflow-tenant-' || v_org::text),
    (v_other_org, 'Synthetic Foreign Tenant', 'workflow-tenant-' || v_other_org::text);

  v_run := jsonb_populate_record(NULL::public.workflow_runs, jsonb_build_object(
    'id', gen_random_uuid(),
    'context', jsonb_build_object(
      'organization_id', v_org,
      'payload', jsonb_build_object('organization_id', v_other_org)
    )
  ));
  v_step := jsonb_populate_record(NULL::public.workflow_run_steps, jsonb_build_object(
    'id', gen_random_uuid(),
    'metadata', jsonb_build_object(
      'task_type_key', 'tabular_import.process',
      'task_context_path', '$.context.payload'
    )
  ));

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok(
    format('SELECT workflow_handlers.execute_task_enqueue_v2(%L::public.workflow_run_steps, %L::public.workflow_runs)',
      v_step, v_run),
    '42501',
    'task_enqueue: task organization is outside the workflow run scope',
    'service task enqueue denies a foreign organization in the selected payload'
  );
  EXECUTE 'RESET ROLE';
END;
$test$;

SELECT * FROM pg_temp.test_workflow_task_organization();
SELECT * FROM finish();
ROLLBACK;
