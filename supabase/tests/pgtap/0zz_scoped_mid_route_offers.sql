BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(12);

SELECT is((SELECT proargnames[2:5] FROM pg_proc WHERE oid = 'api.pending_mid_route_stops_v1(uuid)'::regprocedure),
  ARRAY['stop_id', 'injected_at', 'position', 'reason']::text[],
  'mid-route offers retain the position field for existing callers');
SELECT is((SELECT count(*) FROM api.pending_mid_route_stops_v1(NULL)), 0::bigint,
  'an offer read without an assigned route returns no rows');
SELECT ok(NOT has_table_privilege('authenticated', 'public.mid_route_stop_injections', 'SELECT'),
  'authenticated drivers cannot read the offer ledger directly');
SELECT ok(NOT has_table_privilege('authenticated', 'public.mid_route_stop_injections', 'UPDATE'),
  'an offer read does not grant route update authority');
SELECT ok(NOT has_function_privilege('anon', 'api.pending_mid_route_stops_v1(uuid)', 'EXECUTE'),
  'anonymous callers cannot read route offers');

CREATE FUNCTION pg_temp.check_mid_route_offers(p_actor uuid, p_route uuid, p_expected uuid[], p_case text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_result text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_actor)::text, true);
  SET LOCAL ROLE authenticated;
  v_result := is(ARRAY(SELECT stop_id FROM api.pending_mid_route_stops_v1(p_route)), p_expected, p_case);
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RETURN v_result;
END;
$$;

CREATE FUNCTION pg_temp.test_mid_route_offer_access()
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_foreign_org uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_shipment uuid := gen_random_uuid();
  v_route uuid := gen_random_uuid();
  v_stop uuid := gen_random_uuid();
  v_driver uuid := gen_random_uuid();
  v_other_driver uuid := gen_random_uuid();
  v_limited_actor uuid := gen_random_uuid();
  v_no_offers constant uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug)
  SELECT id, 'Route offer fixture tenant', 'offer-test-' || id
  FROM (VALUES (v_org), (v_foreign_org)) AS tenant(id);
  PERFORM set_config('app.organization_onboarding_source', '', true);
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Route offer client', 'offer-test-' || v_client, 'active');
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  SELECT id, org, id || '@example.test', 'Route offer fixture user', user_type, 'active', 'tenant'
  FROM (VALUES
    (v_driver, v_org, 'driver'),
    (v_other_driver, v_org, 'driver'),
    (v_limited_actor, v_org, 'finance_viewer')
  ) AS actor(id, org, user_type);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'route-offer-fixture');
  PERFORM public.bootstrap_tenant_onboarding_v1(v_foreign_org, 'route-offer-fixture');
  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
  VALUES (v_shipment, v_org, v_client, 'OFFER-' || v_shipment, 'delivery', 'pending');
  INSERT INTO public.route_runs (id, organization_id, driver_user_id, status)
  VALUES (v_route, v_org, v_driver, 'in_progress');
  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, sequence_order)
  VALUES (v_stop, v_org, v_route, v_client, v_shipment, 1);
  INSERT INTO public.mid_route_stop_injections (route_id, stop_id) VALUES (v_route, v_stop);

  RETURN NEXT pg_temp.check_mid_route_offers(v_driver, v_route, v_no_offers,
    'the assigned driver sees no offers until the tenant opts in');
  PERFORM public.upsert_settings_value_v1('mid_route_injection_policy', 'tenant', v_org, '{"enabled":true}', 1, 'Route offer fixture opt-in');
  RETURN NEXT pg_temp.check_mid_route_offers(v_driver, v_route, ARRAY[v_stop],
    'the assigned driver with route access sees the pending stop');

  -- The previous assignment still permits manifest reads, but only the current driver receives offers.
  INSERT INTO public.route_run_assignments (organization_id, route_run_id, driver_user_id, assignment_mode)
  VALUES (v_org, v_route, v_other_driver, 'internal_driver');
  RETURN NEXT pg_temp.check_mid_route_offers(v_other_driver, v_route, v_no_offers,
    'another driver in the same tenant with manifest access sees no offers');
  UPDATE public.route_runs SET driver_user_id = v_limited_actor WHERE id = v_route;
  RETURN NEXT pg_temp.check_mid_route_offers(v_limited_actor, v_route, v_no_offers,
    'the assigned actor without route access sees no offers');
  UPDATE public.route_runs SET driver_user_id = v_driver, status = 'completed' WHERE id = v_route;
  RETURN NEXT pg_temp.check_mid_route_offers(v_driver, v_route, v_no_offers,
    'the assigned driver sees no offers on a completed route');

  UPDATE public.route_runs SET status = 'in_progress' WHERE id = v_route;
  UPDATE public.mid_route_stop_injections SET acknowledged_at = clock_timestamp() WHERE route_id = v_route;
  RETURN NEXT pg_temp.check_mid_route_offers(v_driver, v_route, v_no_offers,
    'the assigned driver sees no acknowledged offers');

  UPDATE public.mid_route_stop_injections SET acknowledged_at = NULL WHERE route_id = v_route;
  -- Keep the route assignment stale when the driver moves to the other tenant.
  UPDATE public.users SET organization_id = v_foreign_org WHERE id = v_driver;
  RETURN NEXT pg_temp.check_mid_route_offers(v_driver, v_route, v_no_offers,
    'a driver whose assignment belongs to another tenant sees no offers');
END;
$$;

SELECT * FROM pg_temp.test_mid_route_offer_access();
SELECT * FROM finish();
ROLLBACK;
