-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Route runs foundation v1 (route_runs + route_stops)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

CREATE OR REPLACE FUNCTION test_route_runs_foundation_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0d100000-0000-0000-0000-000000000001'::uuid;
  v_org2 UUID := '0d200000-0000-0000-0000-000000000002'::uuid;

  v_branch1 UUID := '0d100000-0000-0000-0000-000000000101'::uuid;
  v_branch2 UUID := '0d200000-0000-0000-0000-000000000102'::uuid;

  v_client1 UUID := '0d100000-0000-0000-0000-000000000201'::uuid;
  v_client2 UUID := '0d200000-0000-0000-0000-000000000202'::uuid;

  v_sender1 UUID := '0d100000-0000-0000-0000-000000000301'::uuid;
  v_sender2 UUID := '0d200000-0000-0000-0000-000000000302'::uuid;

  v_tenant_user1 UUID := '0d100000-0000-0000-0000-000000000401'::uuid;
  v_tenant_user2 UUID := '0d200000-0000-0000-0000-000000000402'::uuid;
  v_client_user1 UUID := '0d100000-0000-0000-0000-000000000403'::uuid;
  v_sender_user1 UUID := '0d100000-0000-0000-0000-000000000404'::uuid;

  v_vehicle1 UUID := '0d100000-0000-0000-0000-000000000501'::uuid;
  v_vehicle2 UUID := '0d200000-0000-0000-0000-000000000502'::uuid;

  v_route_run1 UUID := '0d100000-0000-0000-0000-000000000601'::uuid;
  v_route_run2 UUID := '0d200000-0000-0000-0000-000000000602'::uuid;

  v_shipment1 UUID := '0d100000-0000-0000-0000-000000000701'::uuid;
  v_shipment2 UUID := '0d200000-0000-0000-0000-000000000702'::uuid;

  v_route_stop1 UUID := '0d100000-0000-0000-0000-000000000801'::uuid;
BEGIN
  RETURN NEXT has_table('public', 'route_runs', 'route_runs table exists');
  RETURN NEXT has_table('public', 'route_stops', 'route_stops table exists');

  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'route_runs'), 'RLS enabled on route_runs');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'route_stops'), 'RLS enabled on route_stops');

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'route_runs'),
    'route_runs registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'route_stops'),
    'route_stops registered in table_contracts'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'route_stops'
        AND indexname = 'idx_route_stops_run_sequence'
    ),
    'route_stops has idx_route_stops_run_sequence'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'route_stops'
        AND indexname = 'idx_route_stops_run_shipment'
    ),
    'route_stops has idx_route_stops_run_shipment'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'route_stops'
        AND indexname = 'idx_route_stops_client_shipment'
    ),
    'route_stops has idx_route_stops_client_shipment'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'Route Org 1', 'route-org-' || left(v_org1::text, 8)),
    (v_org2, 'Route Org 2', 'route-org-' || left(v_org2::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_branch1, v_org1, 'route-b1', 'Route Branch 1', 'UTC', TRUE),
    (v_branch2, v_org2, 'route-b2', 'Route Branch 2', 'UTC', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client1, v_org1, 'Route Client 1', 'route-client-' || left(v_client1::text, 8), 'active'),
    (v_client2, v_org2, 'Route Client 2', 'route-client-' || left(v_client2::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES
    (v_sender1, v_client1, 'Route Sender 1', 'Route Sender 1', TRUE, 'active'),
    (v_sender2, v_client2, 'Route Sender 2', 'Route Sender 2', TRUE, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type, access_scope_id)
  VALUES
    (v_tenant_user1, v_org1, 'route-u1-' || left(v_tenant_user1::text, 8) || '@example.com', 'Route Tenant 1', 'tenant', NULL),
    (v_tenant_user2, v_org2, 'route-u2-' || left(v_tenant_user2::text, 8) || '@example.com', 'Route Tenant 2', 'tenant', NULL),
    (v_client_user1, v_org1, 'route-cu-' || left(v_client_user1::text, 8) || '@example.com', 'Route Client User', 'client', v_client1),
    (v_sender_user1, v_org1, 'route-su-' || left(v_sender_user1::text, 8) || '@example.com', 'Route Sender User', 'sender', v_sender1);

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES
    (v_vehicle1, v_org1, 'active', TRUE),
    (v_vehicle2, v_org2, 'active', TRUE);

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES
    (v_shipment1, v_org1, v_client1, v_sender1, 'delivery', 'pgtap-route-' || left(v_shipment1::text, 8), 'created'),
    (v_shipment2, v_org2, v_client2, v_sender2, 'delivery', 'pgtap-route-' || left(v_shipment2::text, 8), 'created');

  RETURN NEXT lives_ok(
    format(
      $q$ INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, vehicle_id, status)
          VALUES (%L, %L, %L, %L, %L, 'planned') $q$,
      v_route_run1,
      v_org1,
      v_branch1,
      v_tenant_user1,
      v_vehicle1
    ),
    'route_runs insert allowed when org matches'
  );

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, vehicle_id, status)
  VALUES (v_route_run2, v_org2, v_branch2, v_tenant_user2, v_vehicle2, 'planned');

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.route_runs (organization_id, branch_id, status) VALUES (%L, %L, 'planned') $q$,
      v_org1,
      v_branch2
    ),
    '23514',
    format('route_runs: organization mismatch (route_run org %s, branch org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.route_runs (organization_id, vehicle_id, status) VALUES (%L, %L, 'planned') $q$,
      v_org1,
      v_vehicle2
    ),
    '23514',
    format('route_runs: organization mismatch (route_run org %s, vehicle org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.route_runs (organization_id, driver_user_id, status) VALUES (%L, %L, 'planned') $q$,
      v_org1,
      v_tenant_user2
    ),
    '23514',
    format('route_runs: organization mismatch (route_run org %s, user org %s)', v_org1, v_org2)
  );

  RETURN NEXT lives_ok(
    format(
      $q$ INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
          VALUES (%L, %L, %L, %L, %L, 'delivery', 1) $q$,
      v_route_stop1,
      v_org1,
      v_route_run1,
      v_client1,
      v_shipment1
    ),
    'route_stops insert allowed when org matches'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.route_stops (organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
          VALUES (%L, %L, %L, %L, 'delivery', 1) $q$,
      v_org1,
      v_route_run2,
      v_client1,
      v_shipment1
    ),
    '23514',
    format('route_stops: organization mismatch (stop org %s, route_run org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.route_stops (organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
          VALUES (%L, %L, %L, %L, 'delivery', 1) $q$,
      v_org1,
      v_route_run1,
      v_client2,
      v_shipment1
    ),
    '23514',
    format('route_stops: organization mismatch (stop org %s, client org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.route_stops (organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
          VALUES (%L, %L, %L, %L, 'delivery', 2) $q$,
      v_org1,
      v_route_run1,
      v_client1,
      v_shipment2
    ),
    '23503',
    format('route_stops: shipment %s not found for client %s', v_shipment2, v_client1)
  );

  -- tenant user (org1) can read route plans for own org only
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user1::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.route_runs), 1, 'tenant user sees own org route_runs only');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.route_stops), 1, 'tenant user sees own org route_stops only');

  -- client/sender users cannot read route plans
  PERFORM set_config('request.jwt.claim.sub', v_client_user1::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.route_runs), 0, 'client user cannot read route_runs');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.route_stops), 0, 'client user cannot read route_stops');

  PERFORM set_config('request.jwt.claim.sub', v_sender_user1::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.route_runs), 0, 'sender user cannot read route_runs');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN;
END;
$function$;

SELECT * FROM test_route_runs_foundation_v1();

SELECT * FROM finish();

ROLLBACK;
