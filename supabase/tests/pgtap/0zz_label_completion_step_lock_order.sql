BEGIN;
SELECT plan(4);

CREATE TEMP TABLE label_completion_lock_fixture (
  job_id uuid PRIMARY KEY,
  step_id uuid NOT NULL
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.check_label_completion_step_locks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_temp.label_completion_lock_fixture fixture
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_locks held
      WHERE held.pid = pg_backend_pid()
        AND held.locktype = 'advisory'
        AND held.classid = hashtext('label_jobs_workflow_step_nudge')::oid
        AND held.objid = hashtext(fixture.step_id::text)::oid
        AND held.objsubid = 2
        AND held.mode = 'ExclusiveLock'
        AND held.granted
    )
  ) THEN
    RAISE EXCEPTION 'Batch completion reached a job update before acquiring all workflow-step locks';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER label_completion_lock_order_probe
BEFORE UPDATE ON public.label_jobs
FOR EACH ROW WHEN (OLD.requested_source = 'label_completion_lock_test')
EXECUTE FUNCTION pg_temp.check_label_completion_step_locks();

DO $$
DECLARE
  fixture_org uuid := gen_random_uuid();
  fixture_template uuid := gen_random_uuid();
  workflow_template uuid := gen_random_uuid();
  workflow_template_step uuid := gen_random_uuid();
  fixture_run uuid;
  fixture_job uuid;
  fixture_step uuid;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (fixture_org, 'Label completion fixture', 'label-completion-' || fixture_org);

  INSERT INTO public.label_template_specs (
    id, organization_id, template_key, version, template_scope_type, template_scope_id, renderer_config, asset_refs
  ) VALUES (fixture_template, fixture_org, 'completion_fixture', 1, 'tenant', fixture_org, '{}', '[]');

  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type)
  VALUES (workflow_template, 'label_completion_' || workflow_template, 'Label completion fixture', 1, 'active', 'global');
  INSERT INTO public.workflow_template_steps (
    id, workflow_template_id, sequence_order, operation_name, transition_condition, handler_key, handler_version, enabled
  ) VALUES (workflow_template_step, workflow_template, 1, 'workflow_control', 'always', 'workflow_control', 'v1', true);

  PERFORM set_config('platform.workflow_engine', '1', true);
  FOR fixture IN 1..2 LOOP
    fixture_run := gen_random_uuid();
    fixture_step := gen_random_uuid();
    PERFORM set_config('app.workflow_run_id', fixture_run::text, true);
    PERFORM set_config('app.workflow_run_step_id', fixture_step::text, true);
    PERFORM set_config('platform.workflow_run_step_id', fixture_step::text, true);

    INSERT INTO public.workflow_runs (
      id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context
    ) VALUES (fixture_run, workflow_template, 1, 'test', 'pending', jsonb_build_object('organization_id', fixture_org));
    INSERT INTO public.workflow_run_steps (
      id, workflow_run_id, workflow_template_step_id, sequence_order, step_status,
      operation_name, handler_key, handler_version, max_retries, enqueued_at
    ) VALUES (fixture_step, fixture_run, workflow_template_step, 1, 'pending', 'workflow_control',
      'workflow_control', 'v1', 1, now());

    fixture_job := gen_random_uuid();
    INSERT INTO public.label_jobs (
      id, organization_id, label_type, template_id, template_version, template_snapshot,
      requested_source, idempotency_key, target_type, target_id, status, attempts, workflow_run_step_id
    ) VALUES (
      fixture_job, fixture_org, public.default_label_type_for_target_type('route_run'),
      fixture_template, 1, '{}', 'label_completion_lock_test', fixture_job::text, 'route_run',
      gen_random_uuid(), 'in_progress', 1, fixture_step
    );
    INSERT INTO pg_temp.label_completion_lock_fixture VALUES (fixture_job, fixture_step);
  END LOOP;
END;
$$;

SELECT lives_ok(
  $$ SELECT public.complete_label_jobs((
    SELECT jsonb_agg(jsonb_build_object(
      'job_id', job_id, 'status', 'failed', 'error_reason', 'synthetic_render_failure'
    ) ORDER BY step_id DESC)
    FROM pg_temp.label_completion_lock_fixture
  )) $$,
  'Batch label completion holds both workflow-step locks before writing the first job'
);
SELECT is(
  (SELECT count(*) FROM public.label_jobs j JOIN pg_temp.label_completion_lock_fixture f ON f.job_id = j.id
   WHERE j.status = 'pending' AND j.error_reason = 'synthetic_render_failure'),
  2::bigint,
  'Batch label completion still reschedules both failed attempts'
);
SELECT ok(
  has_function_privilege('service_role', 'public.complete_label_jobs(jsonb)', 'EXECUTE')
    AND has_function_privilege('edge_label_renderer_role', 'public.complete_label_jobs(jsonb)', 'EXECUTE'),
  'Batch label completion remains executable by the service and renderer roles'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.complete_label_jobs(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.complete_label_jobs(jsonb)', 'EXECUTE'),
  'Batch label completion remains restricted from public application roles'
);
SELECT * FROM finish();
ROLLBACK;
