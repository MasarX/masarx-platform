-- pgTAP: public.create_alert_rule_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

-- Fixtures: two orgs to test cross-tenant isolation
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000b101';
  v_org2 UUID := '00000000-0000-0000-0000-00000000b102';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b111';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b112';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'B1 Alert Org A', 'b1-alert-org-a-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org2, 'B1 Alert Org B', 'b1-alert-org-b-' || left(v_org2::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'b1-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B1 Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'b1-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B1 Sender User', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b1_org1', v_org1::text, true);
  PERFORM set_config('test.b1_org2', v_org2::text, true);
  PERFORM set_config('test.b1_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.b1_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can create alert rule
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.create_alert_rule_v1(jsonb_build_object(
      'rule_name', 'b1-pgtap-rule-' || encode(gen_random_bytes(4), 'hex'),
      'trigger_source', 'decision_log',
      'trigger_conditions', jsonb_build_object('var', 'severity', 'op', '==', 'value', 'error'),
      'alert_channels', jsonb_build_array('email')
    ))->>'ok')::bool
  ),
  'ops_admin can create_alert_rule_v1'
);
RESET ROLE;

-- 2) Denied: sender_user lacks alerts.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.create_alert_rule_v1(jsonb_build_object(
       'rule_name', 'b1-pgtap-denied-' || encode(gen_random_bytes(4), 'hex'),
       'trigger_source', 'decision_log',
       'trigger_conditions', jsonb_build_object('var', 'a', 'op', '==', 'value', 1),
       'alert_channels', jsonb_build_array('email')
     )) $$,
  '42501',
  NULL,
  'non-ops user denied create_alert_rule_v1 (alerts.write missing)'
);
RESET ROLE;

-- 3) Ladder: capability resolves through global access_control_policy (ops_admin gets it)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings sv,
           jsonb_array_elements(sv.cached_value->'capabilities') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND cap->>'key' = 'alerts.write'
  ),
  'alerts.write capability resolves at global ladder scope'
);

-- 4) RLS isolation: alert_rules service-only (no anon/authenticated direct grants)
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.alert_rules', 'insert'),
  'authenticated has no direct INSERT on alert_rules (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
