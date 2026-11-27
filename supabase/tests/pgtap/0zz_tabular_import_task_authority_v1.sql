BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(6);

SELECT ok(
  has_function_privilege('service_role', 'workflow_handlers.enqueue_system_task_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'workflow_handlers.enqueue_system_task_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'workflow_handlers.enqueue_system_task_v1(jsonb)', 'EXECUTE'),
  'internal enqueue adapter is executable by the worker role only among application roles'
);

CREATE FUNCTION pg_temp.test_import_task_authority()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  v_org uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_other_run uuid := gen_random_uuid();
  v_claims text := jsonb_build_object('role', 'authenticated', 'sub', v_actor)::text;
  v_result jsonb;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Import authority fixture', 'import-authority-' || v_org::text);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (v_actor, v_org, v_actor::text || '@example.test', 'Fixture Import Operator', 'ops_admin', 'active', 'tenant');
  INSERT INTO public.tabular_import_runs (id, organization_id, resource_key, relation_name, total_rows)
  VALUES (v_run, v_org, 'recipients', 'public.recipients', 1), (v_other_run, v_org, 'recipients', 'public.recipients', 1);

  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', v_claims, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.ui_start_tabular_import_run_v1(v_run, NULL);
  RETURN NEXT is(v_result->>'status', 'queued', 'authorized import moves its prepared run to queued');
  RETURN NEXT is(current_setting('request.jwt.claims'), v_claims, 'import start restores the exact request claims');
  EXECUTE 'RESET ROLE';

  RETURN NEXT is(
    (SELECT te.actor_user_id FROM public.task_events te JOIN public.tabular_import_runs r ON r.task_id = te.task_id
      WHERE r.id = v_run AND te.event_type = 'created'), v_actor, 'import task event attributes the requesting operator'
  );
  RETURN NEXT is(
    (SELECT te.actor_system FROM public.task_events te JOIN public.tabular_import_runs r ON r.task_id = te.task_id
      WHERE r.id = v_run AND te.event_type = 'created'), 'resource_import_studio', 'import task event attributes the authorizing operation'
  );

  PERFORM 1 FROM public.upsert_settings_value_v1(
    'access_control_policy', 'tenant', v_org,
    '{"denies":[{"capability_key":"system.write"}]}'::jsonb,
    1, 'Fixture denies general write authority'
  );
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(
    format('SELECT api.ui_start_tabular_import_run_v1(%L::uuid, NULL::jsonb)', v_other_run),
    '42501', 'ui_start_tabular_import_run_v1 requires tenant/platform write scope',
    'import resource permission alone cannot enqueue a worker task'
  );
  EXECUTE 'RESET ROLE';
END;
$test$;

SELECT * FROM pg_temp.test_import_task_authority();
SELECT * FROM finish();
ROLLBACK;
