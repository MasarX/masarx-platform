-- pgTAP: Phase B1 platform RPCs foundation - capabilities + ledger tables
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

-- 1) Soft-delete column added on alert_rules
SELECT has_column('public', 'alert_rules', 'deleted_at', 'alert_rules.deleted_at column exists');
SELECT has_column('public', 'alert_rules', 'deleted_by', 'alert_rules.deleted_by column exists');
SELECT has_column('public', 'alert_rules', 'updated_by', 'alert_rules.updated_by column exists');

-- 2) alert_rule_revisions: table + RLS + service-only grants
SELECT has_table('public', 'alert_rule_revisions', 'alert_rule_revisions table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='alert_rule_revisions'),
  'alert_rule_revisions has RLS enabled');
SELECT ok(NOT has_table_privilege('anon', 'public.alert_rule_revisions', 'select'),
  'anon has no SELECT on alert_rule_revisions');
SELECT ok(NOT has_table_privilege('authenticated', 'public.alert_rule_revisions', 'select'),
  'authenticated has no SELECT on alert_rule_revisions');

-- 3) ops_alert_events: table + RLS + service-only grants
SELECT has_table('public', 'ops_alert_events', 'ops_alert_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='ops_alert_events'),
  'ops_alert_events has RLS enabled');
SELECT ok(NOT has_table_privilege('anon', 'public.ops_alert_events', 'select'),
  'anon has no SELECT on ops_alert_events');
SELECT ok(NOT has_table_privilege('authenticated', 'public.ops_alert_events', 'select'),
  'authenticated has no SELECT on ops_alert_events');

-- 4) feature_flag_kill_events: table + RLS + service-only grants
SELECT has_table('public', 'feature_flag_kill_events', 'feature_flag_kill_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='feature_flag_kill_events'),
  'feature_flag_kill_events has RLS enabled');
SELECT ok(NOT has_table_privilege('anon', 'public.feature_flag_kill_events', 'select'),
  'anon has no SELECT on feature_flag_kill_events');

-- 5) capability_grant_requests: table + RLS + service-only grants
SELECT has_table('public', 'capability_grant_requests', 'capability_grant_requests table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='capability_grant_requests'),
  'capability_grant_requests has RLS enabled');
SELECT ok(NOT has_table_privilege('anon', 'public.capability_grant_requests', 'select'),
  'anon has no SELECT on capability_grant_requests');

-- 6) Capability registry registers B1 capability keys
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions sv,
           jsonb_array_elements(sv.value->'capabilities') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND cap->>'key' = 'alerts.write'
  ),
  'access_control_policy registers alerts.write capability'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions sv,
           jsonb_array_elements(sv.value->'capabilities') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND cap->>'key' = 'feature_flags.write'
  ),
  'access_control_policy registers feature_flags.write capability'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions sv,
           jsonb_array_elements(sv.value->'capabilities') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND cap->>'key' = 'warehouse.write'
  ),
  'access_control_policy registers warehouse.write capability'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions sv,
           jsonb_array_elements(sv.value->'roles') AS role,
           jsonb_array_elements_text(role->'capability_keys') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND role->>'key' = 'ops_admin'
       AND cap = 'alerts.write'
  ),
  'ops_admin role grants alerts.write'
);

SELECT * FROM finish();
ROLLBACK;
