-- Plan: frontend-design / Phase B / Subagent B3
-- pgTAP: bulk_resolve_support_cases_v1 — capability + per-case envelope
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_case_a UUID := gen_random_uuid();
  v_case_b UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'B3 Bulk Resolve Org', 'b3-bulk-rsv-' || left(v_org::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'cli-' || left(v_user_client::text, 8) || '@example.com', 'Cli', 'client_admin', 'tenant', NULL);

  INSERT INTO support_cases (id, organization_id, status, priority, subject)
  VALUES
    (v_case_a, v_org, 'open', 'medium', 'Bulk-Rsv A'),
    (v_case_b, v_org, 'open', 'medium', 'Bulk-Rsv B');

  PERFORM set_config('test.b3_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.b3_user_client', v_user_client::text, true);
  PERFORM set_config('test.b3_case_a', v_case_a::text, true);
  PERFORM set_config('test.b3_case_b', v_case_b::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- Test 1: ops_admin bulk-resolves 2 cases
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.bulk_resolve_support_cases_v1(jsonb_build_object(
    'support_case_ids', jsonb_build_array(
      current_setting('test.b3_case_a')::uuid,
      current_setting('test.b3_case_b')::uuid
    ),
    'resolution', 'bulk fix'
  ))->>'success_count')::int,
  2,
  'bulk_resolve_support_cases_v1 success_count=2'
);
RESET ROLE;

-- Test 2: client_admin denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_client'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_client'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.bulk_resolve_support_cases_v1(jsonb_build_object(
    'support_case_ids', jsonb_build_array(current_setting('test.b3_case_a')::uuid))) $$,
  '42501',
  NULL,
  'client_admin denied for bulk_resolve_support_cases_v1'
);
RESET ROLE;

-- Test 3: empty array raises 23514
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.bulk_resolve_support_cases_v1(jsonb_build_object('support_case_ids', '[]'::jsonb)) $$,
  '23514',
  NULL,
  'bulk_resolve_support_cases_v1 rejects empty support_case_ids'
);
RESET ROLE;

-- Test 4: re-bulk-resolve already-resolved cases → already_processed_count=2
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.bulk_resolve_support_cases_v1(jsonb_build_object(
    'support_case_ids', jsonb_build_array(
      current_setting('test.b3_case_a')::uuid,
      current_setting('test.b3_case_b')::uuid
    )
  ))->>'already_processed_count')::int,
  2,
  'bulk_resolve_support_cases_v1 idempotent for already-resolved cohort'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
