-- pgTAP: public.delete_alert_rule_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b501';
  v_ops UUID := '00000000-0000-0000-0000-00000000b511';
  v_sender UUID := '00000000-0000-0000-0000-00000000b512';
  v_rule UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Delete Org', 'b1-delete-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-del-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Del Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-del-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Del Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.alert_rules (
    id, organization_id, rule_name, enabled, priority, trigger_source,
    trigger_conditions, alert_channels, created_by
  ) VALUES (
    v_rule, v_org, 'b1-delete-target-' || left(v_rule::text, 8),
    TRUE, 0, 'decision_log',
    jsonb_build_object('var', 'a', 'op', '==', 'value', 1),
    jsonb_build_array('email'), v_ops
  );

  PERFORM set_config('test.b1_del_ops', v_ops::text, true);
  PERFORM set_config('test.b1_del_sender', v_sender::text, true);
  PERFORM set_config('test.b1_del_rule', v_rule::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_del_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.delete_alert_rule_v1(jsonb_build_object('alert_rule_id', current_setting('test.b1_del_rule')))->>'ok')::bool),
  'ops_admin can delete_alert_rule_v1 (soft-delete)'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_del_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.delete_alert_rule_v1(jsonb_build_object('alert_rule_id', current_setting('test.b1_del_rule'))) $$,
  '42501',
  NULL,
  'non-ops user denied delete_alert_rule_v1'
);
RESET ROLE;

-- 3) Soft-delete recorded (deleted_at is set)
SET LOCAL ROLE postgres;
SELECT ok(
  (SELECT deleted_at IS NOT NULL FROM public.alert_rules WHERE id = current_setting('test.b1_del_rule')::uuid),
  'delete_alert_rule_v1 sets deleted_at (soft-delete; row still exists)'
);
RESET ROLE;

-- 4) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.alert_rules', 'delete'),
  'authenticated has no direct DELETE on alert_rules'
);

SELECT * FROM finish();
ROLLBACK;
