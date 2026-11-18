-- pgTAP: public.pause_alert_rule_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b301';
  v_ops UUID := '00000000-0000-0000-0000-00000000b311';
  v_sender UUID := '00000000-0000-0000-0000-00000000b312';
  v_rule UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Pause Org', 'b1-pause-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-pause-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Pause Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-pause-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Pause Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.alert_rules (
    id, organization_id, rule_name, enabled, priority, trigger_source,
    trigger_conditions, alert_channels, created_by
  ) VALUES (
    v_rule, v_org, 'b1-pause-target-' || left(v_rule::text, 8),
    TRUE, 0, 'decision_log',
    jsonb_build_object('var', 'a', 'op', '==', 'value', 1),
    jsonb_build_array('email'), v_ops
  );

  PERFORM set_config('test.b1_pause_org', v_org::text, true);
  PERFORM set_config('test.b1_pause_ops', v_ops::text, true);
  PERFORM set_config('test.b1_pause_sender', v_sender::text, true);
  PERFORM set_config('test.b1_pause_rule', v_rule::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_pause_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.pause_alert_rule_v1(jsonb_build_object('alert_rule_id', current_setting('test.b1_pause_rule')))->>'ok')::bool),
  'ops_admin can pause_alert_rule_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_pause_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.pause_alert_rule_v1(jsonb_build_object('alert_rule_id', current_setting('test.b1_pause_rule'))) $$,
  '42501',
  NULL,
  'non-ops user denied pause_alert_rule_v1'
);
RESET ROLE;

-- 3) Ladder/idempotency: second call returns idempotent=true
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_pause_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.pause_alert_rule_v1(jsonb_build_object('alert_rule_id', current_setting('test.b1_pause_rule')))->>'idempotent')::bool),
  'pause_alert_rule_v1 second call is idempotent'
);
RESET ROLE;

-- 4) RLS isolation: alert_rules service-only writes
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.alert_rules', 'update'),
  'authenticated has no direct UPDATE on alert_rules'
);

SELECT * FROM finish();
ROLLBACK;
