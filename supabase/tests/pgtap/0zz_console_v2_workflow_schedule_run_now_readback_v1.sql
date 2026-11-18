-- pgTAP: Console V2 workflow schedule Run-now persists backend readback and
-- aligns the backend write gate with the Console V2 workflows.write surface.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_preflight_template UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_trigger UUID;
  v_preflight_trigger UUID;
  v_worker_trigger UUID;
  v_before_next_run_at TIMESTAMPTZ;
  v_worker_before_next_run_at TIMESTAMPTZ;
  v_worker_after_next_run_at TIMESTAMPTZ;
  v_result JSONB;
  v_preflight_result JSONB;
  v_worker_result JSON;
  v_worker_run_count_before INTEGER;
  v_run_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Schedule Run Now Readback Org', 'schedule-run-now-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Schedule Run Now Client', 'schedule-run-now-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type, scope_id, notes)
  VALUES (
    v_template,
    'schedule_run_now_readback_' || left(v_template::text, 8),
    'Template used for schedule Run-now readback pgTAP coverage.',
    1,
    'active',
    'tenant',
    v_org,
    'pgTAP fixture workflow template'
  );

  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type, scope_id, notes)
  VALUES (
    v_preflight_template,
    'schedule_run_now_preflight_' || left(v_preflight_template::text, 8),
    'Template used for schedule Run-now task payload preflight pgTAP coverage.',
    1,
    'active',
    'tenant',
    v_org,
    'pgTAP fixture workflow template with dynamic task payload requirement'
  );

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    handler_key,
    handler_version,
    enabled
  )
  VALUES (
    v_preflight_template,
    1,
    'binding_marketing_lead_review_task',
    'success',
    jsonb_build_object('task_path', '$.context.binding_payload.task'),
    'task_enqueue_dynamic',
    'v1',
    TRUE
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'schedule-run-now-' || left(v_user::text, 8) || '@example.com',
    'Schedule Run Now User',
    'client_admin',
    'client',
    v_client
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT (
    public.ui_create_workflow_schedule_trigger_v1(
      v_template,
      jsonb_build_object('type', 'interval', 'interval_seconds', 3600),
      jsonb_build_object('source', 'pgtap_run_now_readback'),
      TRUE,
      NULL
    )->>'workflow_schedule_trigger_id'
  )::uuid
  INTO v_trigger;

  SELECT (
    public.ui_create_workflow_schedule_trigger_v1(
      v_preflight_template,
      jsonb_build_object('type', 'interval', 'interval_seconds', 3600),
      jsonb_build_object('source', 'pgtap_run_now_preflight'),
      TRUE,
      NULL
    )->>'workflow_schedule_trigger_id'
  )::uuid
  INTO v_preflight_trigger;

  SELECT (
    public.ui_create_workflow_schedule_trigger_v1(
      v_preflight_template,
      jsonb_build_object('type', 'interval', 'interval_seconds', 3600),
      jsonb_build_object('source', 'pgtap_worker_preflight'),
      TRUE,
      NULL
    )->>'workflow_schedule_trigger_id'
  )::uuid
  INTO v_worker_trigger;

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT next_run_at
  INTO v_before_next_run_at
  FROM public.workflow_schedule_triggers
  WHERE id = v_trigger;

  UPDATE public.workflow_schedule_triggers
  SET
    next_run_at = public.workflow_now() - interval '1 minute',
    last_run_at = NULL,
    last_run_id = NULL,
    last_error = NULL,
    last_error_at = NULL
  WHERE id = v_worker_trigger;

  SELECT next_run_at
  INTO v_worker_before_next_run_at
  FROM public.workflow_schedule_triggers
  WHERE id = v_worker_trigger;

  PERFORM ok(v_trigger IS NOT NULL, 'schedule trigger fixture created');

  PERFORM is(
    (SELECT last_run_id::text FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    NULL,
    'schedule trigger starts without last_run_id'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.ui_run_workflow_schedule_trigger_v1(v_trigger)
  INTO v_result;

  v_run_id := (v_result->>'workflow_run_id')::uuid;

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM ok(v_run_id IS NOT NULL, 'Run-now returns workflow_run_id');

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.workflow_runs
      WHERE id = v_run_id
        AND workflow_template_id = v_template
    ),
    'Run-now creates workflow_run for the scheduled template'
  );

  PERFORM is(
    (SELECT last_run_id::text FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    v_run_id::text,
    'Run-now stores last_run_id on workflow_schedule_triggers'
  );

  PERFORM ok(
    (SELECT last_run_at IS NOT NULL FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    'Run-now stores last_run_at on workflow_schedule_triggers'
  );

  PERFORM is(
    (SELECT next_run_at FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    v_before_next_run_at,
    'Manual Run-now does not consume or advance the recurring next_run_at slot'
  );

  PERFORM ok(
    pg_get_functiondef(to_regprocedure('public.ui_run_workflow_schedule_trigger_v1(uuid)'))
      LIKE '%assert_capability_v1(''workflows.write''%',
    'Run-now wrapper asserts canonical workflows.write'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.ui_run_workflow_schedule_trigger_v1(v_preflight_trigger)
  INTO v_preflight_result;

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM is(
    v_preflight_result->>'status',
    'preflight_failed',
    'Run-now returns preflight_failed when task payload is absent'
  );

  PERFORM is(
    v_preflight_result->>'workflow_run_id',
    NULL,
    'Run-now preflight does not return workflow_run_id'
  );

  PERFORM ok(
    NOT EXISTS (
      SELECT 1
      FROM public.workflow_runs
      WHERE workflow_template_id = v_preflight_template
    ),
    'Run-now preflight does not create a workflow_run'
  );

  PERFORM is(
    (SELECT last_run_id::text FROM public.workflow_schedule_triggers WHERE id = v_preflight_trigger),
    NULL,
    'Run-now preflight keeps workflow_schedule_triggers.last_run_id empty'
  );

  PERFORM ok(
    (SELECT last_error FROM public.workflow_schedule_triggers WHERE id = v_preflight_trigger)
      LIKE '%$.context.binding_payload.task%',
    'Run-now preflight stores missing task payload path on workflow_schedule_triggers.last_error'
  );

  PERFORM ok(
    pg_get_functiondef(to_regprocedure('public.ui_run_workflow_schedule_trigger_v1(uuid)'))
      LIKE '%workflow_schedule_trigger_preflight_v1%',
    'Run-now wrapper invokes workflow_schedule_trigger_preflight_v1'
  );

  SELECT COUNT(*)
  INTO v_worker_run_count_before
  FROM public.workflow_runs
  WHERE workflow_template_id = v_preflight_template;

  UPDATE public.cron_config
  SET last_run_at = NULL,
      enabled = TRUE,
      batch_size = GREATEST(batch_size, 1),
      updated_at = now()
  WHERE worker_name = 'workflow_schedule_triggers_worker';

  SELECT public.run_workflow_schedule_triggers_worker()
  INTO v_worker_result;

  SELECT next_run_at
  INTO v_worker_after_next_run_at
  FROM public.workflow_schedule_triggers
  WHERE id = v_worker_trigger;

  PERFORM ok(
    COALESCE((v_worker_result->>'items_processed')::integer, 0) >= 1,
    'Schedule worker processes at least one due trigger'
  );

  PERFORM is(
    (SELECT COUNT(*)::integer FROM public.workflow_runs WHERE workflow_template_id = v_preflight_template),
    v_worker_run_count_before,
    'Schedule worker preflight does not create a workflow_run for missing task payload'
  );

  PERFORM is(
    (SELECT last_run_id::text FROM public.workflow_schedule_triggers WHERE id = v_worker_trigger),
    NULL,
    'Schedule worker preflight keeps workflow_schedule_triggers.last_run_id empty'
  );

  PERFORM ok(
    (SELECT last_error FROM public.workflow_schedule_triggers WHERE id = v_worker_trigger)
      LIKE '%$.context.binding_payload.task%',
    'Schedule worker preflight stores missing task payload path on workflow_schedule_triggers.last_error'
  );

  PERFORM ok(
    v_worker_after_next_run_at > v_worker_before_next_run_at,
    'Schedule worker preflight advances next_run_at after consuming the due slot'
  );

  PERFORM ok(
    NOT has_function_privilege(
      'authenticated',
      'public.workflow_schedule_trigger_preflight_v1(public.workflow_schedule_triggers,jsonb)',
      'EXECUTE'
    ),
    'Preflight helper is not directly executable by authenticated clients'
  );

  PERFORM ok(
    has_function_privilege(
      'service_role',
      'public.workflow_schedule_trigger_preflight_v1(public.workflow_schedule_triggers,jsonb)',
      'EXECUTE'
    ),
    'Preflight helper remains executable for service_role maintenance paths'
  );
END $$;

SELECT * FROM finish();
ROLLBACK;
