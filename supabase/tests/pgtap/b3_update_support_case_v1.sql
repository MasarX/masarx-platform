-- Plan: frontend-design / Phase B / Subagent B3
-- pgTAP: update_support_case_v1 — capability gate + RLS + version bump + envelope
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_case UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'B3 Update Org', 'b3-upd-' || left(v_org::text, 8));

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B3 Update Client', 'b3-upd-cli-' || left(v_client::text, 8), 'active');

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'cli-' || left(v_user_client::text, 8) || '@example.com', 'Cli', 'client_admin', 'client', v_client);

  INSERT INTO support_cases (id, organization_id, client_id, status, priority, subject)
  VALUES (v_case, v_org, v_client, 'open', 'medium', 'Initial subject');

  PERFORM set_config('test.b3_org', v_org::text, true);
  PERFORM set_config('test.b3_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.b3_user_client', v_user_client::text, true);
  PERFORM set_config('test.b3_case', v_case::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- Test 1: ops_admin can update
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((public.update_support_case_v1(
    jsonb_build_object(
      'support_case_id', current_setting('test.b3_case')::uuid,
      'subject', 'Updated subject',
      'priority', 'high'
    )
  )->>'ok')::boolean, FALSE),
  'ops_admin can update_support_case_v1'
);
RESET ROLE;

-- Test 2: client_admin denied (no support.write)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_client'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_client'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.update_support_case_v1(jsonb_build_object(
       'support_case_id', current_setting('test.b3_case')::uuid,
       'subject', 'denied' )) $$,
  '42501',
  NULL,
  'client_admin denied for update_support_case_v1'
);
RESET ROLE;

-- Test 3: version was bumped past initial 1
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT version FROM public.support_cases WHERE id = current_setting('test.b3_case')::uuid) >= 2,
  'support_cases.version monotonically increased after update'
);
RESET ROLE;

-- Test 4: missing support_case_id raises 23502 (NOT NULL violation semantics)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.update_support_case_v1(jsonb_build_object('subject', 'no id')) $$,
  '23502',
  NULL,
  'update_support_case_v1 requires support_case_id'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
