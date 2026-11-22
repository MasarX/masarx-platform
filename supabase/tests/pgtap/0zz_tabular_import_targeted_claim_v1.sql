BEGIN;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

SELECT ok(has_function_privilege('service_role', 'api.claim_tabular_import_task_v1(uuid,text)', 'EXECUTE'),
          'the service worker can claim an exact run');
SELECT ok(NOT has_function_privilege('authenticated', 'api.claim_tabular_import_task_v1(uuid,text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'api.claim_tabular_import_task_v1(uuid,text)', 'EXECUTE'),
          'application users cannot claim an import run');
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_tabular_import_task_v1(uuid,text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.claim_tabular_import_task_v1(uuid,text)', 'EXECUTE'),
          'application users cannot call the public exact-run claim');
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_tabular_import_task_internal_v1(text,uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.claim_tabular_import_task_internal_v1(text,uuid)', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'public.claim_tabular_import_task_internal_v1(text,uuid)', 'EXECUTE'),
          'the internal claim is callable only through its wrappers');

CREATE FUNCTION pg_temp.test_targeted_import_claim()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_other_actor UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_waiting UUID := gen_random_uuid();
  v_unlinked UUID := gen_random_uuid();
  v_type UUID;
  v_task UUID;
  v_waiting_task UUID;
  v_claim JSONB;
BEGIN
  INSERT INTO public.organizations(id, name, slug)
  VALUES (v_org, 'Targeted Import Fixture', 'targeted-import-' || left(v_org::text, 8)),
         (v_other_org, 'Other Import Fixture', 'targeted-import-' || left(v_other_org::text, 8));
  INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (v_other_actor, v_other_org, v_other_actor::text || '@example.invalid',
          'Other Import Fixture Operator', 'ops_admin', 'active', 'tenant');
  INSERT INTO public.task_types(organization_id, key, name)
  VALUES (v_org, 'tabular_import.process', 'Process Import')
  RETURNING id INTO v_type;
  INSERT INTO public.tasks(organization_id, task_type_id, resource_type, resource_id, status, priority)
  VALUES (v_org, v_type, 'tabular_import_run', v_run, 'open', 60)
  RETURNING id INTO v_task;
  INSERT INTO public.tasks(organization_id, task_type_id, resource_type, resource_id, status, priority)
  VALUES (v_org, v_type, 'tabular_import_run', v_waiting, 'open', 100)
  RETURNING id INTO v_waiting_task;
  INSERT INTO public.tasks(organization_id, task_type_id, resource_type, resource_id, status, priority)
  VALUES (v_org, v_type, 'tabular_import_run', v_unlinked, 'open', 100);
  INSERT INTO public.tabular_import_runs(id, organization_id, resource_key, relation_name, status, task_id)
  VALUES (v_run, v_org, 'recipients', 'public.recipients', 'processing', v_task),
         (v_waiting, v_org, 'recipients', 'public.recipients', 'queued', v_waiting_task),
         (v_unlinked, v_org, 'recipients', 'public.recipients', 'queued', NULL);

  PERFORM set_config('request.jwt.claim.sub', v_other_actor::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_other_actor)::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(
    format('SELECT api.ui_start_tabular_import_run_v1(%L::uuid, NULL::jsonb)', v_run),
    'P0001', 'ui_start_tabular_import_run_v1 cannot start another organization',
    'a foreign tenant operator cannot start the import'
  );
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok(
    'SELECT api.claim_tabular_import_task_v1(NULL::uuid, NULL::text)',
    '22004', 'A run ID is required', 'a null target cannot claim from the general queue'
  );
  RETURN NEXT is(api.claim_tabular_import_task_v1(gen_random_uuid(), 'targeted-worker'), NULL::JSONB,
                 'an unknown run never falls back to a waiting task');
  RETURN NEXT is(api.claim_tabular_import_task_v1(v_unlinked, 'targeted-worker'), NULL::JSONB,
                 'a task without a canonical run link cannot be claimed by target');
  v_claim := api.claim_tabular_import_task_v1(v_run, 'targeted-worker');
  RETURN NEXT is(v_claim->>'run_id', v_run::text, 'the exact worker owns the partially processed run');
  RETURN NEXT is(v_claim->>'task_id', v_task::text, 'the claim returns the canonical task');
  RETURN NEXT is(api.claim_tabular_import_task_v1(v_run, 'other-worker'), NULL::JSONB,
                 'an already-claimed run is unavailable to a second worker');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id = v_task), 'in_progress', 'the claimed task transitions');
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id = v_waiting_task), 'open', 'the higher-priority task stays queued');
END;
$$;

SELECT * FROM pg_temp.test_targeted_import_claim();
SELECT * FROM finish();
ROLLBACK;
