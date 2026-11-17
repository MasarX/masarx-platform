-- Plan: PLAN-202601-branch-capacity-calendars-service-catalog / Step: S95
-- pgTAP: Branch capacity + calendars + service catalog invariants

BEGIN;

SELECT plan(26);

SELECT has_table('service_levels', 'service_levels table exists');
SELECT has_table('service_offerings', 'service_offerings table exists');
SELECT has_table('branch_coverage_windows', 'branch_coverage_windows table exists');
SELECT has_table('branch_capacity_windows', 'branch_capacity_windows table exists');
SELECT has_table('calendar_events', 'calendar_events table exists');
SELECT has_table('branch_memberships', 'branch_memberships table exists');

SELECT ok((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'service_levels'), 'RLS enabled on service_levels');
SELECT ok((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'service_offerings'), 'RLS enabled on service_offerings');
SELECT ok((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'branch_coverage_windows'), 'RLS enabled on branch_coverage_windows');
SELECT ok((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'branch_capacity_windows'), 'RLS enabled on branch_capacity_windows');
SELECT ok((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'calendar_events'), 'RLS enabled on calendar_events');
SELECT ok((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'branch_memberships'), 'RLS enabled on branch_memberships');

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_org2 UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();

  v_zone UUID := gen_random_uuid();
  v_zone2 UUID := gen_random_uuid();

  v_branch_base UUID := gen_random_uuid();
  v_branch_override UUID := gen_random_uuid();
  v_branch_other_org UUID := gen_random_uuid();

  v_level UUID := gen_random_uuid();

  v_existing_window UUID;

  v_now TIMESTAMPTZ := now();
  v_in TIMESTAMPTZ := now();
  v_out TIMESTAMPTZ := now() + interval '2 hours';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Branch Cap Org', 'branch-cap-' || left(v_org::text, 8)),
    (v_org2, 'Branch Cap Org2', 'branch-cap-' || left(v_org2::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_user, v_org, 'branch-cap-' || left(v_user::text, 8) || '@example.com', 'Branch Cap User', 'tenant');

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES
    (v_zone, v_org, 'Zone 1', 'zone-' || left(v_zone::text, 8), TRUE),
    (v_zone2, v_org2, 'Zone 2', 'zone-' || left(v_zone2::text, 8), TRUE);

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES
    (v_branch_base, v_org, 'bbase', 'Base Branch', 'UTC'),
    (v_branch_override, v_org, 'bover', 'Override Branch', 'UTC'),
    (v_branch_other_org, v_org2, 'bother', 'Other Org Branch', 'UTC');

  INSERT INTO public.branch_zones (branch_id, zone_id, priority)
  VALUES (v_branch_base, v_zone, 0);

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES (v_level, v_org, 'standard', 'Standard', TRUE);

  -- Offering: org match OK.
  INSERT INTO public.service_offerings (service_level_id, branch_id, zone_id, effective_from, effective_to, priority, is_active)
  VALUES (v_level, v_branch_base, NULL, v_now, v_now + interval '1 day', 0, TRUE);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.service_offerings (service_level_id, branch_id, effective_from, priority, is_active)
      VALUES (%L::uuid, %L::uuid, now(), 0, true)
    $sql$, v_level::text, v_branch_other_org::text),
    '23514',
    format(
      'service_offerings: organization mismatch (branch org %s, service_level org %s)',
      v_org2::text,
      v_org::text
    )
  );

  -- Coverage window overrides baseline inside effective range.
  INSERT INTO public.branch_coverage_windows (branch_id, zone_id, effective_from, effective_to, priority, is_active)
  VALUES (v_branch_override, v_zone, v_in - interval '1 hour', v_in + interval '1 hour', 10, TRUE);

  SELECT bcw.id
    INTO v_existing_window
    FROM public.branch_coverage_windows bcw
   WHERE bcw.zone_id = v_zone
     AND bcw.branch_id = v_branch_override
   LIMIT 1;

  PERFORM set_config('platform.now_override', v_in::text, true);
  PERFORM is(
    public.resolve_branch_id_for_zone(v_zone)::text,
    v_branch_override::text,
    'resolve_branch_id_for_zone prefers active branch_coverage_windows over branch_zones'
  );

  PERFORM set_config('platform.now_override', v_out::text, true);
  PERFORM is(
    public.resolve_branch_id_for_zone(v_zone)::text,
    v_branch_base::text,
    'resolve_branch_id_for_zone falls back to baseline branch_zones outside window'
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.branch_coverage_windows (branch_id, zone_id, effective_from, effective_to, priority, is_active)
      VALUES (%L::uuid, %L::uuid, %L::timestamptz, %L::timestamptz, 5, true)
    $sql$, v_branch_base::text, v_zone::text, (v_in - interval '30 minutes')::text, (v_in + interval '30 minutes')::text),
    '23514',
    format(
      'branch_coverage_windows: overlapping active window for zone %s (existing %s)',
      v_zone::text,
      v_existing_window::text
    )
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.branch_coverage_windows (branch_id, zone_id, effective_from, priority, is_active)
      VALUES (%L::uuid, %L::uuid, now(), 0, true)
    $sql$, v_branch_base::text, v_zone2::text),
    '23514',
    format(
      'branch_coverage_windows: organization mismatch (branch org %s, zone org %s)',
      v_org::text,
      v_org2::text
    )
  );

  -- Capacity windows: org match enforced.
  INSERT INTO public.branch_capacity_windows (branch_id, zone_id, service_level_id, effective_from, priority, capacity, is_active)
  VALUES (v_branch_base, v_zone, v_level, v_now, 0, jsonb_build_object('max_stops', 10), TRUE);

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.branch_capacity_windows WHERE branch_id = v_branch_base) = 1,
    'branch_capacity_windows insert succeeds'
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.branch_capacity_windows (branch_id, zone_id, service_level_id, effective_from, priority, capacity, is_active)
      VALUES (%L::uuid, %L::uuid, %L::uuid, now(), 0, '{}'::jsonb, true)
    $sql$, v_branch_base::text, v_zone2::text, v_level::text),
    '23514',
    format(
      'branch_capacity_windows: organization mismatch (branch org %s, zone org %s)',
      v_org::text,
      v_org2::text
    )
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.branch_capacity_windows (branch_id, service_level_id, effective_from, priority, capacity, is_active)
      VALUES (%L::uuid, %L::uuid, now(), 0, '{}'::jsonb, true)
    $sql$, v_branch_other_org::text, v_level::text),
    '23514',
    format(
      'branch_capacity_windows: organization mismatch (branch org %s, service_level org %s)',
      v_org2::text,
      v_org::text
    )
  );

  -- Calendar events: org match enforced via branch.
  INSERT INTO public.calendar_events (organization_id, branch_id, event_type, starts_at, ends_at, is_active)
  VALUES (v_org, v_branch_base, 'holiday', v_now, v_now + interval '2 hours', TRUE);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.calendar_events (organization_id, branch_id, event_type, starts_at, ends_at, is_active)
      VALUES (%L::uuid, %L::uuid, 'holiday', now(), now() + interval '1 hour', true)
    $sql$, v_org::text, v_branch_other_org::text),
    '23514',
    format(
      'calendar_events: organization mismatch (event org %s, branch org %s)',
      v_org::text,
      v_org2::text
    )
  );

  -- Branch memberships: org match enforced between user and branch.
  INSERT INTO public.branch_memberships (branch_id, user_id, role_key, is_active)
  VALUES (v_branch_base, v_user, 'cashier', TRUE);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.branch_memberships (branch_id, user_id, role_key, is_active)
      VALUES (%L::uuid, %L::uuid, 'cashier', true)
    $sql$, v_branch_other_org::text, v_user::text),
    '23514',
    format(
      'branch_memberships: organization mismatch (branch org %s, user org %s)',
      v_org2::text,
      v_org::text
    )
  );

  -- RBAC: catalog/coverage writes require agreements.write (least privilege).
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.service_levels (organization_id, key, name, is_active)
      VALUES (%L::uuid, 'premium', 'Premium', true)
    $sql$, v_org::text),
    '42501',
    'new row violates row-level security policy for table "service_levels"'
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.branch_coverage_windows (branch_id, zone_id, effective_from, effective_to, priority, is_active)
      VALUES (%L::uuid, %L::uuid, %L::timestamptz, %L::timestamptz, 0, true)
    $sql$,
      v_branch_base::text,
      v_zone::text,
      (v_now + interval '2 days')::text,
      (v_now + interval '2 days 1 hour')::text
    ),
    '42501',
    'new row violates row-level security policy for table "branch_coverage_windows"'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['agreements_admin'], v_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'agreements_admin'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  INSERT INTO public.service_levels (organization_id, key, name, is_active)
  VALUES (v_org, 'premium', 'Premium', TRUE);
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.service_levels WHERE organization_id = v_org AND key = 'premium') = 1,
    'RBAC: agreements_admin can write service_levels'
  );

  INSERT INTO public.branch_coverage_windows (branch_id, zone_id, effective_from, effective_to, priority, is_active)
  VALUES (v_branch_base, v_zone, v_now + interval '2 days', v_now + interval '2 days 1 hour', 0, TRUE);
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.branch_coverage_windows WHERE branch_id = v_branch_base AND zone_id = v_zone AND effective_from >= v_now + interval '2 days') = 1,
    'RBAC: agreements_admin can write branch_coverage_windows'
  );
END $$;

SELECT * FROM finish();

ROLLBACK;
