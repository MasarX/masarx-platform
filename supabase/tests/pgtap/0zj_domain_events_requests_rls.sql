-- Plan: PLAN-202601-frontend-portal-phase-10-request-history / Step: S04
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);
DO $$
DECLARE
  v_org1 UUID := gen_random_uuid();
  v_org2 UUID := gen_random_uuid();
  v_client_a UUID := gen_random_uuid();
  v_client_b UUID := gen_random_uuid();
  v_client_2 UUID := gen_random_uuid();
  v_sender_a1 UUID := gen_random_uuid();
  v_sender_2 UUID := gen_random_uuid();
  v_user_tenant UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_user_sender UUID := gen_random_uuid();
  v_user_platform UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  EXECUTE 'GRANT SELECT ON TABLE public.domain_events TO authenticated';

  INSERT INTO organizations (id, name, slug)
  VALUES
    (v_org1, 'Requests Org 1', 'req-org-' || left(v_org1::text, 8)),
    (v_org2, 'Requests Org 2', 'req-org-' || left(v_org2::text, 8));

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES
    (v_client_a, v_org1, 'Requests Client A', 'req-client-a-' || left(v_client_a::text, 8), 'active'),
    (v_client_b, v_org1, 'Requests Client B', 'req-client-b-' || left(v_client_b::text, 8), 'active'),
    (v_client_2, v_org2, 'Requests Client 2', 'req-client-2-' || left(v_client_2::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, brand_name, status)
  VALUES
    (v_sender_a1, v_client_a, 'Requests Sender A1', 'Requests Sender A1', 'active'),
    (v_sender_2, v_client_2, 'Requests Sender 2', 'Requests Sender 2', 'active');

  INSERT INTO users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id
  )
  VALUES
    (v_user_tenant, v_org1, 'tenant-' || left(v_user_tenant::text, 8) || '@example.com', 'Tenant User', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org1, 'client-' || left(v_user_client::text, 8) || '@example.com', 'Client User', 'client_admin', 'client', v_client_a),
    (v_user_sender, v_org1, 'sender-' || left(v_user_sender::text, 8) || '@example.com', 'Sender User', 'sender_user', 'sender', v_sender_a1),
    (v_user_platform, v_org1, 'platform-' || left(v_user_platform::text, 8) || '@example.com', 'Platform User', 'super_admin', 'platform', NULL);

  INSERT INTO domain_events (organization_id, event_type, payload, status)
  VALUES
    (v_org1, 'settings_change.requested', jsonb_build_object('client_id', v_client_a, 'sender_id', v_sender_a1), 'pending'),
    (v_org1, 'settings_change.requested', jsonb_build_object('sender_id', v_sender_a1), 'pending'),
    (v_org1, 'settings_change.requested', jsonb_build_object('client_id', v_client_b), 'pending'),
    (v_org1, 'settings_change.requested', '{}'::jsonb, 'pending'),
    (v_org2, 'settings_change.requested', jsonb_build_object('client_id', v_client_2, 'sender_id', v_sender_2), 'pending');

  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';

  -- tenant scope
  PERFORM set_config('request.jwt.claim.sub', v_user_tenant::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM domain_events WHERE organization_id = v_org1), 4, 'tenant sees org1 requests');
  PERFORM is((SELECT COUNT(*)::INT FROM domain_events WHERE organization_id = v_org2), 0, 'tenant cannot see org2 requests');

  EXECUTE 'RESET ROLE';

  -- client scope
  PERFORM set_config('request.jwt.claim.sub', v_user_client::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM domain_events), 2, 'client scope sees scoped requests');
  PERFORM is((SELECT COUNT(*)::INT FROM domain_events WHERE payload->>'client_id' = v_client_b::text), 0, 'client scope cannot see other client requests');
  PERFORM is((SELECT COUNT(*)::INT FROM domain_events WHERE NOT (payload ? 'client_id') AND NOT (payload ? 'sender_id')), 0, 'client scope cannot see org-only requests');

  EXECUTE 'RESET ROLE';

  -- sender scope
  PERFORM set_config('request.jwt.claim.sub', v_user_sender::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM domain_events), 2, 'sender scope sees sender requests');

  EXECUTE 'RESET ROLE';

  -- platform scope
  PERFORM set_config('request.jwt.claim.sub', v_user_platform::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM is((SELECT COUNT(*)::INT FROM domain_events WHERE organization_id = v_org1), 4, 'platform sees org1 requests');
  PERFORM is((SELECT COUNT(*)::INT FROM domain_events WHERE organization_id = v_org2), 1, 'platform sees other org requests');

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
