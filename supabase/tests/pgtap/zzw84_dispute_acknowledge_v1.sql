-- pgTAP: public.dispute_acknowledge_v1 contract (allowed/denied/idempotent/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

-- Fixtures: an open marketplace_dispute between two orgs.
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000c4c0';
  v_org2 UUID := '00000000-0000-0000-0000-00000000c4c1';
  v_dispute1 UUID := '00000000-0000-0000-0000-00000000c4c2';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000c4c3';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000c4c4';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'W84 Ack Org A', 'w84-ack-a-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org2, 'W84 Ack Org B', 'w84-ack-b-' || left(v_org2::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'w84-ack-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'W84 Ack Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'w84-ack-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'W84 Ack Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.marketplace_disputes (
    id, opened_by_organization_id, counterparty_organization_id,
    status, category, title, description
  )
  VALUES (
    v_dispute1, v_org1, v_org2,
    'open', 'general', 'W84 Ack Dispute', 'pgtap fixture acknowledge'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w84a_org1', v_org1::text, true);
  PERFORM set_config('test.w84a_dispute1', v_dispute1::text, true);
  PERFORM set_config('test.w84a_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.w84a_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can acknowledge an open dispute (open -> under_review)
SELECT set_config('request.jwt.claim.sub', current_setting('test.w84a_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT is(
  (
    SELECT (public.dispute_acknowledge_v1(jsonb_build_object(
      'dispute_id', current_setting('test.w84a_dispute1')
    ))->>'status')
  ),
  'under_review',
  'ops_admin can dispute_acknowledge_v1 (open -> under_review)'
);

-- 2) Idempotent: re-acknowledging same dispute returns already_processed=true
SELECT is(
  (
    SELECT (public.dispute_acknowledge_v1(jsonb_build_object(
      'dispute_id', current_setting('test.w84a_dispute1')
    ))->>'already_processed')
  ),
  'true',
  're-acknowledging an under_review dispute is idempotent'
);
RESET ROLE;

-- 3) Denied: sender_user lacks disputes.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.w84a_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.dispute_acknowledge_v1(jsonb_build_object(
       'dispute_id', current_setting('test.w84a_dispute1')
     )) $$,
  '42501',
  NULL,
  'sender_user denied dispute_acknowledge_v1 (disputes.write missing)'
);
RESET ROLE;

-- 4) Ladder: capability resolves through global access_control_policy
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings sv,
           jsonb_array_elements(sv.cached_value->'capabilities') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND cap->>'key' = 'disputes.write'
  ),
  'disputes.write capability resolves at global ladder scope'
);

-- 5) RLS isolation: marketplace_disputes service-only writes
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.marketplace_disputes', 'update'),
  'authenticated has no direct UPDATE on marketplace_disputes (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
