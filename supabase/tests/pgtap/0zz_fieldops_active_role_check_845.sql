BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

SELECT plan(25);

CREATE FUNCTION pg_temp.test_fieldops_active_role_check_845()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  fixture_org UUID := gen_random_uuid();
  other_org UUID := gen_random_uuid();
  fixture_client UUID := gen_random_uuid();
  fixture_branch UUID := gen_random_uuid();
  fixture_driver UUID := gen_random_uuid();
  unassigned_driver UUID := gen_random_uuid();
  dual_role_driver UUID := gen_random_uuid();
  fixture_supervisor UUID := gen_random_uuid();
  scoped_user UUID := gen_random_uuid();
  other_tenant_driver UUID := gen_random_uuid();
  fixture_run UUID := gen_random_uuid();
  fixture_stop UUID := gen_random_uuid();
  fixture_shipment UUID := gen_random_uuid();
  fixture_tracking TEXT := 'PGT-' || left(fixture_shipment::text, 12);
  inner_name TEXT;
  inner_names TEXT[] := ARRAY[
    'resolve_fieldops_stop_detail_base_v1',
    'resolve_fieldops_stop_detail_contact_base_v1',
    'resolve_fieldops_stop_detail_cod_collection_base_v1'
  ];
  sibling_name TEXT;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  SELECT id, 'FieldOps role fixture', 'pgt-role-' || id
  FROM (VALUES (fixture_org), (other_org)) organization(id);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (fixture_client, fixture_org, 'Fixture client', 'pgt-role-' || fixture_client, 'active');
  INSERT INTO public.branches (id, organization_id, name, code, timezone)
  VALUES (fixture_branch, fixture_org, 'Fixture branch', 'pgt-' || left(fixture_branch::text, 8), 'UTC');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  SELECT id, org, id || '@example.test', 'FieldOps fixture user', user_type, 'active', scope_type, scope_id
  FROM (VALUES
    (fixture_driver, fixture_org, 'driver', 'tenant', NULL),
    (unassigned_driver, fixture_org, 'driver', 'tenant', NULL),
    (dual_role_driver, fixture_org, 'ops_admin', 'tenant', NULL),
    (fixture_supervisor, fixture_org, 'ops_admin', 'tenant', NULL),
    (scoped_user, fixture_org, 'driver', 'client', fixture_client),
    (other_tenant_driver, other_org, 'driver', 'tenant', NULL)
  ) actor(id, org, user_type, scope_type, scope_id);

  PERFORM public.provision_rbac_roles_from_templates_v1(fixture_org, ARRAY['driver'], fixture_driver);
  INSERT INTO public.rbac_roles (organization_id, key, name)
  VALUES (fixture_org, 'supervisor', 'Supervisor');
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
  SELECT fixture_org, actor.id, r.id
  FROM (VALUES
    (fixture_driver, 'driver'),
    (unassigned_driver, 'driver'),
    (dual_role_driver, 'driver'),
    (dual_role_driver, 'supervisor'),
    (fixture_supervisor, 'supervisor')
  ) actor(id, role_key)
  JOIN public.rbac_roles r ON r.organization_id = fixture_org AND r.key = actor.role_key;
  INSERT INTO public.mobile_v2_active_role (user_id, organization_id, role_key)
  VALUES (dual_role_driver, fixture_org, 'driver'), (fixture_supervisor, fixture_org, 'supervisor');

  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
  VALUES (fixture_shipment, fixture_org, fixture_client, fixture_tracking, 'pickup', 'pending');
  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date)
  VALUES (fixture_run, fixture_org, fixture_branch, fixture_driver, 'in_progress', CURRENT_DATE);
  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
  VALUES (fixture_stop, fixture_org, fixture_run, fixture_client, fixture_shipment, 'pickup', 1);

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', fixture_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', fixture_driver, 'role', 'authenticated')::text, true);

  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(public.resolve_fieldops_stop_detail_v1(fixture_stop, 'driver')->>'trackingCode', fixture_tracking,
    'assigned driver can read stop detail');
  RETURN NEXT is(api.resolve_fieldops_stop_detail_v1(fixture_stop)->>'trackingCode', fixture_tracking,
    'assigned driver can read stop detail with the default role');
  RETURN NEXT ok(EXISTS (
    SELECT 1 FROM public.resolve_fieldops_tasks_v1('driver') task
    WHERE task.task_id = 'stop:' || fixture_stop
  ), 'assigned driver can read their task');
  RETURN NEXT ok(EXISTS (
    SELECT 1 FROM public.resolve_fieldops_pickups_v1('driver') pickup
    WHERE pickup.task_id = 'pickup:' || fixture_stop
  ), 'assigned driver can read their pickup');
  RETURN NEXT is(public.resolve_fieldops_trips_v1('driver')->0->>'id', fixture_run::text,
    'assigned driver can read their trip');

  FOREACH inner_name IN ARRAY inner_names LOOP
    RETURN NEXT throws_ok(format('SELECT public.%I(%L, %L)', inner_name, fixture_stop, 'driver'), '42501', NULL,
      format('authenticated has no direct EXECUTE on %s', inner_name));
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', unassigned_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', unassigned_driver, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(format('SELECT api.resolve_fieldops_stop_detail_v1(%L, %L)', fixture_stop, 'driver'),
    '42501', NULL, 'unassigned driver cannot read stop detail');
  RETURN NEXT throws_ok(format('SELECT api.resolve_fieldops_stop_detail_v1(%L, %L)', fixture_stop, 'supervisor'),
    '42501', NULL, 'stop detail rejects a role the caller does not hold');

  FOREACH sibling_name IN ARRAY ARRAY['resolve_fieldops_tasks_v1', 'resolve_fieldops_pickups_v1', 'resolve_fieldops_trips_v1'] LOOP
    RETURN NEXT throws_ok(format('SELECT public.%I(%L)', sibling_name, 'supervisor'), '42501', NULL,
      format('%s rejects a role the caller does not hold', sibling_name));
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', dual_role_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', dual_role_driver, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(format('SELECT api.resolve_fieldops_stop_detail_v1(%L, %L)', fixture_stop, 'supervisor'),
    '42501', NULL, 'held supervisor role is denied while the active role is driver');

  PERFORM set_config('request.jwt.claim.sub', fixture_supervisor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', fixture_supervisor, 'role', 'authenticated')::text, true);
  RETURN NEXT is(api.resolve_fieldops_stop_detail_v1(fixture_stop, 'supervisor')->>'trackingCode', fixture_tracking,
    'active supervisor with routes read can read an unassigned tenant stop');

  PERFORM set_config('request.jwt.claim.sub', scoped_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', scoped_user, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(format('SELECT api.resolve_fieldops_stop_detail_v1(%L)', fixture_stop),
    '42501', NULL, 'client scope cannot read FieldOps stop detail');

  PERFORM set_config('request.jwt.claim.sub', other_tenant_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', other_tenant_driver, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(format('SELECT api.resolve_fieldops_stop_detail_v1(%L)', fixture_stop),
    '42501', NULL, 'other tenant cannot read FieldOps stop detail');

  PERFORM set_config('request.jwt.claim.sub', fixture_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', fixture_driver, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(format('SELECT api.resolve_fieldops_stop_detail_v1(%L, %L)', fixture_stop, 'unknown'),
    '42501', NULL, 'unknown role cannot read stop detail');
  RETURN NEXT throws_ok(format('SELECT api.resolve_fieldops_stop_detail_v1(%L, %L)', fixture_stop, ''),
    '42501', NULL, 'empty role cannot read stop detail');

  EXECUTE 'SET LOCAL ROLE postgres';
  FOREACH inner_name IN ARRAY inner_names LOOP
    RETURN NEXT results_eq(
      format('SELECT public.%I(%L, %L)->>''trackingCode''', inner_name, fixture_stop, 'driver'),
      ARRAY[fixture_tracking], format('%s allows an assigned driver from the internal entry point', inner_name)
    );
    RETURN NEXT throws_ok(format('SELECT public.%I(%L, %L)', inner_name, fixture_stop, 'supervisor'), '42501', NULL,
      format('%s enforces the active role from the internal entry point', inner_name));
  END LOOP;
END;
$test$;

SELECT * FROM pg_temp.test_fieldops_active_role_check_845();
SELECT * FROM finish();
ROLLBACK;
