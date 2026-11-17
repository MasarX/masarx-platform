-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Warehouse transfers + handling units foundation v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(31);

CREATE OR REPLACE FUNCTION pg_temp.test_warehouse_transfers_handling_units_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0d100000-0000-0000-0000-000000000001'::uuid;
  v_org2 UUID := '0d200000-0000-0000-0000-000000000002'::uuid;

  v_branch1_from UUID := '0d100000-0000-0000-0000-000000000101'::uuid;
  v_branch1_to UUID := '0d100000-0000-0000-0000-000000000102'::uuid;
  v_branch2_from UUID := '0d200000-0000-0000-0000-000000000103'::uuid;
  v_branch2_to UUID := '0d200000-0000-0000-0000-000000000104'::uuid;

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

  v_transfer1 UUID := '0d100000-0000-0000-0000-000000000601'::uuid;
  v_transfer2 UUID := '0d200000-0000-0000-0000-000000000602'::uuid;

  v_shipment1 UUID := '0d100000-0000-0000-0000-000000000701'::uuid;
  v_shipment2 UUID := '0d200000-0000-0000-0000-000000000702'::uuid;

  v_unit1 UUID := '0d100000-0000-0000-0000-000000000801'::uuid;
BEGIN
  RETURN NEXT has_table('public', 'handling_units', 'handling_units table exists');
  RETURN NEXT has_table('public', 'warehouse_transfers', 'warehouse_transfers table exists');
  RETURN NEXT has_table('public', 'warehouse_transfer_items', 'warehouse_transfer_items table exists');
  RETURN NEXT has_column('public', 'warehouse_transfers', 'received_shipment_count', 'warehouse_transfers.received_shipment_count exists');
  RETURN NEXT has_column('public', 'warehouse_transfers', 'damaged_shipment_count', 'warehouse_transfers.damaged_shipment_count exists');
  RETURN NEXT has_column('public', 'warehouse_transfers', 'missing_shipment_count', 'warehouse_transfers.missing_shipment_count exists');
  RETURN NEXT has_column('public', 'warehouse_transfers', 'unmanifested_shipment_count', 'warehouse_transfers.unmanifested_shipment_count exists');

  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'handling_units'), 'RLS enabled on handling_units');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'warehouse_transfers'), 'RLS enabled on warehouse_transfers');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'warehouse_transfer_items'), 'RLS enabled on warehouse_transfer_items');

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'handling_units'),
    'handling_units registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'warehouse_transfers'),
    'warehouse_transfers registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'warehouse_transfer_items'),
    'warehouse_transfer_items registered in table_contracts'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'handling_units'
        AND indexname = 'idx_handling_units_org_code'
    ),
    'handling_units has idx_handling_units_org_code'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'warehouse_transfers'
        AND indexname = 'idx_warehouse_transfers_org_branches_status'
    ),
    'warehouse_transfers has idx_warehouse_transfers_org_branches_status'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'warehouse_transfer_items'
        AND indexname = 'idx_warehouse_transfer_items_org_shipment'
    ),
    'warehouse_transfer_items has idx_warehouse_transfer_items_org_shipment'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'WH Org 1', 'wh-org-' || left(v_org1::text, 8)),
    (v_org2, 'WH Org 2', 'wh-org-' || left(v_org2::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_branch1_from, v_org1, 'wh-b1f', 'WH Branch 1 From', 'UTC', TRUE),
    (v_branch1_to, v_org1, 'wh-b1t', 'WH Branch 1 To', 'UTC', TRUE),
    (v_branch2_from, v_org2, 'wh-b2f', 'WH Branch 2 From', 'UTC', TRUE),
    (v_branch2_to, v_org2, 'wh-b2t', 'WH Branch 2 To', 'UTC', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client1, v_org1, 'WH Client 1', 'wh-client-' || left(v_client1::text, 8), 'active'),
    (v_client2, v_org2, 'WH Client 2', 'wh-client-' || left(v_client2::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES
    (v_sender1, v_client1, 'WH Sender 1', 'WH Sender 1', TRUE, 'active'),
    (v_sender2, v_client2, 'WH Sender 2', 'WH Sender 2', TRUE, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type, access_scope_id)
  VALUES
    (v_tenant_user1, v_org1, 'wh-u1-' || left(v_tenant_user1::text, 8) || '@example.com', 'WH Tenant 1', 'tenant', NULL),
    (v_tenant_user2, v_org2, 'wh-u2-' || left(v_tenant_user2::text, 8) || '@example.com', 'WH Tenant 2', 'tenant', NULL),
    (v_client_user1, v_org1, 'wh-cu-' || left(v_client_user1::text, 8) || '@example.com', 'WH Client User', 'client', v_client1),
    (v_sender_user1, v_org1, 'wh-su-' || left(v_sender_user1::text, 8) || '@example.com', 'WH Sender User', 'sender', v_sender1);

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES
    (v_vehicle1, v_org1, 'active', TRUE),
    (v_vehicle2, v_org2, 'active', TRUE);

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES
    (v_shipment1, v_org1, v_client1, v_sender1, 'delivery', 'pgtap-wh-' || left(v_shipment1::text, 8), 'created'),
    (v_shipment2, v_org2, v_client2, v_sender2, 'delivery', 'pgtap-wh-' || left(v_shipment2::text, 8), 'created');

  RETURN NEXT lives_ok(
    format(
      $q$ INSERT INTO public.handling_units (id, organization_id, branch_id, unit_type, status, code)
          VALUES (%L, %L, %L, 'bag', 'open', 'HU-001') $q$,
      v_unit1,
      v_org1,
      v_branch1_from
    ),
    'handling_units insert allowed when org matches'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.handling_units (organization_id, branch_id, unit_type, status, code)
          VALUES (%L, %L, 'bag', 'open', 'HU-X') $q$,
      v_org1,
      v_branch2_from
    ),
    '23514',
    format('handling_units: organization mismatch (unit org %s, branch org %s)', v_org1, v_org2)
  );

  RETURN NEXT lives_ok(
    format(
      $q$ INSERT INTO public.warehouse_transfers (id, organization_id, from_branch_id, to_branch_id, vehicle_id, driver_user_id, created_by_user_id, status)
          VALUES (%L, %L, %L, %L, %L, %L, %L, 'draft') $q$,
      v_transfer1,
      v_org1,
      v_branch1_from,
      v_branch1_to,
      v_vehicle1,
      v_tenant_user1,
      v_tenant_user1
    ),
    'warehouse_transfers insert allowed when org matches'
  );

  INSERT INTO public.warehouse_transfers (id, organization_id, from_branch_id, to_branch_id, vehicle_id, driver_user_id, created_by_user_id, status)
  VALUES (v_transfer2, v_org2, v_branch2_from, v_branch2_to, v_vehicle2, v_tenant_user2, v_tenant_user2, 'draft');

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.warehouse_transfers (organization_id, from_branch_id, to_branch_id, status)
          VALUES (%L, %L, %L, 'draft') $q$,
      v_org1,
      v_branch2_from,
      v_branch1_to
    ),
    '23514',
    format('warehouse_transfers: organization mismatch (transfer org %s, from_branch org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.warehouse_transfers (organization_id, from_branch_id, to_branch_id, status)
          VALUES (%L, %L, %L, 'draft') $q$,
      v_org1,
      v_branch1_from,
      v_branch1_from
    ),
    '23514',
    'warehouse_transfers: from_branch_id must differ from to_branch_id'
  );

  RETURN NEXT lives_ok(
    format(
      $q$ INSERT INTO public.warehouse_transfer_items (organization_id, transfer_id, client_id, shipment_id, added_by_user_id)
          VALUES (%L, %L, %L, %L, %L) $q$,
      v_org1,
      v_transfer1,
      v_client1,
      v_shipment1,
      v_tenant_user1
    ),
    'warehouse_transfer_items insert allowed when org matches'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.warehouse_transfer_items (organization_id, transfer_id, client_id, shipment_id, added_by_user_id)
          VALUES (%L, %L, %L, %L, %L) $q$,
      v_org1,
      v_transfer2,
      v_client1,
      v_shipment1,
      v_tenant_user1
    ),
    '23514',
    format('warehouse_transfer_items: organization mismatch (item org %s, transfer org %s)', v_org1, v_org2)
  );

  -- RLS: tenant-scoped users see only their org.
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::int FROM public.warehouse_transfers), 1, 'tenant user sees own org warehouse_transfers only');
  RETURN NEXT is((SELECT COUNT(*)::int FROM public.warehouse_transfer_items), 1, 'tenant user sees own org warehouse_transfer_items only');
  RETURN NEXT is((SELECT COUNT(*)::int FROM public.handling_units), 1, 'tenant user sees own org handling_units only');

  -- Client/sender scoped users cannot read warehouse ops tables.
  PERFORM set_config('request.jwt.claim.sub', v_client_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT COUNT(*)::int FROM public.warehouse_transfers), 0, 'client user cannot read warehouse_transfers');
  RETURN NEXT is((SELECT COUNT(*)::int FROM public.handling_units), 0, 'client user cannot read handling_units');
  RETURN NEXT is((SELECT COUNT(*)::int FROM public.warehouse_transfer_items), 0, 'client user cannot read warehouse_transfer_items');

  PERFORM set_config('request.jwt.claim.sub', v_sender_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT COUNT(*)::int FROM public.warehouse_transfers), 0, 'sender user cannot read warehouse_transfers');
  RETURN NEXT is((SELECT COUNT(*)::int FROM public.warehouse_transfer_items), 0, 'sender user cannot read warehouse_transfer_items');

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_warehouse_transfers_handling_units_v1();

SELECT * FROM finish();
ROLLBACK;
