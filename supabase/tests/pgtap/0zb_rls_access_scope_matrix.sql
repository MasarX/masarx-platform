-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- pgTAP: Access-scope RLS matrix (platform/tenant/client/sender)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(39);

DO $$
DECLARE
  v_org1 UUID := gen_random_uuid();
  v_org2 UUID := gen_random_uuid();

  v_client_a UUID := gen_random_uuid();
  v_client_b UUID := gen_random_uuid();
  v_client_2 UUID := gen_random_uuid();

  v_sender_a1 UUID := gen_random_uuid();
  v_sender_a2 UUID := gen_random_uuid();
  v_sender_2 UUID := gen_random_uuid();

  v_rec_a1 UUID := gen_random_uuid();
  v_rec_a2 UUID := gen_random_uuid();
  v_rec_b UUID := gen_random_uuid();
  v_rec_2 UUID := gen_random_uuid();

  v_addr_a1_origin UUID := gen_random_uuid();
  v_addr_a1_dest UUID := gen_random_uuid();
  v_addr_a2_origin UUID := gen_random_uuid();
  v_addr_a2_dest UUID := gen_random_uuid();
  v_addr_b UUID := gen_random_uuid();
  v_addr_2 UUID := gen_random_uuid();

  v_ship_a1 UUID := gen_random_uuid();
  v_ship_a2 UUID := gen_random_uuid();
  v_ship_b UUID := gen_random_uuid();
  v_ship_2 UUID := gen_random_uuid();

  v_task_a1 UUID := gen_random_uuid();
  v_task_b UUID := gen_random_uuid();
  v_task_org_only UUID := gen_random_uuid();
  v_task_2 UUID := gen_random_uuid();

  v_task_type_org1 UUID := gen_random_uuid();
  v_task_type_org2 UUID := gen_random_uuid();

  v_task_ssot_a1 UUID := gen_random_uuid();
  v_task_ssot_b UUID := gen_random_uuid();
  v_task_ssot_org_only UUID := gen_random_uuid();
  v_task_ssot_2 UUID := gen_random_uuid();

  v_user_tenant UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_user_sender UUID := gen_random_uuid();
  v_user_platform UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  EXECUTE 'GRANT SELECT ON TABLE public.manual_review_tasks TO authenticated';

  -- Keep this matrix deterministic and focused on RLS scope behavior only.
  -- Onboarding triggers can auto-create related records (for example default
  -- client senders), which changes seeded row counts and causes unrelated drift.
  IF EXISTS (
    SELECT 1
    FROM public.settings_category_registry scr
    WHERE scr.category = 'saas_onboarding_policy'
  ) THEN
    PERFORM public.upsert_settings_value_v1(
      'saas_onboarding_policy',
      'global',
      NULL,
      public.jsonb_deep_merge(
        COALESCE(public.resolve_settings('saas_onboarding_policy', 'global', NULL), '{}'::jsonb),
        jsonb_build_object(
          'enabled', FALSE,
          'client_defaults', jsonb_build_object('create_default_sender', FALSE)
        )
      ),
      1,
      'pgTAP: disable onboarding side-effects for RLS access-scope matrix'
    );
  END IF;

  INSERT INTO organizations (id, name, slug)
  VALUES
    (v_org1, 'Scope Org 1', 'scope-org-' || left(v_org1::text, 8)),
    (v_org2, 'Scope Org 2', 'scope-org-' || left(v_org2::text, 8));

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES
    (v_client_a, v_org1, 'Scope Client A', 'scope-client-a-' || left(v_client_a::text, 8), 'active'),
    (v_client_b, v_org1, 'Scope Client B', 'scope-client-b-' || left(v_client_b::text, 8), 'active'),
    (v_client_2, v_org2, 'Scope Client 2', 'scope-client-2-' || left(v_client_2::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, brand_name, status)
  VALUES
    (v_sender_a1, v_client_a, 'Sender A1', 'Sender A1', 'active'),
    (v_sender_a2, v_client_a, 'Sender A2', 'Sender A2', 'active'),
    (v_sender_2, v_client_2, 'Sender 2', 'Sender 2', 'active');

  INSERT INTO recipients (id, organization_id, client_id, name, phone_number)
  VALUES
    (v_rec_a1, v_org1, v_client_a, 'Recipient A1', '+10000000011'),
    (v_rec_a2, v_org1, v_client_a, 'Recipient A2', '+10000000012'),
    (v_rec_b, v_org1, v_client_b, 'Recipient B', '+10000000013'),
    (v_rec_2, v_org2, v_client_2, 'Recipient 2', '+10000000014');

  INSERT INTO addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    city,
    province,
    validation_status
  )
  VALUES
    (v_addr_a1_origin, v_org1, v_client_a, 'scope addr a1 origin', 'Riyadh', 'Riyadh', 'pending'),
    (v_addr_a1_dest, v_org1, v_client_a, 'scope addr a1 dest', 'Riyadh', 'Riyadh', 'pending'),
    (v_addr_a2_origin, v_org1, v_client_a, 'scope addr a2 origin', 'Riyadh', 'Riyadh', 'pending'),
    (v_addr_a2_dest, v_org1, v_client_a, 'scope addr a2 dest', 'Riyadh', 'Riyadh', 'pending'),
    (v_addr_b, v_org1, v_client_b, 'scope addr b', 'Jeddah', 'Makkah', 'pending'),
    (v_addr_2, v_org2, v_client_2, 'scope addr 2', 'Dammam', 'Eastern', 'pending');

  INSERT INTO shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    recipient_id,
    origin_address_id,
    destination_address_id,
    service_type,
    tracking_number,
    status
  )
  VALUES
    (v_ship_a1, v_org1, v_client_a, v_sender_a1, v_rec_a1, v_addr_a1_origin, v_addr_a1_dest, 'delivery', 'SCOPEA1-' || left(gen_random_uuid()::text, 8), 'created'),
    (v_ship_a2, v_org1, v_client_a, v_sender_a2, v_rec_a2, v_addr_a2_origin, v_addr_a2_dest, 'delivery', 'SCOPEA2-' || left(gen_random_uuid()::text, 8), 'created'),
    (v_ship_b, v_org1, v_client_b, NULL, v_rec_b, v_addr_b, v_addr_b, 'delivery', 'SCOPEB-' || left(gen_random_uuid()::text, 8), 'created'),
    (v_ship_2, v_org2, v_client_2, v_sender_2, v_rec_2, v_addr_2, v_addr_2, 'delivery', 'SCOPE2-' || left(gen_random_uuid()::text, 8), 'created');

  INSERT INTO shipment_actions (
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    timestamp
  )
  VALUES
    (v_ship_a1, v_org1, v_client_a, 'status_change', 'operational', now()),     
    (v_ship_a2, v_org1, v_client_a, 'status_change', 'operational', now()),     
    (v_ship_b, v_org1, v_client_b, 'status_change', 'operational', now()),      
    (v_ship_2, v_org2, v_client_2, 'status_change', 'operational', now());      

  INSERT INTO manual_review_tasks (
    id,
    organization_id,
    client_id,
    sender_id,
    task_type,
    status,
    metadata
  )
  VALUES
    (v_task_a1, v_org1, v_client_a, v_sender_a1, 'geocoding', 'pending', '{}'::jsonb),
    (v_task_b, v_org1, v_client_b, NULL, 'geocoding', 'pending', '{}'::jsonb),
    (v_task_org_only, v_org1, NULL, NULL, 'settings_approval', 'pending', '{}'::jsonb),
    (v_task_2, v_org2, v_client_2, v_sender_2, 'geocoding', 'pending', '{}'::jsonb);

  INSERT INTO task_types (
    id,
    organization_id,
    key,
    name,
    default_priority,
    default_queue_key,
    enabled
  )
  VALUES
    (v_task_type_org1, v_org1, 'delivery', 'Delivery', 50, 'default', TRUE),
    (v_task_type_org2, v_org2, 'delivery', 'Delivery', 50, 'default', TRUE);

  INSERT INTO tasks (
    id,
    organization_id,
    client_id,
    sender_id,
    task_type_id,
    status,
    priority,
    queue_key,
    version,
    metadata
  )
  VALUES
    (v_task_ssot_a1, v_org1, v_client_a, v_sender_a1, v_task_type_org1, 'open', 50, 'default', 1, '{}'::jsonb),
    (v_task_ssot_b, v_org1, v_client_b, NULL, v_task_type_org1, 'open', 50, 'default', 1, '{}'::jsonb),
    (v_task_ssot_org_only, v_org1, NULL, NULL, v_task_type_org1, 'open', 50, 'default', 1, '{}'::jsonb),
    (v_task_ssot_2, v_org2, v_client_2, v_sender_2, v_task_type_org2, 'open', 50, 'default', 1, '{}'::jsonb);

  INSERT INTO task_events (
    task_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    task_version,
    payload
  )
  VALUES
    (v_task_ssot_a1, v_org1, 'created', NULL, 'open', 1, '{}'::jsonb),
    (v_task_ssot_b, v_org1, 'created', NULL, 'open', 1, '{}'::jsonb),
    (v_task_ssot_org_only, v_org1, 'created', NULL, 'open', 1, '{}'::jsonb),
    (v_task_ssot_2, v_org2, 'created', NULL, 'open', 1, '{}'::jsonb);

  INSERT INTO users (
    id,
    organization_id,
    email,
    full_name,
    access_scope_type,
    access_scope_id
  )
  VALUES
    (v_user_tenant, v_org1, 'tenant-' || left(v_user_tenant::text, 8) || '@example.com', 'Tenant User', 'tenant', NULL),
    (v_user_client, v_org1, 'client-' || left(v_user_client::text, 8) || '@example.com', 'Client User', 'client', v_client_a),
    (v_user_sender, v_org1, 'sender-' || left(v_user_sender::text, 8) || '@example.com', 'Sender User', 'sender', v_sender_a1),
    (v_user_platform, v_org1, 'platform-' || left(v_user_platform::text, 8) || '@example.com', 'Platform User', 'platform', NULL);

  -- Validate deferred constraints (scope guard + partition-safe FKs) inside this tx.
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';

  -- tenant scope (org-level)
  PERFORM set_config('request.jwt.claim.sub', v_user_tenant::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM organizations WHERE id = v_org1), 1, 'tenant sees own org');
  PERFORM is((SELECT COUNT(*)::INT FROM organizations WHERE id = v_org2), 0, 'tenant cannot see other org');
  PERFORM is((SELECT COUNT(*)::INT FROM clients WHERE id IN (v_client_a, v_client_b)), 2, 'tenant sees org clients');
  PERFORM is((SELECT COUNT(*)::INT FROM shipments WHERE id IN (v_ship_a1, v_ship_a2, v_ship_b, v_ship_2) AND organization_id = v_org1), 3, 'tenant sees org shipments');
  PERFORM is((SELECT COUNT(*)::INT FROM shipment_actions WHERE shipment_id IN (v_ship_a1, v_ship_a2, v_ship_b, v_ship_2) AND organization_id = v_org1), 3, 'tenant sees org shipment actions');
  PERFORM is((SELECT COUNT(*)::INT FROM manual_review_tasks WHERE id IN (v_task_a1, v_task_b, v_task_org_only, v_task_2)), 3, 'tenant sees org manual review tasks');
  PERFORM is((SELECT COUNT(*)::INT FROM tasks WHERE id IN (v_task_ssot_a1, v_task_ssot_b, v_task_ssot_org_only, v_task_ssot_2)), 3, 'tenant sees org tasks');
  PERFORM is((SELECT COUNT(*)::INT FROM task_events WHERE task_id IN (v_task_ssot_a1, v_task_ssot_b, v_task_ssot_org_only, v_task_ssot_2)), 3, 'tenant sees org task events');
  PERFORM is((SELECT COUNT(*)::INT FROM task_types WHERE id IN (v_task_type_org1, v_task_type_org2)), 1, 'tenant sees org task types');

  EXECUTE 'RESET ROLE';

  -- client scope (single client)
  PERFORM set_config('request.jwt.claim.sub', v_user_client::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM clients WHERE id = v_client_a), 1, 'client scope sees its client');
  PERFORM is((SELECT COUNT(*)::INT FROM senders WHERE id IN (v_sender_a1, v_sender_a2, v_sender_2) AND client_id = v_client_a), 2, 'client scope sees its senders');
  PERFORM is((SELECT COUNT(*)::INT FROM shipments WHERE id IN (v_ship_a1, v_ship_a2, v_ship_b, v_ship_2) AND client_id = v_client_a), 2, 'client scope sees its shipments');
  PERFORM is((SELECT COUNT(*)::INT FROM shipments WHERE id IN (v_ship_a1, v_ship_a2, v_ship_b, v_ship_2) AND client_id = v_client_b), 0, 'client scope cannot see other client shipments');
  PERFORM is((SELECT COUNT(*)::INT FROM recipients WHERE id IN (v_rec_a1, v_rec_a2, v_rec_b, v_rec_2) AND client_id = v_client_a), 2, 'client scope sees its recipients');
  PERFORM is((SELECT COUNT(*)::INT FROM recipients WHERE id IN (v_rec_a1, v_rec_a2, v_rec_b, v_rec_2) AND client_id = v_client_b), 0, 'client scope cannot see other client recipients');
  PERFORM is((SELECT COUNT(*)::INT FROM shipment_actions WHERE shipment_id IN (v_ship_a1, v_ship_a2, v_ship_b, v_ship_2) AND client_id = v_client_a), 2, 'client scope sees its shipment actions');
  PERFORM is((SELECT COUNT(*)::INT FROM manual_review_tasks WHERE id IN (v_task_a1, v_task_b, v_task_org_only, v_task_2)), 1, 'client scope sees its manual review tasks');
  PERFORM is((SELECT COUNT(*)::INT FROM tasks WHERE id IN (v_task_ssot_a1, v_task_ssot_b, v_task_ssot_org_only, v_task_ssot_2)), 1, 'client scope sees its tasks');
  PERFORM is((SELECT COUNT(*)::INT FROM task_events WHERE task_id IN (v_task_ssot_a1, v_task_ssot_b, v_task_ssot_org_only, v_task_ssot_2)), 1, 'client scope sees its task events');
  PERFORM is((SELECT COUNT(*)::INT FROM task_types WHERE id IN (v_task_type_org1, v_task_type_org2)), 1, 'client scope sees org task types');

  EXECUTE 'RESET ROLE';

  -- sender scope (single sender)
  PERFORM set_config('request.jwt.claim.sub', v_user_sender::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM senders WHERE id = v_sender_a1), 1, 'sender scope sees its sender');
  PERFORM is((SELECT COUNT(*)::INT FROM shipments WHERE sender_id = v_sender_a1), 1, 'sender scope sees its shipments');
  PERFORM is((SELECT COUNT(*)::INT FROM recipients WHERE id = v_rec_a1), 1, 'sender scope sees linked recipient');
  PERFORM is((SELECT COUNT(*)::INT FROM recipients WHERE id = v_rec_a2), 0, 'sender scope cannot see other sender recipient');
  PERFORM is((SELECT COUNT(*)::INT FROM addresses WHERE id IN (v_addr_a1_origin, v_addr_a1_dest)), 2, 'sender scope sees linked addresses');
  PERFORM is((SELECT COUNT(*)::INT FROM addresses WHERE id IN (v_addr_a2_origin, v_addr_a2_dest)), 0, 'sender scope cannot see other sender addresses');
  PERFORM is((SELECT COUNT(*)::INT FROM shipment_actions WHERE shipment_id = v_ship_a1), 1, 'sender scope sees linked shipment actions');
  PERFORM is((SELECT COUNT(*)::INT FROM shipment_actions WHERE shipment_id = v_ship_a2), 0, 'sender scope cannot see other sender shipment actions');
  PERFORM is((SELECT COUNT(*)::INT FROM manual_review_tasks WHERE id IN (v_task_a1, v_task_b, v_task_org_only, v_task_2)), 1, 'sender scope sees its manual review tasks');
  PERFORM is((SELECT COUNT(*)::INT FROM tasks WHERE id IN (v_task_ssot_a1, v_task_ssot_b, v_task_ssot_org_only, v_task_ssot_2)), 1, 'sender scope sees its tasks');
  PERFORM is((SELECT COUNT(*)::INT FROM task_events WHERE task_id IN (v_task_ssot_a1, v_task_ssot_b, v_task_ssot_org_only, v_task_ssot_2)), 1, 'sender scope sees its task events');
  PERFORM is((SELECT COUNT(*)::INT FROM task_types WHERE id IN (v_task_type_org1, v_task_type_org2)), 1, 'sender scope sees org task types');

  EXECUTE 'RESET ROLE';

  -- platform scope (cross-organization)
  PERFORM set_config('request.jwt.claim.sub', v_user_platform::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM organizations WHERE id IN (v_org1, v_org2)), 2, 'platform sees all orgs');
  PERFORM is((SELECT COUNT(*)::INT FROM shipments WHERE id IN (v_ship_a1, v_ship_a2, v_ship_b, v_ship_2)), 4, 'platform sees all seeded shipments');
  PERFORM is((SELECT COUNT(*)::INT FROM shipment_actions WHERE shipment_id IN (v_ship_a1, v_ship_a2, v_ship_b, v_ship_2)), 4, 'platform sees all shipment actions');
  PERFORM is((SELECT COUNT(*)::INT FROM manual_review_tasks WHERE id IN (v_task_a1, v_task_b, v_task_org_only, v_task_2)), 4, 'platform sees all manual review tasks');
  PERFORM is((SELECT COUNT(*)::INT FROM tasks WHERE id IN (v_task_ssot_a1, v_task_ssot_b, v_task_ssot_org_only, v_task_ssot_2)), 4, 'platform sees all seeded tasks');
  PERFORM is((SELECT COUNT(*)::INT FROM task_events WHERE task_id IN (v_task_ssot_a1, v_task_ssot_b, v_task_ssot_org_only, v_task_ssot_2)), 4, 'platform sees all task events');
  PERFORM is((SELECT COUNT(*)::INT FROM task_types WHERE id IN (v_task_type_org1, v_task_type_org2)), 2, 'platform sees all task types');

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
