-- pgTAP: public.revoke_user_role_v1 contract (allowed/denied/RLS/idempotence)
-- Spec-Issue: Wave 8 W8-3 PLATFORM user-lifecycle RPC closure
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

DO $$
DECLARE
  v_org UUID := '00000083-0310-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000083-0310-0000-0000-000000000a01'::uuid;
  v_target UUID := '00000083-0310-0000-0000-000000000a02'::uuid;
  v_sender UUID := '00000083-0310-0000-0000-000000000a03'::uuid;
  v_role UUID := '00000083-0310-0000-0000-000000000b01'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W8-3 Revoke Org', 'w83-rur-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w83-rur-ops-' || left(v_ops::text, 8) || '@example.com',
     'W83 Ops', 'ops_admin', 'tenant', NULL),
    (v_target, v_org, 'w83-rur-target-' || left(v_target::text, 8) || '@example.com',
     'W83 Target', 'client_admin', 'tenant', NULL),
    (v_sender, v_org, 'w83-rur-sender-' || left(v_sender::text, 8) || '@example.com',
     'W83 Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (id, organization_id, key, name, is_active)
  VALUES (v_role, v_org, 'w83_revoke_role', 'W83 Revoke Role', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Pre-seed an active assignment we can revoke.
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
  VALUES (v_org, v_target, v_role)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('test.w83_rur_org', v_org::text, true);
  PERFORM set_config('test.w83_rur_ops', v_ops::text, true);
  PERFORM set_config('test.w83_rur_target', v_target::text, true);
  PERFORM set_config('test.w83_rur_sender', v_sender::text, true);
  PERFORM set_config('test.w83_rur_role_key', 'w83_revoke_role', true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed (service_role): revoke succeeds (active row → revoked)
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rur_ops'), true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.revoke_user_role_v1(jsonb_build_object(
       'target_user_id', current_setting('test.w83_rur_target'),
       'role_key', current_setting('test.w83_rur_role_key')
     )) $$,
  'ops_admin can revoke_user_role_v1 (role_key resolves)'
);
RESET ROLE;

-- 2) Canonical readback: no active assignment remains after revoke.
SET LOCAL ROLE postgres;
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments ura
      JOIN public.rbac_roles r ON r.id = ura.role_id
     WHERE ura.user_id = current_setting('test.w83_rur_target')::uuid
       AND r.key = current_setting('test.w83_rur_role_key')
       AND ura.revoked_at IS NULL
  ),
  'revoke_user_role_v1 removes the active role assignment from readback'
);
RESET ROLE;

-- 3) Security-action drawer readback includes revoked assignment decisions by target_user_id.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rur_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_user_security_actions_v1(current_setting('test.w83_rur_target')::uuid, 10)->'rows'
      ) AS row_data(row)
     WHERE row->>'decision_point' = 'revoke_user_role_v1'
       AND row->>'role_key' = current_setting('test.w83_rur_role_key')
       AND row->'decision_inputs'->>'target_user_id' = current_setting('test.w83_rur_target')
  ),
  'ui_list_user_security_actions_v1 returns revoke_user_role_v1 role evidence for the target user'
);
RESET ROLE;

-- 4) Hosted API schema wrapper exists and delegates the lifecycle RPC.
SELECT ok(
  has_function_privilege('authenticated', 'api.revoke_user_role_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.revoke_user_role_v1'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rur_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (api.revoke_user_role_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_rur_target'),
      'role_key', current_setting('test.w83_rur_role_key')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'api.revoke_user_role_v1 delegates to public revoke RPC and returns idempotent readback'
);
RESET ROLE;

-- 5) Denied (sender_user): blocked by users.manage capability gate
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rur_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.revoke_user_role_v1(jsonb_build_object(
       'target_user_id', current_setting('test.w83_rur_target'),
       'role_key', current_setting('test.w83_rur_role_key')
     )) $$,
  '42501',
  NULL,
  'sender_user denied revoke_user_role_v1 (users.manage capability gate)'
);
RESET ROLE;

-- 6) RLS enabled on rbac_user_role_assignments
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rur_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rbac_user_role_assignments'::regclass),
  'rbac_user_role_assignments has RLS enabled'
);

-- 8) Idempotence: re-revoke (no active row) returns idempotent_no_op=true
SELECT ok(
  COALESCE((
    SELECT (public.revoke_user_role_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_rur_target'),
      'role_key', current_setting('test.w83_rur_role_key')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'revoke_user_role_v1 idempotent on already-revoked / missing assignment'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
