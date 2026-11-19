-- pgTAP: public.v_alert_rule_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W28 (paired projection views - PLATFORM)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_alert_rule_directory',
  'public.v_alert_rule_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_alert_rule_directory',
  ARRAY[
    'id', 'organization_id', 'rule_name', 'enabled', 'priority',
    'trigger_source', 'trigger_conditions',
    'throttle_window_minutes', 'throttle_key_fields',
    'alert_severity_lookup_id', 'alert_channels',
    'message_template_id', 'message_variables',
    'created_by', 'created_at', 'updated_at',
    'severity_label',
    'created_by_label', 'created_by_email',
    'condition_summary', 'alert_channels_count',
    'last_triggered_at', 'trigger_count_24h',
    'ack_count_24h', 'resolved_count_24h',
    'is_throttled', 'is_paused'
  ],
  'v_alert_rule_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_alert_rule_directory', 'SELECT'),
  'service_role has SELECT on v_alert_rule_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_alert_rule_directory', 'SELECT'),
  'anon has no SELECT on v_alert_rule_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_alert_rule_directory', 'SELECT'),
  'authenticated has SELECT on v_alert_rule_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'alert_rules'
       AND c.relkind = 'r'
  ),
  'public.alert_rules remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a rule + 2 triggers.
DO $$
DECLARE
  v_org       UUID := '00000000-0000-0000-0000-00000028a001';
  v_user      UUID := '00000000-0000-0000-0000-00000028a002';
  v_rule      UUID := '00000000-0000-0000-0000-00000028a003';
  v_trig_a    UUID := '00000000-0000-0000-0000-00000028a005';
  v_trig_b    UUID := '00000000-0000-0000-0000-00000028a006';
  v_lookup_definition UUID;
  v_lookup    UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W28 Alert Org', 'w28-ar-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org, 'w28-ar-u-main@example.com',
    'W28 Alert Owner', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
  VALUES ('alert_severity', 'Alert Severity', 'operations', 'tier_1', TRUE)
  ON CONFLICT (category) DO NOTHING;

  SELECT id
    INTO v_lookup_definition
    FROM public.lookup_definitions
   WHERE category = 'alert_severity';

  INSERT INTO public.lookup_values (
    lookup_definition_id, value, label, sort_order, is_default, metadata
  )
  VALUES (
    v_lookup_definition, 'critical', 'Critical', 10, FALSE, '{}'::jsonb
  )
  ON CONFLICT (lookup_definition_id, value) DO NOTHING;

  SELECT id
    INTO v_lookup
    FROM public.lookup_values
   WHERE lookup_definition_id = v_lookup_definition
     AND value = 'critical';

  INSERT INTO public.alert_rules (
    id, organization_id, rule_name, enabled, priority,
    trigger_source, trigger_conditions,
    throttle_window_minutes,
    alert_severity_lookup_id, alert_channels,
    created_by, created_at
  )
  VALUES (
    v_rule, v_org,
    'w28-rule-main',
    TRUE, 10,
    'decision_log',
    jsonb_build_object('error_rate', 0.087),
    15,
    v_lookup,
    jsonb_build_array('slack', 'email'),
    v_user,
    now() - INTERVAL '7 days'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.alert_triggers (
    id, alert_rule_id, organization_id,
    resource_type, resource_id,
    severity, message, context,
    timestamp, acknowledged_at, acknowledged_by
  )
  VALUES (
    v_trig_a, v_rule, v_org,
    'shipment', '00000000-0000-0000-0000-00000000abcd',
    'critical', 'rate exceeded',
    jsonb_build_object('error_rate', 0.092),
    now() - INTERVAL '30 minutes',
    now() - INTERVAL '20 minutes',
    v_user
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.alert_triggers (
    id, alert_rule_id, organization_id,
    resource_type, resource_id,
    severity, message, context,
    timestamp
  )
  VALUES (
    v_trig_b, v_rule, v_org,
    'shipment', '00000000-0000-0000-0000-00000000abce',
    'critical', 'rate still exceeded',
    jsonb_build_object('error_rate', 0.099),
    now() - INTERVAL '5 minutes'
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_alert_rule_directory
    WHERE id = '00000000-0000-0000-0000-00000028a003'::UUID
      AND severity_label = 'critical'
      AND created_by_label = 'W28 Alert Owner'
      AND condition_summary = 'error_rate = 0.087'
      AND alert_channels_count = 2
      AND last_triggered_at IS NOT NULL
      AND last_triggered_at > now() - INTERVAL '1 hour'
      AND trigger_count_24h = 2
      AND ack_count_24h = 1
      AND resolved_count_24h = 0
      AND is_throttled = TRUE
      AND is_paused = FALSE
  ),
  'v_alert_rule_directory derives severity_label + created_by_label + condition_summary + alert_channels_count + last_triggered_at + trigger_count_24h + ack_count_24h + resolved_count_24h + is_throttled + is_paused'
);

-- 8) Edge case: paused rule with no triggers.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000028a001';
  v_user2  UUID := '00000000-0000-0000-0000-00000028a012';
  v_rule2  UUID := '00000000-0000-0000-0000-00000028a013';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user2, v_org, 'w28-ar-u2-main@example.com',
    'W28 Alert Owner 2', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.alert_rules (
    id, organization_id, rule_name, enabled, priority,
    trigger_source, trigger_conditions,
    throttle_window_minutes,
    alert_channels, created_by, created_at
  )
  VALUES (
    v_rule2, v_org,
    'w28-rule-paused-main',
    FALSE, 5,
    'decision_log',
    '{}'::jsonb,
    15,
    jsonb_build_array('slack'),
    v_user2,
    now() - INTERVAL '2 days'
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_alert_rule_directory
    WHERE id = '00000000-0000-0000-0000-00000028a013'::UUID
      AND is_throttled = FALSE
      AND is_paused = TRUE
      AND last_triggered_at IS NULL
      AND trigger_count_24h = 0
      AND condition_summary IS NOT NULL
  ),
  'v_alert_rule_directory: paused rule with empty condition + no triggers resolves is_throttled=FALSE + is_paused=TRUE + last_triggered_at=NULL + trigger_count_24h=0 + condition_summary populated'
);

SELECT * FROM finish();
ROLLBACK;
