-- Console V2 API gateway request directory materialized-shipment state.
--
-- API shipment intake is shipment-proofed only when the canonical shipment
-- lineage exists. Once it does, the operator-facing request directory must not
-- keep the request in provider_failed/not_dispatched/workflow_queued as the
-- primary lifecycle state. Provider status and error remain visible as
-- diagnostics.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605111310_api_gateway_request_directory_materialized_state_v1'));

SET search_path TO public, extensions, pg_temp;
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
  'Console V2 request-first API gateway intake projection. Starts from api_gateway_requests so failed pre-dispatch intake remains visible; linked canonical shipments project as shipment_materialized while provider failures remain visible as diagnostics. SSOT remains api_gateway_requests, api_routes, webhook_sources, clients, senders, outbound_calls, and shipment metadata linkage.';

REVOKE ALL ON public.v_api_gateway_request_directory FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_request_directory FROM anon;
REVOKE ALL ON public.v_api_gateway_request_directory FROM authenticated;
GRANT SELECT ON public.v_api_gateway_request_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605111310_api_gateway_request_directory_materialized_state_v1'));

COMMIT;
