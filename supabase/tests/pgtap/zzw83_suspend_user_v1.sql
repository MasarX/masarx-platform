-- pgTAP: public.suspend_user_v1 contract (allowed/denied/RLS/idempotence)
-- Spec-Issue: Wave 8 W8-3 PLATFORM user-lifecycle RPC closure
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

DO $$
DECLARE
  v_org UUID := '00000083-0320-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000083-0320-0000-0000-000000000a01'::uuid;
  v_target UUID := '00000083-0320-0000-0000-000000000a02'::uuid;
  v_sender UUID := '00000083-0320-0000-0000-000000000a03'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W8-3 Suspend Org', 'w83-su-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES
    (v_ops, v_org, 'w83-su-ops-' || left(v_ops::text, 8) || '@example.com',
     'W83 Ops', 'ops_admin', 'tenant', NULL, 'active'),
    (v_target, v_org, 'w83-su-target-' || left(v_target::text, 8) || '@example.com',
     'W83 Target', 'client_admin', 'tenant', NULL, 'active'),
    (v_sender, v_org, 'w83-su-sender-' || left(v_sender::text, 8) || '@example.com',
     'W83 Sender', 'sender_user', 'tenant', NULL, 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w83_su_org', v_org::text, true);
  PERFORM set_config('test.w83_su_ops', v_ops::text, true);
  PERFORM set_config('test.w83_su_target', v_target::text, true);
  PERFORM set_config('test.w83_su_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin suspend writes status='suspended'.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_su_ops'), true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.suspend_user_v1(jsonb_build_object(
       'target_user_id', current_setting('test.w83_su_target'),
       'reason', 'pgtap-suspend'
     )) $$,
  'ops_admin can suspend_user_v1'
);
RESET ROLE;

-- 2) Security-action drawer readback includes suspend reason evidence.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_su_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_user_security_actions_v1(current_setting('test.w83_su_target')::uuid, 10)->'rows'
      ) AS row_data(row)
     WHERE row->>'decision_point' = 'suspend_user_v1'
       AND row->>'action_reason' = 'pgtap-suspend'
       AND row->>'resource_id' = current_setting('test.w83_su_target')
  ),
  'ui_list_user_security_actions_v1 returns suspend_user_v1 evidence and reason'
);
RESET ROLE;

-- 3) Hosted API schema wrapper exists and delegates the lifecycle RPC.
SELECT ok(
  has_function_privilege('authenticated', 'api.suspend_user_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.suspend_user_v1'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_su_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (api.suspend_user_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_su_target')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'api.suspend_user_v1 delegates to public suspend RPC and returns idempotent readback'
);
RESET ROLE;

-- 5) Denied (sender_user): blocked by users.manage capability gate
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_su_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.suspend_user_v1(jsonb_build_object(
       'target_user_id', current_setting('test.w83_su_target')
     )) $$,
  '42501',
  NULL,
  'sender_user denied suspend_user_v1 (users.manage capability gate)'
);
RESET ROLE;

-- 6) RLS enabled on users
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.users'::regclass),
  'users has RLS enabled'
);

-- 7) Idempotence: re-suspend already-suspended user returns idempotent_no_op=true
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_su_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (public.suspend_user_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_su_target')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'suspend_user_v1 idempotent on already-suspended user'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
