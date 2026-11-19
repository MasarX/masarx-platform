-- Console V2 API Gateway duplicate/replay readback repair.
-- A reused shipment may have mutable shipment metadata pointing at the latest
-- API Gateway request, while append-only shipment_actions preserves every
-- materializing request. The request directory must use that lineage so every
-- request row can open the correct shipment context.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605151650_api_gateway_request_directory_action_lineage_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_api_gateway_request_directory
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
    WHEN shp.shipment_id IS NOT NULL
      AND NOT (
        COALESCE(oc.status IN ('failed', 'permanently_failed'), FALSE)
        OR COALESCE(oc.response_status_code >= 400, FALSE)
      )
      THEN NULL
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
    WHEN shp.shipment_id IS NOT NULL THEN 'shipment_materialized'
    WHEN oc.status IN ('failed', 'permanently_failed') OR COALESCE(oc.response_status_code, 0) >= 400 THEN 'provider_failed'
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
  agr.updated_at,
  NULLIF(oc.error_message, '') AS outbound_error_message
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
    AND (
      s.metadata #>> '{source,api_gateway_request_id}' = agr.id::text
      OR EXISTS (
        SELECT 1
          FROM public.shipment_actions sa
         WHERE sa.shipment_id = s.id
           AND sa.organization_id = agr.organization_id
           AND sa.action_type = 'api_gateway_materialized'
           AND sa.action_data->>'api_gateway_request_id' = agr.id::text
      )
    )
  ORDER BY
    CASE
      WHEN s.metadata #>> '{source,api_gateway_request_id}' = agr.id::text THEN 0
      ELSE 1
    END,
    s.created_at DESC
  LIMIT 1
) shp ON TRUE;

COMMENT ON VIEW public.v_api_gateway_request_directory IS
  'Console V2 request-first API gateway intake projection. Starts from api_gateway_requests so failed pre-dispatch intake remains visible; linked canonical shipments project as shipment_materialized while provider failures remain visible as diagnostics. Shipment handoff resolves from direct shipment metadata or append-only api_gateway_materialized shipment_actions lineage so duplicate/replay requests keep stable shipment context.';

REVOKE ALL ON public.v_api_gateway_request_directory FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_request_directory FROM anon;
REVOKE ALL ON public.v_api_gateway_request_directory FROM authenticated;
GRANT SELECT ON public.v_api_gateway_request_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605151650_api_gateway_request_directory_action_lineage_v1'));
COMMIT;
