-- pgTAP: public.rbac_delete_role_v1 contract (allowed/denied/RLS/idempotence)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

DO $$
DECLARE
  v_org UUID := '00000062-0200-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000062-0200-0000-0000-000000000a01'::uuid;
  v_sender UUID := '00000062-0200-0000-0000-000000000a02'::uuid;
  v_role UUID := '00000062-0200-0000-0000-000000000b01'::uuid;
  v_role2 UUID := '00000062-0200-0000-0000-000000000b02'::uuid;
  v_assignment UUID := '00000062-0200-0000-0000-000000000c01'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W6-2 RBAC Delete Org', 'w62-rbac-del-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w62-rbac-del-ops-' || left(v_ops::text, 8) || '@example.com',
     'W62 Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'w62-rbac-del-sender-' || left(v_sender::text, 8) || '@example.com',
     'W62 Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (id, organization_id, key, name, is_active)
  VALUES
    (v_role, v_org, 'w62_to_delete', 'W62 To Delete', TRUE),
    (v_role2, v_org, 'w62_already_inactive', 'W62 Already Inactive', FALSE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (id, organization_id, user_id, role_id)
  VALUES (v_assignment, v_org, v_sender, v_role)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('test.w62_rbac_del_org', v_org::text, true);
  PERFORM set_config('test.w62_rbac_del_ops', v_ops::text, true);
  PERFORM set_config('test.w62_rbac_del_sender', v_sender::text, true);
  PERFORM set_config('test.w62_rbac_del_role', v_role::text, true);
  PERFORM set_config('test.w62_rbac_del_role2', v_role2::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin soft-delete sets is_active=FALSE.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_del_ops'), true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.rbac_delete_role_v1(jsonb_build_object(
       'role_id', current_setting('test.w62_rbac_del_role')
     )) $$,
  'ops_admin can rbac_delete_role_v1 (soft-delete path)'
);
RESET ROLE;

-- 2) Readback: soft-delete made the role inactive.
SELECT is(
  (SELECT is_active FROM public.rbac_roles WHERE id = current_setting('test.w62_rbac_del_role')::uuid),
  FALSE,
  'rbac_delete_role_v1 persisted inactive role state'
);

-- 3) Readback: soft-delete revoked active assignments for the role.
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments
     WHERE role_id = current_setting('test.w62_rbac_del_role')::uuid
       AND revoked_at IS NULL
  ),
  'rbac_delete_role_v1 revoked active assignments for deleted role'
);

-- 4) Denied (sender_user): blocked by capability gate
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_del_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.rbac_delete_role_v1(jsonb_build_object(
       'role_id', current_setting('test.w62_rbac_del_role')
     )) $$,
  '42501',
  NULL,
  'sender_user denied rbac_delete_role_v1'
);
RESET ROLE;

-- 5) RLS still enabled on rbac_roles
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rbac_roles'::regclass),
  'rbac_roles has RLS enabled'
);

-- 6) Idempotence: deleting already-inactive role returns idempotent_no_op=true
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_del_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (public.rbac_delete_role_v1(jsonb_build_object(
      'role_id', current_setting('test.w62_rbac_del_role2')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'rbac_delete_role_v1 idempotent on already-inactive role'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
