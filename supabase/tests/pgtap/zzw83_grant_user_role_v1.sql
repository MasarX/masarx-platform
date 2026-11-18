-- pgTAP: public.grant_user_role_v1 contract (allowed/denied/RLS/idempotence)
-- Spec-Issue: Wave 8 W8-3 PLATFORM user-lifecycle RPC closure
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

DO $$
DECLARE
  v_org UUID := '00000083-0300-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000083-0300-0000-0000-000000000a01'::uuid;
  v_target UUID := '00000083-0300-0000-0000-000000000a02'::uuid;
  v_sender UUID := '00000083-0300-0000-0000-000000000a03'::uuid;
  v_role UUID := '00000083-0300-0000-0000-000000000b01'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W8-3 Grant Org', 'w83-gur-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w83-gur-ops-' || left(v_ops::text, 8) || '@example.com',
     'W83 Ops', 'ops_admin', 'tenant', NULL),
    (v_target, v_org, 'w83-gur-target-' || left(v_target::text, 8) || '@example.com',
     'W83 Target', 'client_admin', 'tenant', NULL),
    (v_sender, v_org, 'w83-gur-sender-' || left(v_sender::text, 8) || '@example.com',
     'W83 Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (id, organization_id, key, name, is_active)
  VALUES (v_role, v_org, 'w83_grant_role', 'W83 Grant Role', TRUE)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w83_gur_org', v_org::text, true);
  PERFORM set_config('test.w83_gur_ops', v_ops::text, true);
  PERFORM set_config('test.w83_gur_target', v_target::text, true);
  PERFORM set_config('test.w83_gur_sender', v_sender::text, true);
  PERFORM set_config('test.w83_gur_role_key', 'w83_grant_role', true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin grant succeeds via role_key resolution.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_gur_ops'), true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.grant_user_role_v1(jsonb_build_object(
       'target_user_id', current_setting('test.w83_gur_target'),
       'role_key', current_setting('test.w83_gur_role_key')
     )) $$,
  'ops_admin can grant_user_role_v1 (role_key resolves)'
);
RESET ROLE;

-- 2) Canonical readback: active assignment exists after grant.
SET LOCAL ROLE postgres;
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments ura
      JOIN public.rbac_roles r ON r.id = ura.role_id
     WHERE ura.user_id = current_setting('test.w83_gur_target')::uuid
       AND r.key = current_setting('test.w83_gur_role_key')
       AND ura.revoked_at IS NULL
  ),
  'grant_user_role_v1 creates an active role assignment readback row'
);
RESET ROLE;

-- 3) Security-action drawer readback includes role-assignment decisions by target_user_id.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_gur_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_user_security_actions_v1(current_setting('test.w83_gur_target')::uuid, 10)->'rows'
      ) AS row_data(row)
     WHERE row->>'decision_point' = 'grant_user_role_v1'
       AND row->>'role_key' = current_setting('test.w83_gur_role_key')
       AND row->'decision_inputs'->>'target_user_id' = current_setting('test.w83_gur_target')
  ),
  'ui_list_user_security_actions_v1 returns grant_user_role_v1 role evidence for the target user'
);
RESET ROLE;

-- 4) Hosted API schema wrapper exists and delegates the lifecycle RPC.
SELECT ok(
  has_function_privilege('authenticated', 'api.grant_user_role_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.grant_user_role_v1'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_gur_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (api.grant_user_role_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_gur_target'),
      'role_key', current_setting('test.w83_gur_role_key')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'api.grant_user_role_v1 delegates to public grant RPC and returns idempotent readback'
);
RESET ROLE;

-- 6) Denied (sender_user): blocked by users.manage capability gate
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_gur_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.grant_user_role_v1(jsonb_build_object(
       'target_user_id', current_setting('test.w83_gur_target'),
       'role_key', current_setting('test.w83_gur_role_key')
     )) $$,
  '42501',
  NULL,
  'sender_user denied grant_user_role_v1 (users.manage capability gate)'
);
RESET ROLE;

-- 7) RLS enabled on rbac_user_role_assignments
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rbac_user_role_assignments'::regclass),
  'rbac_user_role_assignments has RLS enabled'
);

-- 8) Idempotence: re-grant returns idempotent_no_op=true on active assignment
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_gur_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (public.grant_user_role_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_gur_target'),
      'role_key', current_setting('test.w83_gur_role_key')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'grant_user_role_v1 idempotent on existing active assignment'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
