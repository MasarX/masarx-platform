-- pgTAP: public.acknowledge_ops_alert_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b701';
  v_ops UUID := '00000000-0000-0000-0000-00000000b711';
  v_sender UUID := '00000000-0000-0000-0000-00000000b712';
  v_alert UUID := gen_random_uuid();
  v_now TIMESTAMPTZ := now();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Ack Org', 'b1-ack-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-ack-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Ack Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-ack-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Ack Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.ops_alerts (id, organization_id, alert_type, severity, message, created_at)
  VALUES (v_alert, v_org, 'b1-ack-test', 'error', 'pgtap acknowledge target', v_now);

  PERFORM set_config('test.b1_ack_org', v_org::text, true);
  PERFORM set_config('test.b1_ack_ops', v_ops::text, true);
  PERFORM set_config('test.b1_ack_sender', v_sender::text, true);
  PERFORM set_config('test.b1_ack_alert', v_alert::text, true);
  PERFORM set_config('test.b1_ack_now', v_now::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_ack_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b1_ack_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.acknowledge_ops_alert_v1(jsonb_build_object(
    'ops_alert_id', current_setting('test.b1_ack_alert'),
    'organization_id', current_setting('test.b1_ack_org'),
    'created_at', current_setting('test.b1_ack_now'),
    'notes', 'pgtap ack note'
  ))->>'ok')::bool),
  'ops_admin can acknowledge_ops_alert_v1'
);
RESET ROLE;

-- 2) Console readback exposes the persisted acknowledged state
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_ack_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b1_ack_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (api.ui_get_resource_v1('ops_alerts', current_setting('test.b1_ack_alert')::uuid)->>'acknowledged_at') IS NOT NULL,
  'api.ui_get_resource_v1 exposes acknowledged_at after acknowledge_ops_alert_v1'
);
SELECT is(
  api.ui_get_resource_v1('ops_alerts', current_setting('test.b1_ack_alert')::uuid)->>'acknowledged_by_user_id',
  current_setting('test.b1_ack_ops'),
  'api.ui_get_resource_v1 exposes acknowledged_by_user_id after acknowledge_ops_alert_v1'
);
RESET ROLE;

-- 4) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_ack_sender'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b1_ack_sender'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.acknowledge_ops_alert_v1(jsonb_build_object(
       'ops_alert_id', current_setting('test.b1_ack_alert')
     )) $$,
  '42501',
  NULL,
  'non-ops user denied acknowledge_ops_alert_v1'
);
RESET ROLE;

-- 5) Audit ledger appended (ops_alert_events)
SET LOCAL ROLE postgres;
SELECT ok(
  (SELECT COUNT(*) FROM public.ops_alert_events
    WHERE ops_alert_id = current_setting('test.b1_ack_alert')::uuid
      AND event_type = 'acknowledged') >= 1,
  'acknowledge_ops_alert_v1 appends ops_alert_events row (audit ledger)'
);
RESET ROLE;

-- 6) RLS isolation: ops_alert_events service-only
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.ops_alert_events', 'select'),
  'authenticated has no SELECT on ops_alert_events'
);

SELECT * FROM finish();
ROLLBACK;
