BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_reader UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_other_driver UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_stop UUID := gen_random_uuid();
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_org, 'Returns Tenant A', 'returns-a-' || left(v_org::text, 8)),
    (v_other_org, 'Returns Tenant B', 'returns-b-' || left(v_other_org::text, 8));
  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type) VALUES
    (v_reader, v_org, 'returns-warehouse@example.test', 'Returns Warehouse Operator', 'warehouse_operator', 'active', 'tenant'),
    (v_driver, v_org, 'returns-driver@example.test', 'Returns Money Driver', 'fieldops_money_driver', 'active', 'tenant'),
    (v_other_driver, v_other_org, 'returns-other-driver@example.test', 'Returns Driver', 'driver', 'active', 'tenant');

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Returns Client', 'returns-client-' || left(v_client::text, 8));
  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Returns Sender', 'Returns Sender', TRUE, 'active');
  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number,
                                box_count, priority_score, status, status_updated_at)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', 'WB' || upper(left(v_shipment::text, 8)),
          1, 50, 'pending', now());
  INSERT INTO public.route_runs (id, organization_id, driver_user_id, status, planned_date, planned_start_at)
  VALUES (v_run, v_org, v_driver, 'in_progress', current_date, now());
  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, sequence_order, metadata)
  VALUES (v_stop, v_org, v_run, v_client, v_shipment, 1, '{"status":"failed"}');

  PERFORM set_config('test.returns_reader', v_reader::text, true);
  PERFORM set_config('test.returns_driver', v_driver::text, true);
  PERFORM set_config('test.returns_other_driver', v_other_driver::text, true);
  PERFORM set_config('test.returns_stop', v_stop::text, true);
END;
$$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.role = 'authenticated';
SELECT set_config('request.jwt.claim.sub', current_setting('test.returns_reader'), true);

-- Mutation: removing the returns.write assertion lets this same-tenant call proceed.
SELECT throws_ok(
  $$SELECT api.mark_fieldops_return_received_v1(current_setting('test.returns_stop')::uuid, gen_random_uuid())$$,
  '42501', 'Capability denied: returns.write',
  'a tenant user without returns.write cannot mark a return received'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.returns_other_driver'), true);

-- Mutation: removing the ownership check lets this capable driver proceed across tenants.
SELECT throws_ok(
  $$SELECT api.mark_fieldops_return_received_v1(current_setting('test.returns_stop')::uuid, gen_random_uuid())$$,
  '42501', format('mark_fieldops_return_received_v1: stop %s outside tenant scope', current_setting('test.returns_stop')),
  'a driver with returns.write cannot mark another tenant return received'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.returns_driver'), true);

-- Mutation: requiring the wrong capability denies the seeded money-driver role.
SELECT is(
  api.mark_fieldops_return_received_v1(current_setting('test.returns_stop')::uuid, gen_random_uuid())->>'state',
  'rto', 'a tenant driver with returns.write marks a return received'
);

RESET ROLE;

-- Mutation: skipping the route-stop update leaves the persisted status failed.
SELECT is(
  (SELECT metadata->>'status' FROM public.route_stops WHERE id = current_setting('test.returns_stop')::uuid),
  'rto', 'the return status is persisted on the route stop'
);

SELECT * FROM finish();
ROLLBACK;
