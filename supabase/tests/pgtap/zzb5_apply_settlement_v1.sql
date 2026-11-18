-- pgTAP: public.apply_settlement_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

-- Fixtures: a locked settlement_batch ready for approval.
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000b570';
  v_branch1 UUID := '00000000-0000-0000-0000-00000000b571';
  v_batch1 UUID := '00000000-0000-0000-0000-00000000b572';
  v_open_batch UUID := '00000000-0000-0000-0000-00000000b575';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b573';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b574';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'B5 Apply Org', 'b5-apply-org-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch1, v_org1, 'b5b-' || left(v_branch1::text, 8), 'B5 Branch')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'b5-apply-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B5 Apply Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'b5-apply-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B5 Apply Sender', 'account_manager', 'tenant', NULL)
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
    v_open_batch, v_org1, 'cod', 'branch_day', v_branch1,
    'branch', v_branch1, 'open', 1
  )
  ON CONFLICT (id) DO UPDATE SET status = 'open', version = 1;

  PERFORM set_config('test.b5a_org1', v_org1::text, true);
  PERFORM set_config('test.b5a_batch1', v_batch1::text, true);
  PERFORM set_config('test.b5a_open_batch', v_open_batch::text, true);
  PERFORM set_config('test.b5a_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.b5a_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can apply (approve) a locked settlement
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5a_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.apply_settlement_v1(jsonb_build_object(
      'settlement_batch_id', current_setting('test.b5a_batch1'),
      'approval_notes', 'pgtap-apply'
    ))->>'ok')::bool
  ),
  'ops_admin can apply_settlement_v1 (locked -> approved)'
);
RESET ROLE;

-- 2) Denied: approval must not bypass the lock step
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5a_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.apply_settlement_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.b5a_open_batch')
     )) $$,
  '22023',
  NULL,
  'ops_admin cannot apply_settlement_v1 directly from open status'
);
RESET ROLE;

-- 3) Denied: non-admin user lacks settlements.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5a_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.apply_settlement_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.b5a_batch1')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied apply_settlement_v1 (settlements.write missing)'
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
