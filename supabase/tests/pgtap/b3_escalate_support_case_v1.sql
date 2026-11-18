-- pgTAP: escalate_support_case_v1 - capability, policy-driven priority, lineage, terminal guard
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_case UUID := gen_random_uuid();
  v_terminal_case UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'B3 Escalate Org', 'b3-esc-' || left(v_org::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops Escalator', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'cli-' || left(v_user_client::text, 8) || '@example.com', 'Client User', 'client_admin', 'tenant', NULL);

  INSERT INTO support_cases (id, organization_id, status, priority, subject, metadata)
  VALUES
    (v_case, v_org, 'open', 'medium', 'Escalate me', '{}'::jsonb),
    (v_terminal_case, v_org, 'resolved', 'medium', 'Do not escalate terminal', '{}'::jsonb);

  PERFORM set_config('test.b3_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.b3_user_client', v_user_client::text, true);
  PERFORM set_config('test.b3_case', v_case::text, true);
  PERFORM set_config('test.b3_terminal_case', v_terminal_case::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (public.escalate_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'reason', 'customer exception needs supervisor'
  ))->>'priority'),
  'urgent',
  'ops_admin can escalate_support_case_v1 to support_policy target priority'
);
RESET ROLE;

SELECT has_function(
  'api',
  'escalate_support_case_v1',
  ARRAY['jsonb'],
  'api.escalate_support_case_v1 exposes the Console V2 wrapper'
);

SELECT is(
  (
    SELECT priority
    FROM public.support_cases
    WHERE id = current_setting('test.b3_case')::uuid
  ),
  'urgent',
  'escalate_support_case_v1 persists escalated priority on support_cases'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.support_case_events
    WHERE support_case_id = current_setting('test.b3_case')::uuid
      AND event_type = 'escalated'
      AND payload->>'reason' = 'customer exception needs supervisor'
      AND payload->>'previous_priority' = 'medium'
      AND payload->>'priority' = 'urgent'
      AND settings_resolution_id IS NOT NULL
  ),
  'escalate_support_case_v1 appends policy-resolved support_case_events lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log
    WHERE resource_type = 'support_case'
      AND resource_id = current_setting('test.b3_case')::uuid
      AND decision_category = 'support_case.escalate'
      AND decision_point = 'escalate'
      AND decision_outcome = 'urgent'
  ),
  'escalate_support_case_v1 writes decision_log lineage'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_client'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_client'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.escalate_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'reason', 'denied')) $$,
  '42501',
  NULL,
  'client_admin denied for escalate_support_case_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.escalate_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_terminal_case')::uuid,
    'reason', 'terminal denied')) $$,
  '23514',
  NULL,
  'terminal support case cannot be escalated'
);

SELECT is(
  (public.escalate_support_case_v1(jsonb_build_object(
    'support_case_id', current_setting('test.b3_case')::uuid,
    'reason', 'customer exception needs supervisor'
  ))->>'already_processed')::boolean,
  TRUE,
  'escalate_support_case_v1 is idempotent for matching escalation state'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
