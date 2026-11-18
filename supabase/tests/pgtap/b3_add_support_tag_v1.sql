-- Plan: frontend-design / Phase B / Subagent B3
-- pgTAP: add_support_tag_v1 — capability + projection update + history + idempotency
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_case UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'B3 Tag Org', 'b3-tag-' || left(v_org::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'cli-' || left(v_user_client::text, 8) || '@example.com', 'Cli', 'client_admin', 'tenant', NULL);

  INSERT INTO support_cases (id, organization_id, status, priority, subject)
  VALUES (v_case, v_org, 'open', 'medium', 'Tag test');

  PERFORM set_config('test.b3_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.b3_user_client', v_user_client::text, true);
  PERFORM set_config('test.b3_case', v_case::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- Test 1: ops_admin can add a tag → tags[] contains 'urgent'
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((public.add_support_tag_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'tag', 'urgent'
  ))->>'ok')::boolean, FALSE),
  'add_support_tag_v1 add returns ok'
);
SELECT ok(
  COALESCE((
    SELECT 'urgent' = ANY(tags)
      FROM public.support_cases
     WHERE id = current_setting('test.b3_case')::uuid
  ), FALSE),
  'add_support_tag_v1 add projects tag onto support_cases.tags'
);
RESET ROLE;

-- Test 2: client_admin denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_client'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_client'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.add_support_tag_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'tag', 'denied')) $$,
  '42501',
  NULL,
  'client_admin denied for add_support_tag_v1'
);
RESET ROLE;

-- Test 3: re-adding same tag → already_processed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.add_support_tag_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'tag', 'urgent'
  ))->>'already_processed')::boolean,
  TRUE,
  'add_support_tag_v1 idempotent for already-attached tag'
);
RESET ROLE;

-- Test 4: remove action drops tag from projection
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE((public.add_support_tag_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'tag', 'urgent',
    'action', 'remove'
  ))->>'ok')::boolean, FALSE),
  'add_support_tag_v1 remove returns ok'
);
SELECT ok(
  COALESCE((
    SELECT NOT ('urgent' = ANY(COALESCE(tags, ARRAY[]::TEXT[])))
      FROM public.support_cases
     WHERE id = current_setting('test.b3_case')::uuid
  ), FALSE),
  'add_support_tag_v1 remove drops tag from support_cases.tags'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
