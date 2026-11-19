-- pgTAP: public.update_alert_rule_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b201';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b211';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b212';
  v_rule UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Update Alert Org', 'b1-update-alert-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org, 'b1-upd-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B1 Update Ops', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org, 'b1-upd-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B1 Update Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.alert_rules (
    id, organization_id, rule_name, enabled, priority, trigger_source,
    trigger_conditions, alert_channels, created_by
  ) VALUES (
    v_rule, v_org,
    'b1-update-target-' || left(v_rule::text, 8),
    TRUE, 0, 'decision_log',
    jsonb_build_object('var', 'severity', 'op', '==', 'value', 'error'),
    jsonb_build_array('email'),
    v_ops_admin
  );

  PERFORM set_config('test.b1_upd_org', v_org::text, true);
  PERFORM set_config('test.b1_upd_ops', v_ops_admin::text, true);
  PERFORM set_config('test.b1_upd_sender', v_sender_user::text, true);
  PERFORM set_config('test.b1_upd_rule', v_rule::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.update_alert_rule_v1(jsonb_build_object(
      'alert_rule_id', current_setting('test.b1_upd_rule'),
      'priority', 5
    ))->>'ok')::bool
  ),
  'ops_admin can update_alert_rule_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_upd_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.update_alert_rule_v1(jsonb_build_object(
       'alert_rule_id', current_setting('test.b1_upd_rule'),
       'priority', 9
     )) $$,
  '42501',
  NULL,
  'non-ops user denied update_alert_rule_v1'
);
RESET ROLE;

-- 3) Ladder: revision recorded with capability resolution evidence
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.alert_rule_revisions
     WHERE alert_rule_id = current_setting('test.b1_upd_rule')::uuid
       AND revision = 1
  ),
  'update_alert_rule_v1 appended revision row (ladder/audit evidence)'
);

-- 4) RLS isolation: revisions service-only
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.alert_rule_revisions', 'select'),
  'authenticated has no SELECT on alert_rule_revisions (service-only)'
);

SELECT * FROM finish();
ROLLBACK;
