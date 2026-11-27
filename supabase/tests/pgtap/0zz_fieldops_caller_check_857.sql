BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

SELECT plan(7);

CREATE FUNCTION pg_temp.test_fieldops_caller_check_857()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  fixture_org UUID := gen_random_uuid();
  other_org UUID := gen_random_uuid();
  fixture_client UUID := gen_random_uuid();
  fixture_branch UUID := gen_random_uuid();
  fixture_driver UUID := gen_random_uuid();
  fixture_supervisor UUID := gen_random_uuid();
  other_supervisor UUID := gen_random_uuid();
  scoped_supervisor UUID := gen_random_uuid();
  supervisor_without_capability UUID := gen_random_uuid();
  no_org_user UUID := gen_random_uuid();
  fixture_run UUID := gen_random_uuid();
  fixture_incident UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  SELECT id, 'FieldOps queue fixture', 'pgt-queue-' || id
  FROM (VALUES (fixture_org), (other_org)) organization(id);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (fixture_client, fixture_org, 'Fixture client', 'pgt-queue-' || fixture_client, 'active');
  INSERT INTO public.branches (id, organization_id, name, code, timezone)
  VALUES (fixture_branch, fixture_org, 'Fixture branch', 'pgt-' || left(fixture_branch::text, 8), 'UTC');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  SELECT id, org, id || '@example.test', 'FieldOps queue fixture', user_type, 'active', scope_type, scope_id
  FROM (VALUES
    (fixture_driver, fixture_org, 'driver', 'tenant', NULL),
    (fixture_supervisor, fixture_org, 'ops_admin', 'tenant', NULL),
    (other_supervisor, other_org, 'ops_admin', 'tenant', NULL),
    (scoped_supervisor, fixture_org, 'ops_admin', 'client', fixture_client),
    (supervisor_without_capability, fixture_org, 'finance_viewer', 'tenant', NULL)
  ) actor(id, org, user_type, scope_type, scope_id);

  PERFORM public.provision_rbac_roles_from_templates_v1(fixture_org, ARRAY['driver'], fixture_driver);
  INSERT INTO public.rbac_roles (organization_id, key, name)
  VALUES (fixture_org, 'supervisor', 'Supervisor'), (other_org, 'supervisor', 'Supervisor');

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
  SELECT actor.org, actor.id, r.id
  FROM (VALUES
    (fixture_driver, fixture_org, 'driver'),
    (fixture_supervisor, fixture_org, 'supervisor'),
    (other_supervisor, other_org, 'supervisor'),
    (scoped_supervisor, fixture_org, 'supervisor'),
    (supervisor_without_capability, fixture_org, 'supervisor')
  ) actor(id, org, role_key)
  JOIN public.rbac_roles r ON r.organization_id = actor.org AND r.key = actor.role_key;

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date)
  VALUES (fixture_run, fixture_org, fixture_branch, fixture_driver, 'pending_review', DATE '2026-01-01');
  INSERT INTO public.fieldops_v2_incidents (id, organization_id, reported_by_user_id, type_id, severity)
  VALUES (fixture_incident, fixture_org, fixture_driver, 'fixture', 'low');

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', fixture_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', fixture_driver, 'role', 'authenticated')::text, true);

  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok('SELECT public.resolve_fieldops_supervisor_queue_v1()',
    '42501', NULL, 'tenant driver is denied by the supervisor queue resolver');
  RETURN NEXT throws_ok('SELECT api.resolve_fieldops_supervisor_queue_v1()',
    '42501', NULL, 'supervisor queue API wrapper preserves the caller check');

  PERFORM set_config('request.jwt.claim.sub', fixture_supervisor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', fixture_supervisor, 'role', 'authenticated')::text, true);
  RETURN NEXT is(
    ARRAY(
      SELECT item->>'id'
      FROM jsonb_array_elements(public.resolve_fieldops_supervisor_queue_v1()->'queue') AS item
      ORDER BY item->>'id'
    ),
    ARRAY['incident:' || fixture_incident, 'run:' || fixture_run],
    'tenant supervisor with routes read gets both queue fixtures'
  );

  PERFORM set_config('request.jwt.claim.sub', other_supervisor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', other_supervisor, 'role', 'authenticated')::text, true);
  RETURN NEXT is(api.resolve_fieldops_supervisor_queue_v1()->'queue', '[]'::jsonb,
    'supervisor in another organization gets an empty queue');

  PERFORM set_config('request.jwt.claim.sub', scoped_supervisor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', scoped_supervisor, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok('SELECT public.resolve_fieldops_supervisor_queue_v1()',
    '42501', NULL, 'client-scoped supervisor is denied by the tenant queue');

  PERFORM set_config('request.jwt.claim.sub', supervisor_without_capability::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', supervisor_without_capability, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok('SELECT public.resolve_fieldops_supervisor_queue_v1()',
    '42501', NULL, 'assigned supervisor without routes read is denied by the queue');

  PERFORM set_config('request.jwt.claim.sub', no_org_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', no_org_user, 'role', 'authenticated')::text, true);
  RETURN NEXT is(public.resolve_fieldops_supervisor_queue_v1()->'queue', '[]'::jsonb,
    'signed-in caller with no organization gets an empty supervisor queue');
  EXECUTE 'RESET ROLE';
END;
$test$;

SELECT * FROM pg_temp.test_fieldops_caller_check_857();
SELECT * FROM finish();
ROLLBACK;
