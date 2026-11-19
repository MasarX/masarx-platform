-- pgTAP: public.v_warehouse_transfer_summary projection contract (shape/RLS/projection)
-- Spec-Issue: W11-3 (paired projection views — PLATFORM warehouse_transfers)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_warehouse_transfer_summary',
  'public.v_warehouse_transfer_summary view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_warehouse_transfer_summary',
  ARRAY[
    'id', 'organization_id', 'transfer_code',
    'from_branch_id', 'to_branch_id', 'status',
    'dispatched_at', 'received_at', 'posted_at',
    'item_count', 'received_count', 'variance_count',
    'variance_flag', 'hold_reason',
    'created_at', 'updated_at'
  ],
  'v_warehouse_transfer_summary exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_warehouse_transfer_summary', 'SELECT'),
  'service_role has SELECT on v_warehouse_transfer_summary'
);

-- 4) anon has no SELECT (RLS baseline)
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_warehouse_transfer_summary', 'SELECT'),
  'anon has no SELECT on v_warehouse_transfer_summary'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_warehouse_transfer_summary', 'SELECT'),
  'authenticated has SELECT on v_warehouse_transfer_summary'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'warehouse_transfers'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.warehouse_transfers remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a transfer with items + a destination scan event,
--    verify item_count + received_count + variance_count + variance_flag.
DO $$
DECLARE
  v_org           UUID := '00000000-0000-0000-0000-00000011c301';
  v_from          UUID := '00000000-0000-0000-0000-00000011c302';
  v_to            UUID := '00000000-0000-0000-0000-00000011c303';
  v_client        UUID := '00000000-0000-0000-0000-00000011c304';
  v_transfer      UUID := '00000000-0000-0000-0000-00000011c305';
  v_shipment_a    UUID := '00000000-0000-0000-0000-00000011c310';
  v_shipment_b    UUID := '00000000-0000-0000-0000-00000011c311';
  v_user          UUID := '00000000-0000-0000-0000-00000011c320';
  v_scan          UUID := '00000000-0000-0000-0000-00000011c330';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  -- Org
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W11-3 Transfer View Org', 'w113-tv-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  -- Branches
  INSERT INTO public.branches (
    id, organization_id, code, name, branch_type, timezone,
    operating_hours, address, is_active
  )
  VALUES
    (v_from, v_org, 'w113-from-' || left(v_from::text, 8), 'W11-3 From',
     'hub', 'Asia/Riyadh', '{}'::jsonb, '{}'::jsonb, TRUE),
    (v_to, v_org, 'w113-to-' || left(v_to::text, 8), 'W11-3 To',
     'hub', 'Asia/Riyadh', '{}'::jsonb, '{}'::jsonb, TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Client (warehouse_transfer_items requires it)
  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'W11-3 Test Client', 'w113-test-client')
  ON CONFLICT (id) DO NOTHING;

  -- User (for actor_user_id on scan events)
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (v_user, v_org, 'w113-test@example.com', 'W11-3 Tester', 'ops_admin', 'active')
  ON CONFLICT (id) DO NOTHING;

  -- Transfer (received status so variance_flag fires when items > received)
  INSERT INTO public.warehouse_transfers (
    id, organization_id, from_branch_id, to_branch_id, status, transfer_code,
    dispatched_at, received_at
  )
  VALUES (
    v_transfer, v_org, v_from, v_to, 'received', 'WTR-W113-TEST',
    now() - interval '2 hours', now() - interval '30 minutes'
  )
  ON CONFLICT ON CONSTRAINT warehouse_transfers_pkey DO NOTHING;

  -- Shipments (transfer items reference shipments via FK)
  INSERT INTO public.shipments (id, client_id, organization_id, service_type, tracking_number, status)
  VALUES
    (v_shipment_a, v_client, v_org, 'delivery', 'W113-SHP-A', 'in_transit'),
    (v_shipment_b, v_client, v_org, 'delivery', 'W113-SHP-B', 'in_transit')
  ON CONFLICT ON CONSTRAINT shipments_pkey DO NOTHING;

  -- 2 transfer items (item_count = 2)
  INSERT INTO public.warehouse_transfer_items (
    id, organization_id, transfer_id, client_id, shipment_id
  )
  VALUES
    ('00000000-0000-0000-0000-00000011c340', v_org, v_transfer, v_client, v_shipment_a),
    ('00000000-0000-0000-0000-00000011c341', v_org, v_transfer, v_client, v_shipment_b)
  ON CONFLICT ON CONSTRAINT warehouse_transfer_items_unique DO NOTHING;

  -- 1 destination scan event (received_count = 1, variance_count = 1, variance_flag = TRUE)
  DELETE FROM public.scan_events
   WHERE id = v_scan;

  INSERT INTO public.scan_events (
    id, organization_id, actor_user_id,
    client_id, shipment_id, warehouse_transfer_id,
    scan_type, barcode, idempotency_key, metadata,
    captured_at
  )
  VALUES (
    v_scan, v_org, v_user,
    v_client, v_shipment_a, v_transfer,
    'warehouse_checkpoint', 'BAR-W113-TEST',
    'idem-w113-test',
    jsonb_build_object('checkpoint', 'destination_scan_in'),
    now() - interval '15 minutes'
  );

  PERFORM set_config('test.w113_transfer', v_transfer::text, true);
  EXECUTE 'RESET ROLE';
END $$;

-- 7) item_count + received_count + variance_count agree with seeded fixtures.
SELECT is(
  (SELECT (item_count, received_count, variance_count, variance_flag)::text
     FROM public.v_warehouse_transfer_summary
    WHERE id = current_setting('test.w113_transfer')::uuid),
  '(2,1,1,t)',
  'v_warehouse_transfer_summary projects (item_count=2, received_count=1, variance_count=1, variance_flag=true) for a received transfer with one missing scan'
);

-- 8) variance_flag does NOT fire on in_transit transfers (post-arrival semantics).
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000011c301';
  v_from     UUID := '00000000-0000-0000-0000-00000011c302';
  v_to       UUID := '00000000-0000-0000-0000-00000011c303';
  v_client   UUID := '00000000-0000-0000-0000-00000011c304';
  v_transit  UUID := '00000000-0000-0000-0000-00000011c350';
  v_ship_x   UUID := '00000000-0000-0000-0000-00000011c360';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  -- Reuse org/branches/client from previous block (same TX).

  INSERT INTO public.warehouse_transfers (
    id, organization_id, from_branch_id, to_branch_id, status, transfer_code,
    dispatched_at, received_at
  )
  VALUES (
    v_transit, v_org, v_from, v_to, 'in_transit', 'WTR-W113-TRANSIT',
    now() - interval '20 minutes', NULL
  )
  ON CONFLICT ON CONSTRAINT warehouse_transfers_pkey DO NOTHING;

  INSERT INTO public.shipments (id, client_id, organization_id, service_type, tracking_number, status)
  VALUES (v_ship_x, v_client, v_org, 'delivery', 'W113-SHP-X', 'in_transit')
  ON CONFLICT ON CONSTRAINT shipments_pkey DO NOTHING;

  INSERT INTO public.warehouse_transfer_items (
    id, organization_id, transfer_id, client_id, shipment_id
  )
  VALUES (
    '00000000-0000-0000-0000-00000011c370', v_org, v_transit, v_client, v_ship_x
  )
  ON CONFLICT ON CONSTRAINT warehouse_transfer_items_unique DO NOTHING;

  PERFORM set_config('test.w113_transit_transfer', v_transit::text, true);
  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (SELECT variance_flag::text
     FROM public.v_warehouse_transfer_summary
    WHERE id = current_setting('test.w113_transit_transfer')::uuid),
  'false',
  'v_warehouse_transfer_summary suppresses variance_flag for in_transit transfers (post-arrival statuses only)'
);

SELECT * FROM finish();
ROLLBACK;
