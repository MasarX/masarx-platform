-- Plan: frontend-design / Phase B / Subagent B3
-- pgTAP: reopen_support_case_v1 — capability + status transition + idempotency
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_case_closed UUID := gen_random_uuid();
  v_case_open UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'B3 Reopen Org', 'b3-reo-' || left(v_org::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'cli-' || left(v_user_client::text, 8) || '@example.com', 'Cli', 'client_admin', 'tenant', NULL);

  INSERT INTO support_cases (id, organization_id, status, priority, subject, resolved_at, closed_at)
  VALUES
    (v_case_closed, v_org, 'closed', 'medium', 'Reopen me', now() - interval '1 hour', now() - interval '30 minutes'),
    (v_case_open, v_org, 'open', 'medium', 'Already open', NULL, NULL);

  PERFORM set_config('test.b3_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.b3_user_client', v_user_client::text, true);
  PERFORM set_config('test.b3_case_closed', v_case_closed::text, true);
  PERFORM set_config('test.b3_case_open', v_case_open::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- Test 1: ops_admin can reopen closed case → status='open'
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.reopen_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case_closed')::uuid,
    'reason', 'customer escalated'
  ))->>'status'),
  'open',
  'reopen_support_case_v1 sets status=open'
);
RESET ROLE;

-- Test 2: client_admin denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_client'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_client'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.reopen_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case_closed')::uuid)) $$,
  '42501',
  NULL,
  'client_admin denied for reopen_support_case_v1'
);
RESET ROLE;

-- Test 3: reopening already-open case → already_processed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.reopen_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case_open')::uuid
  ))->>'already_processed')::boolean,
  TRUE,
  'reopen_support_case_v1 idempotent for already-active status'
);
RESET ROLE;

-- Test 4: after reopen, resolved_at + closed_at are cleared
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT resolved_at IS NULL AND closed_at IS NULL
     FROM public.support_cases
    WHERE id = current_setting('test.b3_case_closed')::uuid),
  'reopen clears resolved_at + closed_at'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
