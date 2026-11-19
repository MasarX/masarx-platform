-- Plan: frontend-design / Phase B / Subagent B3
-- pgTAP: assign_support_case_v1 — capability gate + assignee-org-match + idempotency
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_org_b UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_user_other_org UUID := gen_random_uuid();
  v_case UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES
    (v_org, 'B3 Assign Org', 'b3-asg-' || left(v_org::text, 8)),
    (v_org_b, 'B3 Assign Org B', 'b3-asg-b-' || left(v_org_b::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'cli-' || left(v_user_client::text, 8) || '@example.com', 'Cli', 'client_admin', 'tenant', NULL),
    (v_user_other_org, v_org_b, 'other-' || left(v_user_other_org::text, 8) || '@example.com', 'Other', 'ops_admin', 'tenant', NULL);

  INSERT INTO support_cases (id, organization_id, status, priority, subject)
  VALUES (v_case, v_org, 'open', 'medium', 'Assign test');

  PERFORM set_config('test.b3_org', v_org::text, true);
  PERFORM set_config('test.b3_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.b3_user_client', v_user_client::text, true);
  PERFORM set_config('test.b3_user_other', v_user_other_org::text, true);
  PERFORM set_config('test.b3_case', v_case::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- Test 1: ops_admin can assign to a same-org user
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((public.assign_support_case_v1(
    jsonb_build_object(
      'support_case_id', current_setting('test.b3_case')::uuid,
      'assigned_to', current_setting('test.b3_user_ops')::uuid
    )
  )->>'ok')::boolean, FALSE),
  'ops_admin can assign_support_case_v1 to same-org user'
);
RESET ROLE;

-- Test 2: client_admin (no support.write) is denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_client'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_client'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.assign_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'assigned_to', current_setting('test.b3_user_client')::uuid)) $$,
  '42501',
  NULL,
  'client_admin denied for assign_support_case_v1'
);
RESET ROLE;

-- Test 3: cross-org assignee blocked
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.assign_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'assigned_to', current_setting('test.b3_user_other')::uuid)) $$,
  '23514',
  NULL,
  'cross-org assignee blocked (organization mismatch)'
);
RESET ROLE;

-- Test 4: re-assign same target → already_processed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.assign_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'assigned_to', current_setting('test.b3_user_ops')::uuid
  ))->>'already_processed')::boolean,
  TRUE,
  'assign_support_case_v1 idempotent for same assignee'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
