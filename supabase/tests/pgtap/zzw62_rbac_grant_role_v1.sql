-- pgTAP: public.rbac_grant_role_v1 contract (allowed/denied/RLS/idempotence)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

DO $$
DECLARE
  v_org UUID := '00000062-0300-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000062-0300-0000-0000-000000000a01'::uuid;
  v_target UUID := '00000062-0300-0000-0000-000000000a02'::uuid;
  v_sender UUID := '00000062-0300-0000-0000-000000000a03'::uuid;
  v_role UUID := '00000062-0300-0000-0000-000000000b01'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W6-2 RBAC Grant Org', 'w62-rbac-gr-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w62-rbac-gr-ops-' || left(v_ops::text, 8) || '@example.com',
     'W62 Ops', 'ops_admin', 'tenant', NULL),
    (v_target, v_org, 'w62-rbac-gr-target-' || left(v_target::text, 8) || '@example.com',
     'W62 Target', 'client_admin', 'tenant', NULL),
    (v_sender, v_org, 'w62-rbac-gr-sender-' || left(v_sender::text, 8) || '@example.com',
     'W62 Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (id, organization_id, key, name, is_active)
  VALUES (v_role, v_org, 'w62_grant_role', 'W62 Grant Role', TRUE)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w62_rbac_gr_org', v_org::text, true);
  PERFORM set_config('test.w62_rbac_gr_ops', v_ops::text, true);
  PERFORM set_config('test.w62_rbac_gr_target', v_target::text, true);
  PERFORM set_config('test.w62_rbac_gr_sender', v_sender::text, true);
  PERFORM set_config('test.w62_rbac_gr_role', v_role::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin grant succeeds and returns assignment id.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_gr_ops'), true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.rbac_grant_role_v1(jsonb_build_object(
       'organization_id', current_setting('test.w62_rbac_gr_org'),
       'user_id', current_setting('test.w62_rbac_gr_target'),
       'role_id', current_setting('test.w62_rbac_gr_role')
     )) $$,
  'ops_admin can rbac_grant_role_v1 (grant path)'
);
RESET ROLE;

-- 2) Readback: grant created an active assignment for the requested user and role.
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments
     WHERE organization_id = current_setting('test.w62_rbac_gr_org')::uuid
       AND user_id = current_setting('test.w62_rbac_gr_target')::uuid
       AND role_id = current_setting('test.w62_rbac_gr_role')::uuid
       AND revoked_at IS NULL
  ),
  'rbac_grant_role_v1 persisted active assignment state'
);

-- 3) Denied (sender_user): blocked by capability gate
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_gr_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.rbac_grant_role_v1(jsonb_build_object(
       'organization_id', current_setting('test.w62_rbac_gr_org'),
       'user_id', current_setting('test.w62_rbac_gr_target'),
       'role_id', current_setting('test.w62_rbac_gr_role')
     )) $$,
  '42501',
  NULL,
  'sender_user denied rbac_grant_role_v1'
);
RESET ROLE;

-- 4) RLS enabled on rbac_user_role_assignments
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rbac_user_role_assignments'::regclass),
  'rbac_user_role_assignments has RLS enabled'
);

-- 5) Idempotence: re-grant returns idempotent_no_op=true on active assignment
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_gr_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (public.rbac_grant_role_v1(jsonb_build_object(
      'organization_id', current_setting('test.w62_rbac_gr_org'),
      'user_id', current_setting('test.w62_rbac_gr_target'),
      'role_id', current_setting('test.w62_rbac_gr_role')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'rbac_grant_role_v1 idempotent on existing active assignment'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
