-- Plan: PLAN-202512-rls-backlog-and-prod-postdeploy-verify-v1 / Step: S04
-- pgTAP: Multi-tenant org isolation smoke (authenticated)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

SELECT plan(16);

DO $$
DECLARE
  v_org1 UUID := gen_random_uuid();
  v_org2 UUID := gen_random_uuid();
  v_user1 UUID := gen_random_uuid();
  v_user2 UUID := gen_random_uuid();
  v_client1 UUID := gen_random_uuid();
  v_client2 UUID := gen_random_uuid();
  v_recipient1 UUID := gen_random_uuid();
  v_recipient2 UUID := gen_random_uuid();
  v_address1 UUID := gen_random_uuid();
  v_address2 UUID := gen_random_uuid();
  v_shipment1 UUID := gen_random_uuid();
  v_shipment2 UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES
    (v_org1, 'RLS Test Org 1', 'rls-org-' || left(v_org1::text, 8)),
    (v_org2, 'RLS Test Org 2', 'rls-org-' || left(v_org2::text, 8));

  INSERT INTO users (id, organization_id, email, full_name)
  VALUES
    (v_user1, v_org1, 'u1-' || left(v_user1::text, 8) || '@example.com', 'RLS Test User 1'),
    (v_user2, v_org2, 'u2-' || left(v_user2::text, 8) || '@example.com', 'RLS Test User 2');

  INSERT INTO clients (id, organization_id, name, slug)
  VALUES
    (v_client1, v_org1, 'RLS Test Client 1', 'rls-client-' || left(v_client1::text, 8)),
    (v_client2, v_org2, 'RLS Test Client 2', 'rls-client-' || left(v_client2::text, 8));

  INSERT INTO recipients (id, organization_id, client_id, name, phone_number)
  VALUES
    (v_recipient1, v_org1, v_client1, 'RLS Recipient 1', '+12025550123'),
    (v_recipient2, v_org2, v_client2, 'RLS Recipient 2', '+12025550123');

  INSERT INTO addresses (
    id, organization_id, client_id,
    raw_input, city, province, validation_status
  )
  VALUES
    (v_address1, v_org1, v_client1, 'rls test addr 1', 'Riyadh', 'Riyadh', 'pending'),
    (v_address2, v_org2, v_client2, 'rls test addr 2', 'Jeddah', 'Makkah', 'pending');

  INSERT INTO shipments (
    id, organization_id, client_id,
    service_type, tracking_number, status
  )
  VALUES
    (v_shipment1, v_org1, v_client1, 'delivery', 'RLS' || left(gen_random_uuid()::text, 12), 'created'),
    (v_shipment2, v_org2, v_client2, 'delivery', 'RLS' || left(gen_random_uuid()::text, 12), 'created');

  INSERT INTO shipment_actions (
    id, shipment_id, organization_id, client_id,
    action_type, action_category, timestamp
  )
  VALUES
    (gen_random_uuid(), v_shipment1, v_org1, v_client1, 'status_change', 'operational', now()),
    (gen_random_uuid(), v_shipment2, v_org2, v_client2, 'status_change', 'operational', now());

  -- user1 (org1)
  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM organizations WHERE id = v_org1), 1, 'user1 sees own organization');
  PERFORM is((SELECT COUNT(*)::INT FROM organizations WHERE id = v_org2), 0, 'user1 cannot see other organization');
  PERFORM is((SELECT COUNT(*)::INT FROM clients WHERE id = v_client1), 1, 'user1 sees own client');
  PERFORM is((SELECT COUNT(*)::INT FROM clients WHERE id = v_client2), 0, 'user1 cannot see other client');
  PERFORM is((SELECT COUNT(*)::INT FROM recipients WHERE id = v_recipient1), 1, 'user1 sees own recipient');
  PERFORM is((SELECT COUNT(*)::INT FROM recipients WHERE id = v_recipient2), 0, 'user1 cannot see other recipient');
  PERFORM is((SELECT COUNT(*)::INT FROM addresses WHERE id = v_address1), 1, 'user1 sees own address');
  PERFORM is((SELECT COUNT(*)::INT FROM addresses WHERE id = v_address2), 0, 'user1 cannot see other address');
  PERFORM is((SELECT COUNT(*)::INT FROM shipments WHERE id = v_shipment1), 1, 'user1 sees own shipment');
  PERFORM is((SELECT COUNT(*)::INT FROM shipments WHERE id = v_shipment2), 0, 'user1 cannot see other shipment');
  PERFORM is((SELECT COUNT(*)::INT FROM shipment_actions WHERE shipment_id = v_shipment1), 1, 'user1 sees own shipment actions');
  PERFORM is((SELECT COUNT(*)::INT FROM shipment_actions WHERE shipment_id = v_shipment2), 0, 'user1 cannot see other shipment actions');

  EXECUTE 'RESET ROLE';

  -- user2 (org2)
  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM organizations WHERE id = v_org2), 1, 'user2 sees own organization');
  PERFORM is((SELECT COUNT(*)::INT FROM organizations WHERE id = v_org1), 0, 'user2 cannot see other organization');
  PERFORM is((SELECT COUNT(*)::INT FROM shipment_actions WHERE shipment_id = v_shipment2), 1, 'user2 sees own shipment actions');
  PERFORM is((SELECT COUNT(*)::INT FROM shipment_actions WHERE shipment_id = v_shipment1), 0, 'user2 cannot see other shipment actions');

  EXECUTE 'RESET ROLE';
END$$;

SELECT * FROM finish();

ROLLBACK;

