-- pgTAP: public.reject_settlement_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

-- Fixtures: a locked settlement_batch ready for rejection.
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000b580';
  v_branch1 UUID := '00000000-0000-0000-0000-00000000b581';
  v_batch1 UUID := '00000000-0000-0000-0000-00000000b582';
  v_approved_batch UUID := '00000000-0000-0000-0000-00000000b585';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b583';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b584';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'B5 Reject Org', 'b5-reject-org-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch1, v_org1, 'b5b-' || left(v_branch1::text, 8), 'B5 Reject Branch')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'b5-reject-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B5 Reject Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'b5-reject-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B5 Reject Sender', 'account_manager', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, branch_id,
    subject_type, subject_id, status, version
  )
  VALUES (
    v_batch1, v_org1, 'cod', 'branch_day', v_branch1,
    'branch', v_branch1, 'locked', 1
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, branch_id,
    subject_type, subject_id, status, version
  )
  VALUES (
    v_approved_batch, v_org1, 'cod', 'branch_day', v_branch1,
    'branch', v_branch1, 'approved', 1
  )
  ON CONFLICT (id) DO UPDATE SET status = 'approved', version = 1;

  PERFORM set_config('test.b5j_org1', v_org1::text, true);
  PERFORM set_config('test.b5j_batch1', v_batch1::text, true);
  PERFORM set_config('test.b5j_approved_batch', v_approved_batch::text, true);
  PERFORM set_config('test.b5j_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.b5j_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can reject (cancel) a locked settlement
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5j_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.reject_settlement_v1(jsonb_build_object(
      'settlement_batch_id', current_setting('test.b5j_batch1'),
      'rejection_reason', 'pgtap-mismatch'
    ))->>'ok')::bool
  ),
  'ops_admin can reject_settlement_v1 (locked -> canceled)'
);
RESET ROLE;

-- 2) Denied: approved settlements cannot be rejected from Console/API
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5j_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.reject_settlement_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.b5j_approved_batch'),
       'rejection_reason', 'approved state is no longer rejectable'
     )) $$,
  '22023',
  NULL,
  'ops_admin cannot reject_settlement_v1 from approved status'
);
RESET ROLE;

-- 3) Denied: non-admin user lacks settlements.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5j_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.reject_settlement_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.b5j_batch1'),
       'rejection_reason', 'denied-test'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied reject_settlement_v1 (settlements.write missing)'
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
       AND cap->>'key' = 'settlements.write'
  ),
  'settlements.write capability resolves at global ladder scope'
);

-- 5) RLS isolation: settlement_batches service-only writes
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.settlement_batches', 'update'),
  'authenticated has no direct UPDATE on settlement_batches (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
