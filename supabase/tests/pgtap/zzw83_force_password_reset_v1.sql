-- pgTAP: public.force_password_reset_v1 contract (allowed/denied/RLS/idempotence)
-- Spec-Issue: Wave 8 W8-3 PLATFORM user-lifecycle RPC closure
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

DO $$
DECLARE
  v_org UUID := '00000083-0340-0000-0000-000000000001'::uuid;
  v_ops UUID := '00000083-0340-0000-0000-000000000a01'::uuid;
  v_target UUID := '00000083-0340-0000-0000-000000000a02'::uuid;
  v_sender UUID := '00000083-0340-0000-0000-000000000a03'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W8-3 Pwd Reset Org', 'w83-pwr-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w83-pwr-ops-' || left(v_ops::text, 8) || '@example.com',
     'W83 Ops', 'ops_admin', 'tenant', NULL),
    (v_target, v_org, 'w83-pwr-target-' || left(v_target::text, 8) || '@example.com',
     'W83 Target', 'client_admin', 'tenant', NULL),
    (v_sender, v_org, 'w83-pwr-sender-' || left(v_sender::text, 8) || '@example.com',
     'W83 Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w83_pwr_org', v_org::text, true);
  PERFORM set_config('test.w83_pwr_ops', v_ops::text, true);
  PERFORM set_config('test.w83_pwr_target', v_target::text, true);
  PERFORM set_config('test.w83_pwr_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin writes a pending intent row.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_pwr_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.force_password_reset_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_pwr_target'),
      'reason', 'pgtap-force-reset'
    ))->>'ok')::bool
  ),
  'ops_admin can force_password_reset_v1 (writes pending intent)'
);
RESET ROLE;

-- 2) Denied (sender_user): blocked by users.manage capability gate
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_pwr_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.force_password_reset_v1(jsonb_build_object(
       'target_user_id', current_setting('test.w83_pwr_target')
     )) $$,
  '42501',
  NULL,
  'sender_user denied force_password_reset_v1 (users.manage capability gate)'
);
RESET ROLE;

-- 3) Ledger/audit: password_reset_intents row written + service-only RLS
SET LOCAL ROLE postgres;
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.password_reset_intents
     WHERE target_user_id = current_setting('test.w83_pwr_target')::uuid
       AND status = 'pending'
  )
  AND NOT has_table_privilege('authenticated', 'public.password_reset_intents', 'select'),
  'force_password_reset_v1 wrote pending intent + table is service-only (RLS hardening)'
);
RESET ROLE;

-- 4) Idempotence (intent-ledger): every call appends a fresh INTENT row
--    (out-of-band edge worker dedupes by latest pending).
SELECT set_config('request.jwt.claim.sub', current_setting('test.w83_pwr_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.force_password_reset_v1(jsonb_build_object(
      'target_user_id', current_setting('test.w83_pwr_target')
    ))->>'ok')::bool
  ),
  'force_password_reset_v1 second intent call succeeds'
);
RESET ROLE;

SET LOCAL ROLE postgres;
SELECT ok(
  (
    SELECT count(*) FROM public.password_reset_intents
     WHERE target_user_id = current_setting('test.w83_pwr_target')::uuid
  ) >= 2,
  'force_password_reset_v1 appends fresh intent rows; worker dedupes latest pending'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
