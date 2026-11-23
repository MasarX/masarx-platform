BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(4);

CREATE FUNCTION pg_temp.test_pickup_request_branch_labels()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $test$
DECLARE
  tenant_id UUID := gen_random_uuid();
  other_tenant_id UUID := gen_random_uuid();
  client_id UUID := gen_random_uuid();
  selected_branch UUID := gen_random_uuid();
  route_branch UUID := gen_random_uuid();
  other_branch UUID := gen_random_uuid();
  selected_pickup UUID := gen_random_uuid();
  routed_pickup UUID := gen_random_uuid();
  wrong_tenant_pickup UUID := gen_random_uuid();
  malformed_pickup UUID := gen_random_uuid();
  labels JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES
    (tenant_id, 'Pickup Fixture Tenant', 'pickup-fixture-' || tenant_id::text),
    (other_tenant_id, 'Other Fixture Tenant', 'pickup-fixture-' || other_tenant_id::text);
  INSERT INTO public.clients (id, organization_id, name, slug, status) VALUES
    (client_id, tenant_id, 'Pickup Fixture Client', 'pickup-fixture-' || client_id::text, 'active');
  INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active) VALUES
    (selected_branch, tenant_id, 'Requested Test Branch', 'test-' || left(selected_branch::text, 8), 'warehouse', 'UTC', TRUE),
    (route_branch, tenant_id, 'Route Test Branch', 'test-' || left(route_branch::text, 8), 'warehouse', 'UTC', TRUE),
    (other_branch, other_tenant_id, 'Other Test Branch', 'test-' || left(other_branch::text, 8), 'warehouse', 'UTC', TRUE);
  INSERT INTO public.shipments (id, organization_id, client_id, service_type, tracking_number, status, box_count, metadata)
  SELECT id, tenant_id, client_id, 'pickup', 'TEST-' || left(id::text, 8), 'pickup_requested', 1,
    jsonb_build_object('pickup_request', jsonb_build_object('branch_id', request_branch))
  FROM (VALUES
    (selected_pickup, selected_branch::text),
    (routed_pickup, selected_branch::text),
    (wrong_tenant_pickup, other_branch::text),
    (malformed_pickup, 'invalid-branch')
  ) AS test_case(id, request_branch);

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
  PERFORM public.create_route_run_v1(jsonb_build_object(
    'organization_id', tenant_id,
    'branch_id', route_branch,
    'stops', jsonb_build_array(jsonb_build_object(
      'client_id', client_id, 'shipment_id', routed_pickup, 'stop_kind', 'pickup', 'sequence_order', 1
    ))
  ));
  labels := api.pickup_relationship_labels_v1(
    ARRAY[selected_pickup, routed_pickup, wrong_tenant_pickup, malformed_pickup], ARRAY[]::UUID[]
  );

  RETURN NEXT is(labels->('shipment:' || selected_pickup::text)->>'branch_label', 'Requested Test Branch',
                 'an unassigned pickup shows its requested branch');
  RETURN NEXT is(labels->('shipment:' || routed_pickup::text)->>'branch_id', route_branch::text,
                 'a route pickup stop uses the route branch over the requested branch');
  RETURN NEXT ok(NOT (labels->('shipment:' || wrong_tenant_pickup::text) ? 'branch_id'),
                 'a branch from another tenant is hidden');
  RETURN NEXT ok(NOT (labels->('shipment:' || malformed_pickup::text) ? 'branch_id'),
                 'invalid historical branch metadata is ignored');
END;
$test$;

SELECT * FROM pg_temp.test_pickup_request_branch_labels();
SELECT * FROM finish();
ROLLBACK;
