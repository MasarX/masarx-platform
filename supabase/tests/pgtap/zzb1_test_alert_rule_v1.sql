-- pgTAP: public.test_alert_rule_v1 contract (read-only eval)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b601';
  v_ops UUID := '00000000-0000-0000-0000-00000000b611';
  v_sender UUID := '00000000-0000-0000-0000-00000000b612';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Test Org', 'b1-test-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-test-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Test Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-test-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Test Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b1_test_ops', v_ops::text, true);
  PERFORM set_config('test.b1_test_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can evaluate trigger_conditions
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_test_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.test_alert_rule_v1(jsonb_build_object(
    'trigger_conditions', jsonb_build_object('var', 'severity', 'op', '==', 'value', 'error'),
    'sample_payload', jsonb_build_object('severity', 'error')
  ))->>'pass')::boolean),
  'ops_admin test_alert_rule_v1 returns pass=true on matching payload'
);
RESET ROLE;

-- 2) Denied: sender_user lacks alerts.read (sender_user role does not include alerts.read)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_test_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.test_alert_rule_v1(jsonb_build_object(
       'trigger_conditions', jsonb_build_object('var', 'a', 'op', '==', 'value', 1),
       'sample_payload', jsonb_build_object('a', 1)
     )) $$,
  '42501',
  NULL,
  'non-ops user denied test_alert_rule_v1'
);
RESET ROLE;

-- 3) Ladder/eval: compound any matches when sub-rule matches
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_test_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.test_alert_rule_v1(jsonb_build_object(
    'trigger_conditions', jsonb_build_object(
      'any', jsonb_build_array(
        jsonb_build_object('var', 'a', 'op', '==', 'value', 99),
        jsonb_build_object('var', 'b', 'op', '==', 'value', 2)
      )
    ),
    'sample_payload', jsonb_build_object('a', 1, 'b', 2)
  ))->>'pass')::boolean),
  'compound any matches when at least one sub-rule passes'
);
RESET ROLE;

-- 4) RLS isolation: read-only function does not mutate alert_rules (no DELETE/UPDATE)
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.alert_rules', 'update'),
  'authenticated cannot mutate alert_rules even when calling read-only test RPC'
);

SELECT * FROM finish();
ROLLBACK;
