-- pgTAP: remaining Console V2 live route resources are registry-backed and browser-readable.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'c3ab81b3-cc2e-44cc-9c01-01f77bfde740'::uuid,
  'Console V2 Live Route Registry Org',
  'console-v2-live-route-registry'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  '6c9ef9fe-5d1d-4f6e-9d75-d588f1cf61c9'::uuid,
  'c3ab81b3-cc2e-44cc-9c01-01f77bfde740'::uuid,
  'console-v2-live-route-registry@example.test',
  'Console V2 Live Route Registry Super Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'workflow_bindings_console_v1',
      'workflow_binding_dispatches_console_v1',
      'recent_workflow_events_console_v1',
      'kpi_rollup_directory_console_v1',
      'alert_rules_console_v1',
      'ops_alerts_console_v1'
    ]) AS required(view_name)
    WHERE to_regclass('public.' || required.view_name) IS NULL
  ),
  'Console V2 live wrapper views exist'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'driver_application_directory',
      'workflow_bindings',
      'workflow_binding_directory',
      'workflow_binding_dispatches',
      'recent_workflow_events',
      'webhook_rules',
      'kpi_definitions',
      'kpi_rollup_directory',
      'ui_event_log',
      'ui_event_log_directory',
      'alert_rules',
      'alert_triggers',
      'ops_alerts',
      'alert_rule_directory'
    ]) AS required(key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') AS item(value)
      WHERE item.value->>'key' = required.key
    )
  ),
  'ui_read_registry contains remaining Console V2 live route resources'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.alert_rules', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.alert_triggers', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.ops_alerts', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.v_alert_trigger_summary', 'SELECT')
  AND has_table_privilege('authenticated', 'public.alert_rules_console_v1', 'SELECT')
  AND has_table_privilege('authenticated', 'public.ops_alerts_console_v1', 'SELECT')
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ui_event_log'
      AND policyname = 'ui_event_log_authenticated_read'
      AND qual LIKE '%observability.read%'
  ),
  'alerts and UI telemetry resources use hardened direct grants plus browser-readable Console views'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'ops_alerts',
      'planning_os_execution_cards',
      'planning_os_project_items',
      'support_user_roster_policy',
      'vehicle_documents',
      'wave_catalog'
    ]) AS required(view_name)
    WHERE to_regclass('api.' || required.view_name) IS NULL
      OR NOT has_table_privilege('authenticated', 'api.' || required.view_name, 'SELECT')
      OR has_table_privilege('anon', 'api.' || required.view_name, 'SELECT')
  ),
  'late Console V2 API contract views exist with authenticated-only read grants'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type <> 'global'
      AND EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
          'alert_rules',
          'alert_triggers',
          'ops_alerts',
          'alert_rule_directory'
        ]) AS required(key)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS item(value)
          WHERE item.value->>'key' = required.key
        )
      )
  ),
  'scoped ui_read_registry rows include Console V2 alert resources'
);

SELECT set_config('request.jwt.claim.sub', '6c9ef9fe-5d1d-4f6e-9d75-d588f1cf61c9', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '6c9ef9fe-5d1d-4f6e-9d75-d588f1cf61c9',
    'role', 'authenticated',
    'email', 'console-v2-live-route-registry@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

DO $probe$
DECLARE
  v_resource TEXT;
  v_list JSONB;
BEGIN
  FOREACH v_resource IN ARRAY ARRAY[
    'driver_application_directory',
    'workflow_bindings',
    'workflow_binding_directory',
    'workflow_binding_dispatches',
    'recent_workflow_events',
    'webhook_rules',
    'kpi_definitions',
    'kpi_rollup_directory',
    'ui_event_log',
    'ui_event_log_directory',
    'alert_rules',
    'alert_triggers',
    'ops_alerts',
    'alert_rule_directory'
  ]
  LOOP
    SELECT api.ui_list_resource_v1(v_resource, '{}'::jsonb, 5, 0, NULL::jsonb)
      INTO v_list;
    IF v_list->>'resource' IS DISTINCT FROM v_resource THEN
      RAISE EXCEPTION 'api.ui_list_resource_v1 returned wrong resource for %', v_resource;
    END IF;
  END LOOP;
END;
$probe$;

RESET ROLE;

SELECT pass('authenticated Console V2 live route reads complete without unknown-resource errors');

SELECT * FROM finish();

ROLLBACK;
