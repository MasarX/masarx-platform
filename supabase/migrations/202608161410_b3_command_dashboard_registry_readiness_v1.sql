-- Command Center dashboard registry/readiness repair.
-- Restores Console V2 dashboard live-mode contracts on backends that missed the
-- older Console V2 registry backfills: KPI cards, route-run counters, ops
-- alerts, comms attempts, and the browser-safe settings policy resolver.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607031300_command_dashboard_registry_readiness_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_settings_row_from_policy_context_v1(
  p_category TEXT,
  p_context JSONB
)
RETURNS TABLE(
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INTEGER,
  scope_path JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1(p_category, p_context);
$function$;

REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  TO service_role;

COMMENT ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  IS 'Service-role-only wrapper for public.resolve_settings_row_from_policy_context_v1.';

ALTER TABLE public.ops_alerts
  ADD COLUMN IF NOT EXISTS acknowledged_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

CREATE OR REPLACE VIEW public.command_route_runs_dashboard_v1
WITH (security_invoker = true) AS
SELECT
  id,
  organization_id,
  branch_id,
  driver_user_id,
  vehicle_id,
  status,
  planned_date,
  planned_start_at,
  planned_end_at,
  started_at,
  ended_at,
  metadata,
  route_plan_id,
  created_at,
  updated_at
FROM public.route_runs;

CREATE OR REPLACE VIEW public.command_ops_alerts_console_v1
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

CREATE OR REPLACE VIEW public.command_comms_attempt_directory_v1
WITH (security_invoker = true) AS
SELECT
  ca.id,
  s.organization_id,
  oc.shipment_id,
  COALESCE(ca.provider_id, oc.target_id) AS provider_id,
  ca.outbound_call_id,
  ca.attempt_number,
  ca.status,
  lower(regexp_replace(COALESCE(oc.call_type, ''), '^comms_', '')) AS channel,
  oc.context->>'template_id' AS template,
  ca.provider_message_id,
  ca.error_code,
  ca.error_message,
  ca.timestamp AS occurred_at,
  ca.created_at,
  ca.updated_at
FROM public.comms_attempts ca
LEFT JOIN public.outbound_calls oc
  ON oc.id = ca.outbound_call_id
LEFT JOIN public.shipments s
  ON s.id = oc.shipment_id
WHERE public.is_platform_user()
   OR (
     s.id IS NOT NULL
     AND (
       (public.current_user_scope_type() = 'tenant'
        AND s.organization_id = public.current_user_org_id())
       OR (public.current_user_scope_type() = 'client'
           AND s.client_id = public.current_user_scope_id())
       OR (public.current_user_scope_type() = 'sender'
           AND s.sender_id = public.current_user_scope_id())
     )
   );

INSERT INTO public.kpi_definitions (
  organization_id,
  key,
  name,
  description,
  unit,
  definition,
  is_active,
  metadata
)
SELECT
  org.id,
  def.key,
  def.name,
  def.description,
  def.unit,
  def.definition,
  TRUE,
  jsonb_build_object(
    'surface', 'command_dashboard',
    'source', '202607031300_command_dashboard_registry_readiness_v1'
  )
FROM public.organizations org
CROSS JOIN (
  VALUES
    (
      'active_route_runs',
      'Active route runs',
      'Active route runs currently visible to Command Center operators.',
      'count',
      '{"group":"command_center","format":"number","tone":"neutral","delta_label":"current"}'::jsonb
    ),
    (
      'stops_in_flight',
      'Stops in flight',
      'Projected stop count across active route runs.',
      'count',
      '{"group":"command_center","format":"number","tone":"info","delta_label":"current"}'::jsonb
    ),
    (
      'open_ops_alerts',
      'Open ops alerts',
      'Unresolved operations alerts visible to Command Center operators.',
      'count',
      '{"group":"command_center","format":"number","tone":"warn","delta_label":"current"}'::jsonb
    ),
    (
      'comms_attempts_24h',
      'Comms attempts · 24h',
      'Communications attempts recorded in the last 24 hours.',
      'count',
      '{"group":"command_center","format":"number","tone":"neutral","delta_label":"24h"}'::jsonb
    )
) AS def(key, name, description, unit, definition)
ON CONFLICT (organization_id, key) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  unit = EXCLUDED.unit,
  definition = public.kpi_definitions.definition || EXCLUDED.definition,
  is_active = TRUE,
  metadata = public.kpi_definitions.metadata || EXCLUDED.metadata,
  updated_at = now();

INSERT INTO public.kpi_rollups_daily (
  organization_id,
  kpi_key,
  day,
  dimensions,
  value_num,
  numerator,
  denominator,
  idempotency_key,
  metadata
)
SELECT
  kd.organization_id,
  kd.key,
  current_date,
  jsonb_build_object('surface', 'command_dashboard'),
  CASE kd.key
    WHEN 'active_route_runs' THEN (
      SELECT count(*)::numeric
      FROM public.route_runs rr
      WHERE rr.organization_id = kd.organization_id
        AND rr.status NOT IN ('completed', 'cancelled')
    )
    WHEN 'stops_in_flight' THEN (
      SELECT COALESCE(sum(
        CASE
          WHEN COALESCE(rr.metadata->>'stops', '') ~ '^[0-9]+(\.[0-9]+)?$'
            THEN (rr.metadata->>'stops')::numeric
          ELSE 0
        END
      ), 0)::numeric
      FROM public.route_runs rr
      WHERE rr.organization_id = kd.organization_id
        AND rr.status NOT IN ('completed', 'cancelled')
    )
    WHEN 'open_ops_alerts' THEN (
      SELECT count(*)::numeric
      FROM public.ops_alerts oa
      WHERE oa.organization_id = kd.organization_id
        AND oa.resolved_at IS NULL
    )
    WHEN 'comms_attempts_24h' THEN (
      SELECT count(*)::numeric
      FROM public.comms_attempts ca
      JOIN public.outbound_calls oc ON oc.id = ca.outbound_call_id
      JOIN public.shipments s ON s.id = oc.shipment_id
      WHERE s.organization_id = kd.organization_id
        AND ca.timestamp >= now() - interval '24 hours'
    )
    ELSE 0
  END AS value_num,
  CASE kd.key
    WHEN 'active_route_runs' THEN (
      SELECT count(*)::numeric
      FROM public.route_runs rr
      WHERE rr.organization_id = kd.organization_id
        AND rr.status NOT IN ('completed', 'cancelled')
    )
    WHEN 'stops_in_flight' THEN (
      SELECT COALESCE(sum(
        CASE
          WHEN COALESCE(rr.metadata->>'stops', '') ~ '^[0-9]+(\.[0-9]+)?$'
            THEN (rr.metadata->>'stops')::numeric
          ELSE 0
        END
      ), 0)::numeric
      FROM public.route_runs rr
      WHERE rr.organization_id = kd.organization_id
        AND rr.status NOT IN ('completed', 'cancelled')
    )
    WHEN 'open_ops_alerts' THEN (
      SELECT count(*)::numeric
      FROM public.ops_alerts oa
      WHERE oa.organization_id = kd.organization_id
        AND oa.resolved_at IS NULL
    )
    WHEN 'comms_attempts_24h' THEN (
      SELECT count(*)::numeric
      FROM public.comms_attempts ca
      JOIN public.outbound_calls oc ON oc.id = ca.outbound_call_id
      JOIN public.shipments s ON s.id = oc.shipment_id
      WHERE s.organization_id = kd.organization_id
        AND ca.timestamp >= now() - interval '24 hours'
    )
    ELSE 0
  END AS numerator,
  NULL::numeric AS denominator,
  'command_dashboard:' || kd.organization_id::text || ':' || kd.key || ':' || current_date::text,
  jsonb_build_object(
    'source', '202607031300_command_dashboard_registry_readiness_v1',
    'surface', 'command_dashboard'
  )
FROM public.kpi_definitions kd
WHERE kd.metadata->>'surface' = 'command_dashboard'
ON CONFLICT (organization_id, kpi_key, day, dimensions) DO UPDATE
SET
  value_num = EXCLUDED.value_num,
  numerator = EXCLUDED.numerator,
  denominator = EXCLUDED.denominator,
  metadata = public.kpi_rollups_daily.metadata || EXCLUDED.metadata,
  updated_at = now();

CREATE OR REPLACE VIEW public.command_dashboard_kpi_rollup_directory_v1
WITH (security_invoker = true) AS
SELECT
  COALESCE(kr.id::text, kd.id::text || '::no_rollup') AS id,
  kd.organization_id,
  kd.id AS definition_id,
  kd.key AS kpi_key,
  kd.name AS kpi_label,
  kd.name AS label,
  kd.name AS name,
  kd.description AS kpi_description,
  kd.unit AS kpi_unit,
  NULLIF(trim(kd.definition->>'group'), '') AS group_label,
  NULLIF(trim(kd.definition->>'format'), '') AS format,
  NULLIF(trim(kd.definition->>'tone'), '') AS tone,
  COALESCE(kd.definition->'tone_thresholds', '{}'::jsonb) AS tone_thresholds,
  kr.day,
  kr.value_num,
  kr.value_num AS value,
  kr.value_num AS display_value,
  kr.numerator,
  kr.denominator,
  COALESCE(kr.dimensions, '{}'::jsonb) AS dimensions,
  COALESCE(kr.dimensions->>'surface', 'command_dashboard') AS scope_label,
  kr.created_at AS rollup_created_at,
  kr.updated_at AS rollup_updated_at,
  CASE
    WHEN kr.updated_at IS NULL THEN NULL
    ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - kr.updated_at))::bigint)
  END AS age_seconds,
  kd.is_active,
  CASE
    WHEN kr.updated_at IS NULL THEN FALSE
    WHEN now() - kr.updated_at < interval '24 hours' THEN TRUE
    ELSE FALSE
  END AS is_fresh,
  CASE
    WHEN kr.updated_at IS NULL THEN TRUE
    WHEN now() - kr.updated_at >= interval '24 hours' THEN TRUE
    ELSE FALSE
  END AS is_stale,
  (kr.id IS NOT NULL) AS has_rollup,
  row_number() OVER (
    PARTITION BY kd.organization_id
    ORDER BY kd.is_active DESC, kd.key ASC
  )::int AS rank,
  kd.definition->>'delta_label' AS delta,
  NULL::jsonb AS spark
FROM public.kpi_definitions kd
LEFT JOIN LATERAL (
  SELECT r.*
  FROM public.kpi_rollups_daily r
  WHERE r.organization_id = kd.organization_id
    AND r.kpi_key = kd.key
  ORDER BY r.day DESC, r.updated_at DESC
  LIMIT 1
) kr ON TRUE
WHERE kd.metadata->>'surface' = 'command_dashboard'
   OR kd.definition->>'group' = 'command_center';

REVOKE ALL ON public.command_route_runs_dashboard_v1 FROM PUBLIC;
REVOKE ALL ON public.command_route_runs_dashboard_v1 FROM anon;
GRANT SELECT ON public.command_route_runs_dashboard_v1 TO authenticated, service_role;

REVOKE ALL ON public.command_ops_alerts_console_v1 FROM PUBLIC;
REVOKE ALL ON public.command_ops_alerts_console_v1 FROM anon;
GRANT SELECT ON public.command_ops_alerts_console_v1 TO authenticated, service_role;

REVOKE ALL ON public.command_comms_attempt_directory_v1 FROM PUBLIC;
REVOKE ALL ON public.command_comms_attempt_directory_v1 FROM anon;
GRANT SELECT ON public.command_comms_attempt_directory_v1 TO authenticated, service_role;

REVOKE ALL ON public.command_dashboard_kpi_rollup_directory_v1 FROM PUBLIC;
REVOKE ALL ON public.command_dashboard_kpi_rollup_directory_v1 FROM anon;
GRANT SELECT ON public.command_dashboard_kpi_rollup_directory_v1 TO authenticated, service_role;

COMMENT ON VIEW public.command_dashboard_kpi_rollup_directory_v1 IS
  'Command Center KPI directory for Console V2 dashboard cards. SSOT remains kpi_definitions and kpi_rollups_daily.';
COMMENT ON VIEW public.command_ops_alerts_console_v1 IS
  'Command Center read projection over ops_alerts with dashboard aliases opened_at/source and ack/resolve readback columns.';
COMMENT ON VIEW public.command_comms_attempt_directory_v1 IS
  'Command Center read projection over comms_attempts joined to outbound_calls/shipments without exposing payload secrets.';
COMMENT ON VIEW public.command_route_runs_dashboard_v1 IS
  'Command Center route run counter projection for Console V2 dashboard widgets.';

DO $do$
DECLARE
  v_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'kpi_rollup_directory',
      'label', 'Command dashboard KPI rollups',
      'relation', 'public.command_dashboard_kpi_rollup_directory_v1',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'insights.read',
      'select', jsonb_build_array(
        'id','organization_id','definition_id','kpi_key','kpi_label','label','name',
        'kpi_description','kpi_unit','group_label','format','tone','tone_thresholds',
        'day','value_num','value','display_value','numerator','denominator','dimensions',
        'scope_label','rollup_created_at','rollup_updated_at','age_seconds','is_active',
        'is_fresh','is_stale','has_rollup','rank','delta','spark'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
        jsonb_build_object('key','kpi_key','column','kpi_key','op','ilike'),
        jsonb_build_object('key','is_active','column','is_active','op','eq'),
        jsonb_build_object('key','has_rollup','column','has_rollup','op','eq')
      ),
      'default_sort', jsonb_build_object('column','rank','direction','asc')
    ),
    jsonb_build_object(
      'key', 'ops_alerts',
      'label', 'Ops alerts',
      'relation', 'public.command_ops_alerts_console_v1',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'alerts.read',
      'capability_write', 'alerts.write',
      'select', jsonb_build_array(
        'id','organization_id','alert_type','source','severity','message','details',
        'decision_log_id','correlation_id','acknowledged_at','acknowledged_by',
        'acknowledged_by_user_id','resolved_at','resolved_by_user_id',
        'resolution_notes','opened_at','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
        jsonb_build_object('key','severity','column','severity','op','eq'),
        jsonb_build_object('key','source','column','source','op','eq'),
        jsonb_build_object('key','alert_type','column','alert_type','op','eq')
      ),
      'default_sort', jsonb_build_object('column','opened_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'comms_attempts',
      'label', 'Comms attempts',
      'relation', 'public.command_comms_attempt_directory_v1',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant','organization_id','shipment','shipment_id'),
      'capability_read', 'shipments.read',
      'select', jsonb_build_array(
        'id','organization_id','shipment_id','provider_id','outbound_call_id',
        'attempt_number','status','channel','template','provider_message_id',
        'error_code','error_message','occurred_at','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
        jsonb_build_object('key','shipment_id','column','shipment_id','op','eq'),
        jsonb_build_object('key','status','column','status','op','eq'),
        jsonb_build_object('key','channel','column','channel','op','eq'),
        jsonb_build_object('key','provider_id','column','provider_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','occurred_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'route_runs',
      'label', 'Route runs',
      'relation', 'public.command_route_runs_dashboard_v1',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read', 'routes.read',
      'capability_write', 'routes.write',
      'select', jsonb_build_array(
        'id','organization_id','branch_id','driver_user_id','vehicle_id','status',
        'planned_date','planned_start_at','planned_end_at','started_at','ended_at',
        'metadata','route_plan_id','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
        jsonb_build_object('key','status','column','status','op','eq'),
        jsonb_build_object('key','planned_date','column','planned_date','op','eq')
      ),
      'default_sort', jsonb_build_object('column','updated_at','direction','desc')
    )
  );
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resource JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);

    FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources)
    LOOP
      v_current := jsonb_set(
        v_current,
        '{resources}',
        COALESCE((
          SELECT jsonb_agg(item)
          FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS item
          WHERE item->>'key' <> v_resource->>'key'
        ), '[]'::jsonb) || jsonb_build_array(v_resource),
        TRUE
      );
    END LOOP;

    v_next := v_current;

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Restore Command Center dashboard registry resources',
           approved_at = now(),
           effective_from = now()
     WHERE id = v_setting.settings_version_id
       AND value IS DISTINCT FROM v_next;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_setting.setting_id
       AND cached_value IS DISTINCT FROM v_next;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_resource_map JSONB := jsonb_build_object(
    'kpi_rollup_directory', jsonb_build_object('read', 'insights.read'),
    'ops_alerts', jsonb_build_object('read', 'alerts.read', 'write', 'alerts.write'),
    'comms_attempts', jsonb_build_object('read', 'shipments.read'),
    'route_runs', jsonb_build_object('read', 'routes.read', 'write', 'routes.write')
  );
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_key TEXT;
  v_value JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_setting.value, '{}'::jsonb);
    v_next := v_current;

    FOR v_key, v_value IN SELECT key, value FROM jsonb_each(v_resource_map)
    LOOP
      v_next := jsonb_set(
        v_next,
        ARRAY['resource_map', v_key],
        COALESCE(v_next#>ARRAY['resource_map', v_key], '{}'::jsonb) || v_value,
        TRUE
      );
    END LOOP;

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Map Command Center dashboard registry capabilities',
           approved_at = now(),
           effective_from = now()
     WHERE id = v_setting.settings_version_id
       AND value IS DISTINCT FROM v_next;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_setting.setting_id
       AND cached_value IS DISTINCT FROM v_next;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202607031300_command_dashboard_registry_readiness_v1'));

COMMIT;
