-- pgTAP: public.reactivate_user_v1 contract (allowed/denied/RLS/idempotence)
-- Spec-Issue: Wave 8 W8-3 PLATFORM user-lifecycle RPC closure
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

DO $$
DECLARE
  v_org UUID := '00000083-0330-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000083-0330-0000-0000-000000000a01'::uuid;
  v_target UUID := '00000083-0330-0000-0000-000000000a02'::uuid;
  v_sender UUID := '00000083-0330-0000-0000-000000000a03'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W8-3 Reactivate Org', 'w83-rea-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES
    (v_ops, v_org, 'w83-rea-ops-' || left(v_ops::text, 8) || '@example.com',
     'W83 Ops', 'ops_admin', 'tenant', NULL, 'active'),
    (v_target, v_org, 'w83-rea-target-' || left(v_target::text, 8) || '@example.com',
     'W83 Target', 'client_admin', 'tenant', NULL, 'suspended'),
    (v_sender, v_org, 'w83-rea-sender-' || left(v_sender::text, 8) || '@example.com',
     'W83 Sender', 'sender_user', 'tenant', NULL, 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w83_rea_org', v_org::text, true);
  PERFORM set_config('test.w83_rea_ops', v_ops::text, true);
  PERFORM set_config('test.w83_rea_target', v_target::text, true);
  PERFORM set_config('test.w83_rea_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin reactivate writes status='active'.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rea_ops'), true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.reactivate_user_v1(jsonb_build_object(
       'target_user_id', current_setting('test.w83_rea_target'),
       'reason', 'pgtap-reactivate'
     )) $$,
  'ops_admin can reactivate_user_v1'
);
RESET ROLE;

-- 2) Security-action drawer readback includes reactivate reason evidence.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rea_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_user_security_actions_v1(current_setting('test.w83_rea_target')::uuid, 10)->'rows'
      ) AS row_data(row)
     WHERE row->>'decision_point' = 'reactivate_user_v1'
       AND row->>'action_reason' = 'pgtap-reactivate'
       AND row->>'resource_id' = current_setting('test.w83_rea_target')
  ),
  'ui_list_user_security_actions_v1 returns reactivate_user_v1 evidence and reason'
);
RESET ROLE;

-- 3) Hosted API schema wrapper exists and delegates the lifecycle RPC.
SELECT ok(
  has_function_privilege('authenticated', 'api.reactivate_user_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.reactivate_user_v1'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rea_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (api.reactivate_user_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_rea_target')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'api.reactivate_user_v1 delegates to public reactivate RPC and returns idempotent readback'
);
RESET ROLE;

-- 5) Denied (sender_user): blocked by users.manage capability gate
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rea_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.reactivate_user_v1(jsonb_build_object(
       'target_user_id', current_setting('test.w83_rea_target')
     )) $$,
  '42501',
  NULL,
  'sender_user denied reactivate_user_v1 (users.manage capability gate)'
);
RESET ROLE;

-- 6) RLS enabled on users
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.users'::regclass),
  'users has RLS enabled'
);

-- 7) Idempotence: re-reactivate already-active user returns idempotent_no_op=true
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_rea_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((
    SELECT (public.reactivate_user_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_rea_target')
    ))->>'idempotent_no_op')::boolean
  ), FALSE),
  'reactivate_user_v1 idempotent on already-active user'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
