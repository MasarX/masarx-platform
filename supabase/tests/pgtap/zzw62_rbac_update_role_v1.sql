-- pgTAP: public.rbac_update_role_v1 contract (allowed/denied/RLS/ladder)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

DO $$
DECLARE
  v_org UUID := '00000062-0100-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000062-0100-0000-0000-000000000a01'::uuid;
  v_sender UUID := '00000062-0100-0000-0000-000000000a02'::uuid;
  v_role UUID := '00000062-0100-0000-0000-000000000b01'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W6-2 RBAC Update Org', 'w62-rbac-up-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w62-rbac-up-ops-' || left(v_ops::text, 8) || '@example.com',
     'W62 Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'w62-rbac-up-sender-' || left(v_sender::text, 8) || '@example.com',
     'W62 Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (id, organization_id, key, name, description, is_active)
  VALUES (v_role, v_org, 'w62_target_role', 'W62 Target Role', 'pre-update', TRUE)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w62_rbac_up_org', v_org::text, true);
  PERFORM set_config('test.w62_rbac_up_ops', v_ops::text, true);
  PERFORM set_config('test.w62_rbac_up_sender', v_sender::text, true);
  PERFORM set_config('test.w62_rbac_up_role', v_role::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin updates name field.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_up_ops'), true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.rbac_update_role_v1(jsonb_build_object(
       'role_id', current_setting('test.w62_rbac_up_role'),
       'name', 'W62 Target Role (renamed)'
     )) $$,
  'ops_admin can rbac_update_role_v1 (rename path)'
);
RESET ROLE;

-- 2) Readback: row state reflects the requested mutation, not only RPC success.
SELECT is(
  (SELECT name FROM public.rbac_roles WHERE id = current_setting('test.w62_rbac_up_role')::uuid),
  'W62 Target Role (renamed)',
  'rbac_update_role_v1 persisted renamed role state'
);

-- 3) Denied (sender_user): blocked by capability gate
SELECT set_config('request.jwt.claim.sub', current_setting('test.w62_rbac_up_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.rbac_update_role_v1(jsonb_build_object(
       'role_id', current_setting('test.w62_rbac_up_role'),
       'name', 'denied'
     )) $$,
  '42501',
  NULL,
  'sender_user denied rbac_update_role_v1'
);
RESET ROLE;

-- 4) RLS still enabled on rbac_roles (foundation invariant)
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rbac_roles'::regclass),
  'rbac_roles has RLS enabled'
);

-- 5) Ladder/audit: decision_log row written for the update
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'access_policy.rbac_update_role'
       AND resource_id = current_setting('test.w62_rbac_up_role')::uuid
  ),
  'rbac_update_role_v1 wrote decision_log row'
);

SELECT * FROM finish();
ROLLBACK;
