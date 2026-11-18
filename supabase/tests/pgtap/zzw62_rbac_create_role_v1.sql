-- pgTAP: public.rbac_create_role_v1 contract (allowed/denied/RLS/idempotence)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000062-0000-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000062-0000-0000-0000-000000000a01'::uuid;
  v_sender UUID := '00000062-0000-0000-0000-000000000a02'::uuid;
  v_perm_id UUID;
  v_admin_role UUID := '00000062-0000-0000-0000-000000000b01'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W6-2 RBAC Create Org', 'w62-rbac-cr-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w62-rbac-cr-ops-' || left(v_ops::text, 8) || '@example.com',
     'W62 Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'w62-rbac-cr-sender-' || left(v_sender::text, 8) || '@example.com',
     'W62 Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  -- Grant access_policy.approve to ops_admin via an RBAC role mapping so the
  -- capability check passes (RBAC foundation v1 already seeds the permission).
  INSERT INTO public.rbac_roles (id, organization_id, key, name, description)
  VALUES (v_admin_role, v_org, 'w62_admin', 'W62 Admin', 'Test admin')
  ON CONFLICT (organization_id, key) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_admin_role;

  -- Map access_policy.approve permission to v_admin_role (assert_capability_v1
  -- relies on user_capability_eval_v1; for tests we exercise via the
  -- access-control policy chain set up by the migration baseline).
  -- Grant ops user the admin role.
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
  VALUES (v_org, v_ops, v_admin_role)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('test.w62_rbac_cr_org', v_org::text, true);
  PERFORM set_config('test.w62_rbac_cr_ops', v_ops::text, true);
  PERFORM set_config('test.w62_rbac_cr_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin has access_policy.approve and verifies happy path.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_cr_ops'), true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.rbac_create_role_v1(jsonb_build_object(
       'organization_id', current_setting('test.w62_rbac_cr_org'),
       'key', 'w62_role_alpha',
       'name', 'W62 Role Alpha'
     )) $$,
  'ops_admin can rbac_create_role_v1 (happy path)'
);
RESET ROLE;

-- 2) Denied (sender_user lacks access_policy.approve)
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_cr_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.rbac_create_role_v1(jsonb_build_object(
       'organization_id', current_setting('test.w62_rbac_cr_org'),
       'key', 'w62_role_denied',
       'name', 'denied'
     )) $$,
  '42501',
  NULL,
  'sender_user denied rbac_create_role_v1'
);
RESET ROLE;

-- 3) RLS enabled on rbac_roles (foundation invariant)
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rbac_roles'::regclass),
  'rbac_roles has RLS enabled'
);

-- 4) Idempotence: repeat create returns idempotent_no_op=true (no duplicate row)
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_cr_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (public.rbac_create_role_v1(jsonb_build_object(
      'organization_id', current_setting('test.w62_rbac_cr_org'),
      'key', 'w62_role_alpha',
      'name', 'W62 Role Alpha (dup)'
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'rbac_create_role_v1 idempotent on (org, key)'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
