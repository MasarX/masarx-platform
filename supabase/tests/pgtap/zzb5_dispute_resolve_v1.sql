-- pgTAP: public.dispute_resolve_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

-- Fixtures: an open marketplace_dispute between two orgs.
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000b5b0';
  v_org2 UUID := '00000000-0000-0000-0000-00000000b5b1';
  v_dispute1 UUID := '00000000-0000-0000-0000-00000000b5b2';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b5b3';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b5b4';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'B5 Resolve Org A', 'b5-resolve-a-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org2, 'B5 Resolve Org B', 'b5-resolve-b-' || left(v_org2::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'b5-resolve-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B5 Resolve Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'b5-resolve-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B5 Resolve Sender', 'account_manager', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.marketplace_disputes (
    id, opened_by_organization_id, counterparty_organization_id,
    status, category, title, description
  )
  VALUES (
    v_dispute1, v_org1, v_org2,
    'open', 'general', 'B5 Test Dispute', 'pgtap fixture'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b5d_org1', v_org1::text, true);
  PERFORM set_config('test.b5d_dispute1', v_dispute1::text, true);
  PERFORM set_config('test.b5d_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.b5d_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can resolve an open dispute
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5d_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.dispute_resolve_v1(jsonb_build_object(
      'dispute_id', current_setting('test.b5d_dispute1'),
      'resolution', 'pgtap-resolved-in-favor-of-supplier'
    ))->>'ok')::bool
  ),
  'ops_admin can dispute_resolve_v1 (open -> resolved)'
);
RESET ROLE;

-- 2) Denied: non-admin user lacks disputes.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5d_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.dispute_resolve_v1(jsonb_build_object(
       'dispute_id', current_setting('test.b5d_dispute1'),
       'resolution', 'denied-attempt'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied dispute_resolve_v1 (disputes.write missing)'
);
RESET ROLE;

-- 3) Ladder: capability resolves through global access_control_policy (newly seeded by B5 foundation)
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

-- 4) RLS isolation: marketplace_disputes service-only writes
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.marketplace_disputes', 'update'),
  'authenticated has no direct UPDATE on marketplace_disputes (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
