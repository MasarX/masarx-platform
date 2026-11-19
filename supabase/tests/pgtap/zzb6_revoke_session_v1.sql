-- pgTAP: public.revoke_session_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b60c';
  v_ops UUID := '00000000-0000-0000-0000-00000000b6c1';
  v_sender UUID := '00000000-0000-0000-0000-00000000b6c2';
  v_target UUID := '00000000-0000-0000-0000-00000000b6c3';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Revoke Org', 'b6-rev-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-rev-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Rev Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-rev-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 Rev Sender', 'driver', 'tenant', NULL),
    (v_target, v_org, 'b6-rev-target-' || left(v_target::text, 8) || '@example.com',
     'B6 Rev Target', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_rev_org', v_org::text, true);
  PERFORM set_config('test.b6_rev_ops', v_ops::text, true);
  PERFORM set_config('test.b6_rev_sender', v_sender::text, true);
  PERFORM set_config('test.b6_rev_target', v_target::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_rev_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.revoke_session_v1(jsonb_build_object(
      'target_user_id', current_setting('test.b6_rev_target'),
      'session_id', 'ssn_pgtap_revoke',
      'reason', 'pgtap-revoke'
    ))->>'ok')::bool
  ),
  'ops_admin can revoke_session_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_rev_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.revoke_session_v1(jsonb_build_object(
       'target_user_id', current_setting('test.b6_rev_target')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied revoke_session_v1'
);
RESET ROLE;

-- 3) Missing reason denied for authorized operator
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_rev_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.revoke_session_v1(jsonb_build_object(
       'target_user_id', current_setting('test.b6_rev_target')
     )) $$,
  '23502',
  'revoke_session_v1 requires reason',
  'ops_admin cannot revoke_session_v1 without operator reason'
);
RESET ROLE;

-- 4) Ladder/audit: revocation_audit row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.revocation_audit
     WHERE target_user_id = current_setting('test.b6_rev_target')::uuid
       AND status = 'pending'
  ),
  'revoke_session_v1 wrote revocation_audit row (ladder/audit evidence)'
);

-- 5) User security evidence readback includes the revoke_session_v1 decision
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_rev_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.ui_list_user_security_actions_v1(current_setting('test.b6_rev_target')::uuid, 5)->'rows'
      ) AS row_data(row_value)
     WHERE row_value->>'decision_point' = 'revoke_session_v1'
       AND row_value->>'session_id' = 'ssn_pgtap_revoke'
       AND row_value->>'action_reason' = 'pgtap-revoke'
  ),
  'revoke_session_v1 decision is visible through ui_list_user_security_actions_v1'
);
RESET ROLE;

-- 6) RLS isolation: revocation_audit is service-only
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.revocation_audit', 'select'),
  'authenticated has no SELECT on revocation_audit (service-only)'
);

SELECT * FROM finish();
ROLLBACK;
