-- Plan: Console V2 lifecycle live-route closure
-- Step: register remaining Browser-observed live resources and expose
--       FE-shaped read-only projections over canonical SSOT tables.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041040_console_v2_live_route_registry_backfill_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.workflow_bindings_console_v1
WITH (security_invoker = true) AS
WITH first_stage AS (
  SELECT DISTINCT ON (wbsr.binding_key)
    wbsr.binding_key,
    wbsr.stage_key,
    wbsr.sequence_order,
    wbsr.is_enabled
  FROM public.workflow_binding_stage_registry wbsr
  ORDER BY wbsr.binding_key, wbsr.sequence_order ASC, wbsr.stage_key ASC
),
latest_dispatch AS (
  SELECT DISTINCT ON (wbd.binding_key)
    wbd.binding_key,
    wbd.workflow_template_id,
    wbd.outcome,
    wbd.created_at
  FROM public.workflow_binding_dispatches wbd
  ORDER BY wbd.binding_key, wbd.created_at DESC
)
SELECT
  wbr.binding_key AS id,
  wbr.binding_key,
  regexp_replace(wbr.binding_key, '\.[^.]+$', '') AS event,
  ld.workflow_template_id::text AS template_id,
  ld.workflow_template_id,
  fs.stage_key,
  '{}'::jsonb AS condition,
  COALESCE(fs.sequence_order, 0)::int AS priority,
  wbr.configurability_status AS status,
  COALESCE(fs.is_enabled, true) AS enabled,
  wbr.label,
  wbr.description,
  wbr.resource_type,
  wbr.actor_surface,
  wbr.entrypoint_type,
  wbr.current_execution_kind,
  wbr.configurability_status,
  wbr.owner,
  wbr.migration_phase,
  wbr.is_business_affecting,
  ld.outcome AS last_dispatch_outcome,
  ld.created_at AS last_dispatch_at,
  wbr.created_at,
  wbr.updated_at
FROM public.workflow_binding_registry wbr
LEFT JOIN first_stage fs
  ON fs.binding_key = wbr.binding_key
LEFT JOIN latest_dispatch ld
  ON ld.binding_key = wbr.binding_key;

CREATE OR REPLACE VIEW public.workflow_binding_dispatches_console_v1
WITH (security_invoker = true) AS
SELECT
  wbd.id,
  wbd.binding_key,
  wbd.stage_key,
  regexp_replace(wbd.binding_key, '\.[^.]+$', '') AS event,
  wbd.workflow_template_id,
  wt.name AS template_name,
  wbd.workflow_run_id,
  wbd.resolved_scope_type,
  wbd.resolved_scope_id,
  wbd.outcome,
  wbd.actor_system,
  wbd.source_function,
  wbd.idempotency_key,
  wbd.settings_resolution_id,
  COALESCE(wbd.context, '{}'::jsonb) AS context,
  wbd.created_at,
  wbd.updated_at
FROM public.workflow_binding_dispatches wbd
LEFT JOIN public.workflow_templates wt
  ON wt.id = wbd.workflow_template_id;

CREATE OR REPLACE VIEW public.recent_workflow_events_console_v1
WITH (security_invoker = true) AS
SELECT
  de.id,
  de.organization_id,
  de.workflow_run_id,
  de.event_type,
  de.event_type AS event,
  de.created_at AS received_at,
  de.created_at,
  COALESCE(de.payload, '{}'::jsonb) AS payload,
  wt.name AS matched_template,
  de.resource_type,
  de.resource_id,
  de.correlation_id,
  de.status,
  de.error_reason,
  de.processed_at,
  de.updated_at
FROM public.domain_events de
LEFT JOIN public.workflow_runs wr
  ON wr.id = de.workflow_run_id
LEFT JOIN public.workflow_templates wt
  ON wt.id = wr.workflow_template_id;

CREATE OR REPLACE VIEW public.kpi_rollup_directory_console_v1
WITH (security_invoker = true) AS
SELECT
  base.*,
  row_number() OVER (
    ORDER BY base.is_active DESC, base.kpi_key ASC, base.scope_label ASC
  )::int AS rank,
  base.kpi_label AS label,
  base.kpi_label AS name,
  base.value_num AS value,
  base.value_num AS display_value,
  NULL::text AS delta,
  NULL::jsonb AS spark
FROM public.v_kpi_rollup_directory base;

CREATE OR REPLACE VIEW public.alert_rules_console_v1
WITH (security_invoker = true) AS
SELECT
  ar.id,
  ar.organization_id,
  ar.rule_name,
  ar.rule_name AS name,
  ar.enabled,
  ar.priority,
  ar.trigger_source,
  ar.trigger_conditions,
  ar.trigger_conditions AS condition,
  ar.throttle_window_minutes,
  ar.throttle_key_fields,
  ar.alert_severity_lookup_id,
  COALESCE(lv.value, ar.message_variables->>'severity') AS severity,
  ar.alert_channels,
  CASE
    WHEN jsonb_typeof(ar.alert_channels) = 'array'
     AND jsonb_array_length(ar.alert_channels) > 0
      THEN ar.alert_channels->>0
    ELSE NULL
  END AS channel,
  ar.message_template_id,
  ar.message_variables,
  ar.created_by,
  ar.created_at,
  ar.updated_at,
  ar.deleted_at,
  ar.deleted_by,
  ar.updated_by
FROM public.alert_rules ar
LEFT JOIN public.lookup_values lv
  ON lv.id = ar.alert_severity_lookup_id
WHERE ar.deleted_at IS NULL;

CREATE OR REPLACE VIEW public.ops_alerts_console_v1
WITH (security_invoker = true) AS
SELECT
  oa.id,
  oa.organization_id,
  oa.alert_type,
  oa.alert_type AS source,
  oa.severity,
  oa.message,
  COALESCE(oa.details, '{}'::jsonb) AS details,
  oa.decision_log_id,
  oa.correlation_id,
  oa.acknowledged_at,
  oa.acknowledged_by,
  oa.acknowledged_by_user_id,
  oa.resolved_at,
  oa.resolved_by_user_id,
  oa.resolution_notes,
  oa.created_at AS opened_at,
  oa.created_at,
  oa.updated_at
FROM public.ops_alerts oa;

REVOKE ALL ON public.workflow_bindings_console_v1 FROM PUBLIC;
REVOKE ALL ON public.workflow_bindings_console_v1 FROM anon;
GRANT SELECT ON public.workflow_bindings_console_v1 TO authenticated, service_role;

REVOKE ALL ON public.workflow_binding_dispatches_console_v1 FROM PUBLIC;
REVOKE ALL ON public.workflow_binding_dispatches_console_v1 FROM anon;
GRANT SELECT ON public.workflow_binding_dispatches_console_v1 TO authenticated, service_role;

REVOKE ALL ON public.recent_workflow_events_console_v1 FROM PUBLIC;
REVOKE ALL ON public.recent_workflow_events_console_v1 FROM anon;
GRANT SELECT ON public.recent_workflow_events_console_v1 TO authenticated, service_role;

REVOKE ALL ON public.kpi_rollup_directory_console_v1 FROM PUBLIC;
REVOKE ALL ON public.kpi_rollup_directory_console_v1 FROM anon;
GRANT SELECT ON public.kpi_rollup_directory_console_v1 TO authenticated, service_role;

REVOKE ALL ON public.alert_rules_console_v1 FROM PUBLIC;
REVOKE ALL ON public.alert_rules_console_v1 FROM anon;
GRANT SELECT ON public.alert_rules_console_v1 TO authenticated, service_role;

REVOKE ALL ON public.ops_alerts_console_v1 FROM PUBLIC;
REVOKE ALL ON public.ops_alerts_console_v1 FROM anon;
GRANT SELECT ON public.ops_alerts_console_v1 TO authenticated, service_role;

GRANT SELECT ON public.alert_rules TO authenticated;
GRANT SELECT ON public.alert_triggers TO authenticated;
GRANT SELECT ON public.ops_alerts TO authenticated;
GRANT SELECT ON public.v_alert_trigger_summary TO authenticated;

DROP POLICY IF EXISTS alert_rules_authenticated_select ON public.alert_rules;
CREATE POLICY alert_rules_authenticated_select
  ON public.alert_rules
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_capability_v1('alerts.read')
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS alert_triggers_authenticated_select ON public.alert_triggers;
CREATE POLICY alert_triggers_authenticated_select
  ON public.alert_triggers
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_capability_v1('alerts.read')
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS ops_alerts_authenticated_select ON public.ops_alerts;
CREATE POLICY ops_alerts_authenticated_select
  ON public.ops_alerts
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_capability_v1('alerts.read')
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS ui_event_log_authenticated_read ON public.ui_event_log;
CREATE POLICY ui_event_log_authenticated_read
  ON public.ui_event_log
  FOR SELECT
  TO authenticated
  USING (
    (
      public.user_has_capability_v1('observability.read')
      OR public.user_has_capability_v1('audit_log.read')
    )
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

COMMENT ON VIEW public.workflow_bindings_console_v1 IS
  'Console V2 read-only projection over workflow binding registry/stage/dispatch SSOT. Mutations remain workflow_binding_policy settings/RPC-driven.';
COMMENT ON VIEW public.workflow_binding_dispatches_console_v1 IS
  'Console V2 read-only projection over workflow_binding_dispatches with binding event/template labels.';
COMMENT ON VIEW public.recent_workflow_events_console_v1 IS
  'Console V2 read-only projection over domain_events for workflow event sampling.';
COMMENT ON VIEW public.kpi_rollup_directory_console_v1 IS
  'Console V2 read-only wrapper over v_kpi_rollup_directory with rank/display aliases required by dashboardKpis.';
COMMENT ON VIEW public.alert_rules_console_v1 IS
  'Console V2 read-only projection over alert_rules with legacy FE aliases name/condition/severity/channel.';
COMMENT ON VIEW public.ops_alerts_console_v1 IS
  'Console V2 read-only projection over ops_alerts with legacy FE aliases opened_at/source.';

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_resource JSONB;
  v_resources JSONB := '[
    {"key":"driver_application_directory","relation":"public.v_driver_application_directory","id_column":"id","capability_read":"fleet.read","capability_write":"fleet.write","default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"email","column":"email","op":"ilike"},{"key":"full_name","column":"full_name","op":"ilike"}]},
    {"key":"workflow_bindings","relation":"public.workflow_bindings_console_v1","id_column":"id","capability_read":"workflows.read","capability_write":"workflows.write","default_sort":{"column":"priority","direction":"asc"},"filters":[{"key":"event","column":"event","op":"ilike"},{"key":"stage_key","column":"stage_key","op":"eq"},{"key":"status","column":"status","op":"eq"}]},
    {"key":"workflow_binding_directory","relation":"public.v_workflow_binding_directory","id_column":"id","capability_read":"workflows.read","default_sort":{"column":"updated_at","direction":"desc"},"filters":[{"key":"binding_key","column":"binding_key","op":"ilike"},{"key":"configurability_status","column":"configurability_status","op":"eq"},{"key":"is_active","column":"is_active","op":"eq"}]},
    {"key":"workflow_binding_dispatches","relation":"public.workflow_binding_dispatches_console_v1","id_column":"id","capability_read":"workflows.read","default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"binding_key","column":"binding_key","op":"eq"},{"key":"stage_key","column":"stage_key","op":"eq"},{"key":"outcome","column":"outcome","op":"eq"}]},
    {"key":"recent_workflow_events","relation":"public.recent_workflow_events_console_v1","id_column":"id","capability_read":"workflows.read","default_sort":{"column":"received_at","direction":"desc"},"filters":[{"key":"event","column":"event","op":"ilike"},{"key":"status","column":"status","op":"eq"},{"key":"workflow_run_id","column":"workflow_run_id","op":"eq"}]},
    {"key":"webhook_rules","relation":"public.webhook_rules","id_column":"id","capability_read":"webhooks.read","capability_write":"webhooks.write","default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"webhook_source_id","column":"webhook_source_id","op":"eq"},{"key":"event_type","column":"event_type","op":"eq"},{"key":"enabled","column":"enabled","op":"eq"}]},
    {"key":"kpi_definitions","relation":"public.kpi_definitions","id_column":"id","capability_read":"insights.read","default_sort":{"column":"key","direction":"asc"},"filters":[{"key":"key","column":"key","op":"ilike"},{"key":"is_active","column":"is_active","op":"eq"}]},
    {"key":"kpi_rollup_directory","relation":"public.kpi_rollup_directory_console_v1","id_column":"id","capability_read":"insights.read","default_sort":{"column":"rank","direction":"asc"},"filters":[{"key":"kpi_key","column":"kpi_key","op":"ilike"},{"key":"is_active","column":"is_active","op":"eq"},{"key":"has_rollup","column":"has_rollup","op":"eq"}]},
    {"key":"ui_event_log","relation":"public.ui_event_log","id_column":"id","capability_read":"observability.read","default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"event_type","column":"event_type","op":"ilike"},{"key":"app","column":"app","op":"eq"},{"key":"user_id","column":"user_id","op":"eq"}]},
    {"key":"ui_event_log_directory","relation":"public.v_ui_event_log_directory","id_column":"id","capability_read":"observability.read","default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"event_type","column":"event_type","op":"ilike"},{"key":"app","column":"app","op":"eq"},{"key":"is_action","column":"is_action","op":"eq"}]},
    {"key":"alert_rules","relation":"public.alert_rules_console_v1","id_column":"id","capability_read":"alerts.read","capability_write":"alerts.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"enabled","column":"enabled","op":"eq"},{"key":"severity","column":"severity","op":"eq"},{"key":"name","column":"name","op":"ilike"}]},
    {"key":"alert_triggers","relation":"public.v_alert_trigger_summary","id_column":"id","capability_read":"alerts.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"fired_at","direction":"desc"},"filters":[{"key":"rule_id","column":"rule_id","op":"eq"},{"key":"status","column":"status","op":"eq"},{"key":"severity","column":"severity","op":"eq"}]},
    {"key":"ops_alerts","relation":"public.ops_alerts_console_v1","id_column":"id","capability_read":"alerts.read","capability_write":"alerts.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"opened_at","direction":"desc"},"filters":[{"key":"severity","column":"severity","op":"eq"},{"key":"source","column":"source","op":"eq"},{"key":"alert_type","column":"alert_type","op":"eq"}]},
    {"key":"alert_rule_directory","relation":"public.v_alert_rule_directory","id_column":"id","capability_read":"alerts.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"rule_name","column":"rule_name","op":"ilike"},{"key":"enabled","column":"enabled","op":"eq"},{"key":"severity_label","column":"severity_label","op":"eq"}]}
  ]'::jsonb;
  v_filtered JSONB;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);

  FOR v_resource IN
    SELECT value FROM jsonb_array_elements(v_resources) AS value
  LOOP
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);
  END LOOP;

  UPDATE public.settings_versions
     SET value = v_current,
         updated_at = now(),
         change_reason = 'Backfill Console V2 lifecycle live read resources',
         approved_at = now(),
         effective_from = now()
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605041040_console_v2_live_route_registry_backfill_v1'));

COMMIT;
