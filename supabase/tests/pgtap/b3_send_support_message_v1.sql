-- Plan: frontend-design / Phase B / Subagent B3
-- pgTAP: send_support_message_v1 — capability + insert + canonical envelope + edge cases
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_case UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'B3 Msg Org', 'b3-msg-' || left(v_org::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'cli-' || left(v_user_client::text, 8) || '@example.com', 'Cli', 'client_admin', 'tenant', NULL);

  INSERT INTO support_cases (id, organization_id, status, priority, subject)
  VALUES (v_case, v_org, 'open', 'medium', 'Msg test');

  INSERT INTO support_case_events (
    support_case_id, organization_id, event_type, from_status, to_status,
    actor_system, payload, case_version
  )
  VALUES (
    v_case, v_org, 'support_case.created', NULL, 'open',
    'pgtap', jsonb_build_object('subject', 'Msg test'), 1
  );

  PERFORM set_config('test.b3_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.b3_user_client', v_user_client::text, true);
  PERFORM set_config('test.b3_case', v_case::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- Test 1: ops_admin can send a message (envelope.ok = true; support_message_id present)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE(
    (public.send_support_message_v1(jsonb_build_object(
      'support_case_id', current_setting('test.b3_case')::uuid,
      'direction', 'outbound',
      'channel', 'email',
      'body', 'Test message body'
    ))->>'support_message_id') IS NOT NULL,
    FALSE
  ),
  'ops_admin can send_support_message_v1 (envelope contains support_message_id)'
);
RESET ROLE;

-- Test 1b: message event advances past the existing create event version
SET LOCAL ROLE postgres;
SELECT is(
  (
    SELECT max(case_version)
    FROM public.support_case_events
    WHERE support_case_id = current_setting('test.b3_case')::uuid
  ),
  2,
  'send_support_message_v1 advances support_case_events.case_version past the create event'
);
RESET ROLE;

-- Test 2: client_admin denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_client'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_client'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.send_support_message_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'direction', 'outbound',
    'channel', 'in_app',
    'body', 'denied attempt')) $$,
  '42501',
  NULL,
  'client_admin denied for send_support_message_v1'
);
RESET ROLE;

-- Test 3: missing direction raises 23502
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.send_support_message_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'channel', 'email',
    'body', 'no direction')) $$,
  '23502',
  NULL,
  'send_support_message_v1 requires direction'
);
RESET ROLE;

-- Test 4: missing both body and artifact_id raises 23514
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.send_support_message_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'direction', 'outbound',
    'channel', 'email')) $$,
  '23514',
  NULL,
  'send_support_message_v1 requires body or artifact_id'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
