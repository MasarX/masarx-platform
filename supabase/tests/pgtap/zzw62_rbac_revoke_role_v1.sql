-- pgTAP: public.rbac_revoke_role_v1 contract (allowed/denied/RLS/idempotence)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

DO $$
DECLARE
  v_org UUID := '00000062-0400-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000062-0400-0000-0000-000000000a01'::uuid;
  v_target UUID := '00000062-0400-0000-0000-000000000a02'::uuid;
  v_sender UUID := '00000062-0400-0000-0000-000000000a03'::uuid;
  v_role UUID := '00000062-0400-0000-0000-000000000b01'::uuid;
  v_assignment UUID := '00000062-0400-0000-0000-000000000c01'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W6-2 RBAC Revoke Org', 'w62-rbac-rv-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w62-rbac-rv-ops-' || left(v_ops::text, 8) || '@example.com',
     'W62 Ops', 'ops_admin', 'tenant', NULL),
    (v_target, v_org, 'w62-rbac-rv-target-' || left(v_target::text, 8) || '@example.com',
     'W62 Target', 'client_admin', 'tenant', NULL),
    (v_sender, v_org, 'w62-rbac-rv-sender-' || left(v_sender::text, 8) || '@example.com',
     'W62 Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (id, organization_id, key, name, is_active)
  VALUES (v_role, v_org, 'w62_revoke_role', 'W62 Revoke Role', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (id, organization_id, user_id, role_id)
  VALUES (v_assignment, v_org, v_target, v_role)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('test.w62_rbac_rv_org', v_org::text, true);
  PERFORM set_config('test.w62_rbac_rv_ops', v_ops::text, true);
  PERFORM set_config('test.w62_rbac_rv_target', v_target::text, true);
  PERFORM set_config('test.w62_rbac_rv_sender', v_sender::text, true);
  PERFORM set_config('test.w62_rbac_rv_role', v_role::text, true);
  PERFORM set_config('test.w62_rbac_rv_assignment', v_assignment::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin revokes active assignment by id.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_rv_ops'), true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.rbac_revoke_role_v1(jsonb_build_object(
       'assignment_id', current_setting('test.w62_rbac_rv_assignment'),
       'reason', 'no longer required'
     )) $$,
  'ops_admin can rbac_revoke_role_v1 (revoke path)'
);
RESET ROLE;

-- 2) Readback: assignment is no longer active after revoke.
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments
     WHERE id = current_setting('test.w62_rbac_rv_assignment')::uuid
       AND revoked_at IS NOT NULL
  ),
  'rbac_revoke_role_v1 persisted revoked assignment state'
);

-- 3) Readback: revoke reason is preserved in assignment metadata.
SELECT is(
  (
    SELECT metadata->>'revoke_reason'
      FROM public.rbac_user_role_assignments
     WHERE id = current_setting('test.w62_rbac_rv_assignment')::uuid
  ),
  'no longer required',
  'rbac_revoke_role_v1 persisted revoke reason metadata'
);

-- 4) Denied (sender_user): blocked by capability gate
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_rv_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.rbac_revoke_role_v1(jsonb_build_object(
       'assignment_id', current_setting('test.w62_rbac_rv_assignment')
     )) $$,
  '42501',
  NULL,
  'sender_user denied rbac_revoke_role_v1'
);
RESET ROLE;

-- 5) RLS still enabled on rbac_user_role_assignments
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rbac_user_role_assignments'::regclass),
  'rbac_user_role_assignments has RLS enabled'
);

-- 6) Idempotence: repeat revoke returns idempotent_no_op=true
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_rv_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (public.rbac_revoke_role_v1(jsonb_build_object(
      'assignment_id', current_setting('test.w62_rbac_rv_assignment')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'rbac_revoke_role_v1 idempotent on already-revoked assignment'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
