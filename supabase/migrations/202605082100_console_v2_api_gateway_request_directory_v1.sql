-- Console V2 API gateway request directory.
--
-- Server-to-server API intake must stay visible to operators even when the
-- downstream provider dispatch is never created. The live requests tab needs a
-- request-first projection over api_gateway_requests, not the outbound-call
-- observability view that starts from api_call_log.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605082100_console_v2_api_gateway_request_directory_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_api_gateway_request_directory;

CREATE VIEW public.v_api_gateway_request_directory
  WITH (security_invoker = true) AS
SELECT
  agr.id AS id,
  agr.id AS request_id,
  agr.organization_id,
  agr.client_id,
  c.name AS client_label,
  agr.sender_id,
  snd.name AS sender_label,
  agr.source_id,
  ws.name AS source_label,
  ws.organization_id AS source_org_id,
  agr.correlation_id,
  agr.route_id,
  ar.route_name,
  ar.pack_id AS route_pack_id,
  arp.name AS route_pack_name,
  upper(agr.method) AS method,
  agr.path,
  agr.query_string,
  agr.request_headers,
  agr.request_body,
  agr.outbound_call_id,
  oc.status AS outbound_status,
  oc.response_status_code AS status_code,
  CASE
    WHEN oc.response_status_code = 401 THEN 'unauthorized'
    WHEN oc.response_status_code = 403 THEN 'forbidden'
    WHEN oc.response_status_code = 404 THEN 'not_found'
    WHEN oc.response_status_code = 422 THEN 'validation_failed'
    WHEN oc.response_status_code = 429 THEN 'rate_limited'
    WHEN oc.response_status_code >= 500 AND oc.response_status_code < 504 THEN 'upstream_error'
    WHEN oc.response_status_code = 504 THEN 'upstream_timeout'
    WHEN oc.response_status_code >= 400 THEN COALESCE(NULLIF(oc.error_message, ''), 'error')
    WHEN oc.status IN ('failed', 'permanently_failed') THEN COALESCE(NULLIF(oc.error_message, ''), oc.status)
    WHEN agr.outbound_call_id IS NULL AND agr.workflow_run_id IS NULL THEN 'not_dispatched'
    ELSE NULL
  END AS error_code,
  CASE
    WHEN agr.workflow_run_id IS NOT NULL THEN 'workflow_queued'
    WHEN agr.outbound_call_id IS NOT NULL THEN COALESCE(oc.status, 'outbound_created')
    ELSE 'not_dispatched'
  END AS intake_state,
  agr.workflow_run_id,
  agr.settings_resolution_id,
  shp.shipment_id,
  shp.tracking_number,
  shp.shipment_status,
  agr.received_at,
  agr.received_at AS occurred_at,
  agr.created_at,
  agr.updated_at
FROM public.api_gateway_requests agr
LEFT JOIN public.api_routes ar
  ON ar.id = agr.route_id
LEFT JOIN public.api_route_packs arp
  ON arp.id = ar.pack_id
LEFT JOIN public.webhook_sources ws
  ON ws.id = agr.source_id
LEFT JOIN public.clients c
  ON c.id = agr.client_id
LEFT JOIN public.senders snd
  ON snd.id = agr.sender_id
LEFT JOIN public.outbound_calls oc
  ON oc.id = agr.outbound_call_id
LEFT JOIN LATERAL (
  SELECT
    s.id AS shipment_id,
    s.tracking_number,
    s.status AS shipment_status
  FROM public.shipments s
  WHERE s.organization_id = agr.organization_id
    AND s.metadata #>> '{source,api_gateway_request_id}' = agr.id::text
  ORDER BY s.created_at DESC
  LIMIT 1
) shp ON TRUE;

COMMENT ON VIEW public.v_api_gateway_request_directory IS
  'Console V2 request-first API gateway intake projection. Starts from api_gateway_requests so failed pre-dispatch intake remains visible; SSOT remains api_gateway_requests, api_routes, webhook_sources, clients, senders, outbound_calls, and shipment metadata linkage.';

REVOKE ALL ON public.v_api_gateway_request_directory FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_request_directory FROM anon;
REVOKE ALL ON public.v_api_gateway_request_directory FROM authenticated;
GRANT SELECT ON public.v_api_gateway_request_directory TO service_role;

DO $registry$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'api_gateway_requests',
    'label', 'API gateway requests',
    'relation', 'public.v_api_gateway_request_directory',
    'id_column', 'request_id',
    'capability_read', 'api_gateway.read',
    'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'allow_view_relation', true,
    'select', jsonb_build_array(
      'id',
      'request_id',
      'organization_id',
      'client_id',
      'client_label',
      'sender_id',
      'sender_label',
      'source_id',
      'source_label',
      'correlation_id',
      'route_id',
      'route_name',
      'route_pack_id',
      'route_pack_name',
      'method',
      'path',
      'query_string',
      'request_headers',
      'request_body',
      'status_code',
      'error_code',
      'intake_state',
      'outbound_call_id',
      'outbound_status',
      'workflow_run_id',
      'settings_resolution_id',
      'shipment_id',
      'tracking_number',
      'shipment_status',
      'occurred_at',
      'received_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq'),
      jsonb_build_object('key', 'correlation_id', 'column', 'correlation_id', 'op', 'eq'),
      jsonb_build_object('key', 'route_id', 'column', 'route_id', 'op', 'eq'),
      jsonb_build_object('key', 'route_pack_id', 'column', 'route_pack_id', 'op', 'eq'),
      jsonb_build_object('key', 'source_id', 'column', 'source_id', 'op', 'eq'),
      jsonb_build_object('key', 'status_code', 'column', 'status_code', 'op', 'eq'),
      jsonb_build_object('key', 'error_code', 'column', 'error_code', 'op', 'eq'),
      jsonb_build_object('key', 'intake_state', 'column', 'intake_state', 'op', 'eq')
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

    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(v_resources) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_resources := v_filtered || jsonb_build_array(v_resource);
    v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Expose request-first API gateway intake directory for Console V2',
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

SELECT pg_advisory_unlock(hashtext('202605082100_console_v2_api_gateway_request_directory_v1'));

COMMIT;
