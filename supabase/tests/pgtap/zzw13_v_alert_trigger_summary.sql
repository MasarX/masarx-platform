-- pgTAP: public.v_alert_trigger_summary projection contract — W13-5
-- Closes PLATFORM alert_triggers FE-shape gap (W7 audit + W10-5 deferred).
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_alert_trigger_summary',
  'public.v_alert_trigger_summary view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_alert_trigger_summary',
  ARRAY[
    'id', 'rule_id', 'organization_id', 'fired_at', 'payload',
    'resource_type', 'resource_id', 'severity', 'message',
    'status', 'acknowledged_at', 'acknowledged_by', 'notified_at',
    'occurred_at'
  ],
  'v_alert_trigger_summary exposes FE-projection columns'
);

-- 3) Underlying base table remains SSOT (regular table, not view)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'alert_triggers'
       AND c.relkind = 'r'
  ),
  'public.alert_triggers remains a base table (SSOT preserved)'
);

-- 4) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_alert_trigger_summary', 'SELECT'),
  'service_role has SELECT on v_alert_trigger_summary'
);

-- 5) anon has NO SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_alert_trigger_summary', 'SELECT'),
  'anon has NO SELECT on v_alert_trigger_summary'
);

-- 6) authenticated has NO SELECT (canonical alert_triggers is service-role only;
--    the FE consumes via the registry seam under service-role impersonation)
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.v_alert_trigger_summary', 'SELECT'),
  'authenticated has NO SELECT on v_alert_trigger_summary (service-role gated)'
);

-- 7) Status projection: insert a fresh trigger with no ack/resolution; expect 'fired'
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000013a701';
  v_rule     UUID := '00000000-0000-0000-0000-00000013a702';
  v_trig     UUID := '00000000-0000-0000-0000-00000013a703';
  v_resource UUID := '00000000-0000-0000-0000-00000013a704';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W13-5 Alert View Org', 'w13-av-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.alert_rules (
    id, organization_id, rule_name, trigger_source, trigger_conditions,
    alert_channels, enabled, created_at
  )
  VALUES (
    v_rule, v_org,
    'W13-5 Test Rule',
    'shipments',
    '{}'::jsonb,
    '["slack"]'::jsonb,
    TRUE,
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.alert_triggers (
    id, alert_rule_id, organization_id, resource_type, resource_id,
    severity, message, context, timestamp
  )
  VALUES (
    v_trig, v_rule, v_org, 'shipment', v_resource,
    'warn', 'W13-5 fired sample',
    jsonb_build_object('error_rate', 0.087),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w13_alert_trig', v_trig::text, true);
  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (SELECT status FROM public.v_alert_trigger_summary
    WHERE id = current_setting('test.w13_alert_trig')::uuid),
  'fired',
  'v_alert_trigger_summary derives status=fired when no ack/resolution flags set'
);

-- 8) Status projection: payload field round-trips from context jsonb
SELECT is(
  (SELECT (payload->>'error_rate')::TEXT FROM public.v_alert_trigger_summary
    WHERE id = current_setting('test.w13_alert_trig')::uuid),
  '0.087',
  'v_alert_trigger_summary projects payload from canonical context jsonb'
);

SELECT * FROM finish();
ROLLBACK;
