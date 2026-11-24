BEGIN;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'realtime.messages'::regclass),
  'Realtime uses row-level security');

CREATE FUNCTION pg_temp.check_console_live_scope()
RETURNS SETOF text
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_other_actor uuid := gen_random_uuid();
  v_narrow_actor uuid := gen_random_uuid();
  v_unprivileged uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_routes text := 'console-live:' || v_org::text || ':routes';
  v_shipments text := 'console-live:' || v_org::text || ':shipments';
  v_other_routes text := 'console-live:' || v_other_org::text || ':routes';
  v_run uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Live test tenant', 'console-live-' || left(v_org::text, 8)),
    (v_other_org, 'Other live tenant', 'console-live-' || left(v_other_org::text, 8));
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Live test client', 'console-live-' || left(v_client::text, 8), 'active');
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (v_actor, v_org, 'live-' || left(v_actor::text, 8) || '@example.com', 'Fixture', 'ops_admin', 'active', 'tenant', NULL),
    (v_other_actor, v_other_org, 'live-' || left(v_other_actor::text, 8) || '@example.com', 'Fixture', 'ops_admin', 'active', 'tenant', NULL),
    (v_narrow_actor, v_org, 'live-' || left(v_narrow_actor::text, 8) || '@example.com', 'Fixture', 'ops_admin', 'active', 'client', v_client),
    (v_unprivileged, v_org, 'live-' || left(v_unprivileged::text, 8) || '@example.com', 'Fixture', 'driver', 'active', 'tenant', NULL);
  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:console-live');
  PERFORM public.bootstrap_tenant_onboarding_v1(v_other_org, 'pgtap:console-live');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_actor);
  PERFORM public.provision_rbac_roles_from_templates_v1(v_other_org, ARRAY['ops_admin'], v_other_actor);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT r.organization_id, actors.id, r.id, actors.id, '{"source":"pgtap"}'::jsonb
  FROM (VALUES (v_org, v_actor), (v_org, v_narrow_actor), (v_other_org, v_other_actor)) AS actors(org, id)
  JOIN public.rbac_roles r ON r.organization_id = actors.org AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.route_runs (id, organization_id)
  VALUES (v_run, v_org), (gen_random_uuid(), v_other_org);
  UPDATE public.route_runs SET planned_start_at = now() WHERE id = v_run;
  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
  VALUES (gen_random_uuid(), v_org, v_client, 'LIVE-' || left(v_org::text, 8), 'delivery', 'pending');

  RETURN NEXT is((SELECT count(*)::int FROM realtime.messages
    WHERE topic = v_routes AND event = 'invalidate' AND private AND payload - 'id' = '{}'::jsonb),
    1, 'route trigger emits a single private invalidation without domain data');
  RETURN NEXT is((SELECT count(*)::int FROM realtime.messages
    WHERE topic = v_shipments AND event = 'invalidate' AND private AND payload - 'id' = '{}'::jsonb),
    1, 'shipment trigger emits a private invalidation without domain data');

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM set_config('realtime.topic', v_routes, true);
  RETURN NEXT is((SELECT count(*)::int FROM realtime.messages WHERE topic = v_routes), 1,
    'a tenant-wide operator can receive route changes');
  PERFORM set_config('realtime.topic', v_shipments, true);
  RETURN NEXT is((SELECT count(*)::int FROM realtime.messages WHERE topic = v_shipments), 1,
    'a tenant-wide operator can receive shipment changes');
  PERFORM set_config('realtime.topic', v_other_routes, true);
  RETURN NEXT is((SELECT count(*)::int FROM realtime.messages WHERE topic = v_other_routes), 0,
    'first tenant receives nothing from the second tenant');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_other_actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_other_actor, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM set_config('realtime.topic', v_routes, true);
  RETURN NEXT is((SELECT count(*)::int FROM realtime.messages WHERE topic = v_routes), 0,
    'second tenant receives nothing from the first tenant');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_narrow_actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_narrow_actor, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  RETURN NEXT is((SELECT count(*)::int FROM realtime.messages WHERE topic = v_routes), 0,
    'a client-scoped member cannot subscribe to a tenant topic');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_unprivileged::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_unprivileged, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  RETURN NEXT is((SELECT count(*)::int FROM realtime.messages WHERE topic = v_routes), 0,
    'a driver with narrower row access cannot subscribe to tenant-wide routes');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  RETURN NEXT is((SELECT count(*)::int FROM realtime.messages WHERE topic = v_routes), 0,
    'an anonymous actor receives no tenant invalidations');
  RESET ROLE;
END;
$$;

SELECT * FROM pg_temp.check_console_live_scope();
SELECT * FROM finish();
ROLLBACK;
