-- Console V2 API gateway live read registry repair.
--
-- API/provider shipment intake is part of first-tenant readiness. The Console
-- API gateway surface must read through backend-backed registry resources, not
-- seed-only resource metadata.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605081330_console_v2_api_gateway_read_registry_repair_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $registry$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB;
  v_resources_to_add JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'api_gateway_observability',
      'label', 'API gateway observability',
      'relation', 'public.v_api_gateway_observability',
      'id_column', 'id',
      'capability_read', 'api_gateway.read',
      'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'allow_view_relation', true,
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq'),
        jsonb_build_object('key', 'route_id', 'column', 'route_id', 'op', 'eq'),
        jsonb_build_object('key', 'route_pack_id', 'column', 'route_pack_id', 'op', 'eq'),
        jsonb_build_object('key', 'source_id', 'column', 'source_id', 'op', 'eq'),
        jsonb_build_object('key', 'status_code', 'column', 'status_code', 'op', 'eq'),
        jsonb_build_object('key', 'error_code', 'column', 'error_code', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'api_gateway_rate_limits_summary',
      'label', 'API gateway rate limits',
      'relation', 'public.v_api_gateway_rate_limits_summary',
      'id_column', 'id',
      'capability_read', 'api_gateway.read',
      'capability_write', 'api_gateway.write',
      'default_sort', jsonb_build_object('column', 'window_start', 'direction', 'desc'),
      'scope_columns', jsonb_build_object('tenant', 'source_org_id'),
      'allow_view_relation', true,
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'source_id', 'column', 'source_id', 'op', 'eq'),
        jsonb_build_object('key', 'saturated', 'column', 'saturated', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'api_gateway_requests',
      'label', 'API gateway requests',
      'relation', 'public.v_api_gateway_observability',
      'id_column', 'request_id',
      'capability_read', 'api_gateway.read',
      'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'allow_view_relation', true,
      'select', jsonb_build_array(
        'request_id',
        'route_id',
        'route_pack_id',
        'status_code',
        'error_code',
        'occurred_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq'),
        jsonb_build_object('key', 'route_id', 'column', 'route_id', 'op', 'eq'),
        jsonb_build_object('key', 'route_pack_id', 'column', 'route_pack_id', 'op', 'eq'),
        jsonb_build_object('key', 'status_code', 'column', 'status_code', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'provider_health_logs',
      'label', 'Provider health logs',
      'relation', 'public.provider_health_logs',
      'id_column', 'id',
      'capability_read', 'api_gateway.read',
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'provider_id', 'column', 'provider_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'correlation_id', 'column', 'correlation_id', 'op', 'eq')
      )
    )
  );
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    FOR v_resource IN SELECT value FROM jsonb_array_elements(v_resources_to_add) AS value LOOP
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        INTO v_filtered
        FROM jsonb_array_elements(v_resources) AS value
       WHERE value->>'key' <> v_resource->>'key';
      v_resources := v_filtered || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Expose Console V2 API gateway backend-backed read resources',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$registry$;

SELECT pg_advisory_unlock(hashtext('202605081330_console_v2_api_gateway_read_registry_repair_v1'));

COMMIT;
