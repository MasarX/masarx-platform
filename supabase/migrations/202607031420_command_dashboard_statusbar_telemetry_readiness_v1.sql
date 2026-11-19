-- Command Center status strip telemetry repair.
-- Keeps the footer provider telemetry chips backend-backed through the
-- ui_read_registry instead of showing false "unavailable" state from an
-- old-format provider-health registry entry.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607031420_command_dashboard_statusbar_telemetry_readiness_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.provider_health_latest_v
WITH (security_invoker = true) AS
SELECT
  p.organization_id,
  ph.provider_id,
  p.name AS provider_name,
  ph.status,
  ph.error_message,
  ph.metadata,
  ph.decision_log_id,
  ph.correlation_id,
  ph.created_at,
  CASE
    WHEN COALESCE(ph.metadata->>'latency_ms', '') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (ph.metadata->>'latency_ms')::numeric
    WHEN COALESCE(ph.metadata->>'avg_latency_ms', '') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (ph.metadata->>'avg_latency_ms')::numeric
    ELSE NULL::numeric
  END AS latency_ms
FROM (
  SELECT
    phl.*,
    ROW_NUMBER() OVER (
      PARTITION BY phl.provider_id
      ORDER BY phl.created_at DESC, phl.id DESC
    ) AS row_rank
  FROM public.provider_health_logs phl
) ph
JOIN public.providers p ON p.id = ph.provider_id
WHERE ph.row_rank = 1;

CREATE OR REPLACE VIEW public.circuit_breaker_dashboard_v
WITH (security_invoker = true) AS
SELECT
  p.organization_id,
  cbs.provider_id,
  p.name AS provider_name,
  cbs.operation_name,
  cbs.state,
  cbs.failure_count,
  cbs.success_count,
  cbs.reopen_count,
  cbs.manual_intervention_required,
  cbs.last_failure_at,
  cbs.last_success_at,
  cbs.opened_at,
  cbs.half_open_test_at,
  cbs.last_recovery_attempt_at,
  cbs.updated_at,
  ph.status AS last_health_status,
  ph.error_message AS last_health_error,
  ph.created_at AS last_health_at
FROM public.circuit_breaker_state cbs
JOIN public.providers p ON p.id = cbs.provider_id
LEFT JOIN LATERAL (
  SELECT status, error_message, created_at
  FROM public.provider_health_logs phl
  WHERE phl.provider_id = cbs.provider_id
  ORDER BY phl.created_at DESC, phl.id DESC
  LIMIT 1
) ph ON TRUE;

REVOKE ALL ON public.provider_health_latest_v FROM PUBLIC;
REVOKE ALL ON public.provider_health_latest_v FROM anon;
GRANT SELECT ON public.provider_health_latest_v TO authenticated, service_role;

REVOKE ALL ON public.circuit_breaker_dashboard_v FROM PUBLIC;
REVOKE ALL ON public.circuit_breaker_dashboard_v FROM anon;
GRANT SELECT ON public.circuit_breaker_dashboard_v TO authenticated, service_role;

COMMENT ON VIEW public.provider_health_latest_v IS
  'Latest provider health signal per provider_id sourced from provider_health_logs for Console V2 status strip and Integration Health.';
COMMENT ON VIEW public.circuit_breaker_dashboard_v IS
  'Current circuit breaker state per provider operation with latest provider_health_logs signal.';

DO $do$
DECLARE
  v_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'provider_health_latest',
      'label', 'Provider health',
      'relation', 'public.provider_health_latest_v',
      'allow_view_relation', TRUE,
      'id_column', 'provider_id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'integrations.read',
      'select', jsonb_build_array(
        'organization_id','provider_id','provider_name','status','error_message',
        'metadata','latency_ms','decision_log_id','correlation_id','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
        jsonb_build_object('key','provider_id','column','provider_id','op','eq'),
        jsonb_build_object('key','status','column','status','op','eq'),
        jsonb_build_object('key','provider_name','column','provider_name','op','ilike')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'circuit_breaker_dashboard',
      'label', 'Circuit breaker',
      'relation', 'public.circuit_breaker_dashboard_v',
      'allow_view_relation', TRUE,
      'id_column', 'provider_id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'integrations.read',
      'select', jsonb_build_array(
        'organization_id','provider_id','provider_name','operation_name','state',
        'failure_count','success_count','reopen_count','manual_intervention_required',
        'last_failure_at','last_success_at','opened_at','half_open_test_at',
        'last_recovery_attempt_at','updated_at','last_health_status',
        'last_health_error','last_health_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
        jsonb_build_object('key','provider_id','column','provider_id','op','eq'),
        jsonb_build_object('key','state','column','state','op','eq'),
        jsonb_build_object('key','provider_name','column','provider_name','op','ilike')
      ),
      'default_sort', jsonb_build_object('column','updated_at','direction','desc')
    )
  );
  v_setting RECORD;
  v_current JSONB;
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

    UPDATE public.settings_versions
       SET value = v_current,
           version = v_setting.version + 1,
           change_reason = 'Restore Command Center provider telemetry registry readback',
           approved_at = now(),
           effective_from = now()
     WHERE id = v_setting.settings_version_id
       AND value IS DISTINCT FROM v_current;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE id = v_setting.setting_id
       AND cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_resource_map JSONB := jsonb_build_object(
    'provider_health_latest', jsonb_build_object('read', 'integrations.read'),
    'circuit_breaker_dashboard', jsonb_build_object('read', 'integrations.read')
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
           change_reason = 'Map Command Center provider telemetry capabilities',
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

SELECT pg_advisory_unlock(hashtext('202607031420_command_dashboard_statusbar_telemetry_readiness_v1'));

COMMIT;
