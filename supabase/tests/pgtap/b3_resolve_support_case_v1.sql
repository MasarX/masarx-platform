-- Plan: frontend-design / Phase B / Subagent B3
-- pgTAP: resolve_support_case_v1 — capability + status transition + idempotency + close flag
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_case_open UUID := gen_random_uuid();
  v_case_open_close UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'B3 Resolve Org', 'b3-rsv-' || left(v_org::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'cli-' || left(v_user_client::text, 8) || '@example.com', 'Cli', 'client_admin', 'tenant', NULL);

  INSERT INTO support_cases (id, organization_id, status, priority, subject)
  VALUES
    (v_case_open, v_org, 'open', 'medium', 'Resolve me'),
    (v_case_open_close, v_org, 'open', 'medium', 'Close me');

  PERFORM set_config('test.b3_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.b3_user_client', v_user_client::text, true);
  PERFORM set_config('test.b3_case_open', v_case_open::text, true);
  PERFORM set_config('test.b3_case_open_close', v_case_open_close::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- Test 1: ops_admin can resolve to 'resolved'
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.resolve_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case_open')::uuid,
    'resolution', 'fixed by ops'
  ))->>'status'),
  'resolved',
  'resolve_support_case_v1 sets status to resolved'
);
RESET ROLE;

-- Test 2: client_admin denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_client'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_client'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.resolve_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case_open')::uuid,
    'resolution', 'denied attempt')) $$,
  '42501',
  NULL,
  'client_admin denied for resolve_support_case_v1'
);
RESET ROLE;

-- Test 3: re-resolving already-resolved case → already_processed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.resolve_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case_open')::uuid
  ))->>'already_processed')::boolean,
  TRUE,
  'resolve_support_case_v1 idempotent for terminal status'
);
RESET ROLE;

-- Test 4: close=true sets status to 'closed'
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.resolve_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case_open_close')::uuid,
    'close', TRUE
  ))->>'status'),
  'closed',
  'resolve_support_case_v1 with close=true sets status=closed'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
