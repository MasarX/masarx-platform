-- Migration: API Gateway update/delete action readback
-- Purpose:
--   - Keep API Gateway create/update/delete proof request-first by exposing the
--     canonical shipment action created by provider-success postprocess handlers.
--   - Preserve existing create materialization readback while adding update and
--     cancel/delete action lineage to v_api_gateway_request_directory.

BEGIN;

SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_xact_lock(hashtext('202606021650_client_api_mapping_update_delete_action_readback_v1'));

-- This dependency historically preceded the readback view; keep the canonical
-- normalizer available before the view is parsed on a zero-state replay.
CREATE OR REPLACE FUNCTION public.api_gateway_route_canonical_intent_v1(p_policy JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_intent TEXT;
  v_mode TEXT;
BEGIN
  v_intent := lower(NULLIF(btrim(COALESCE(
    p_policy #>> '{workflow,intent}',
    p_policy #>> '{workflow,canonical_intent}',
    p_policy #>> '{postprocess,canonical_intent}',
    p_policy #>> '{postprocess,intent}',
    p_policy #>> '{intake,canonical_intent}',
    p_policy #>> '{intake,intent}',
    p_policy ->> 'canonical_intent'
  )), ''));

  IF v_intent IN ('shipment_create', 'shipment.created', 'shipments.create') THEN
    RETURN 'shipment.create';
  ELSIF v_intent IN ('shipment_update', 'shipment.updated', 'shipments.update', 'shipments.updated') THEN
    RETURN 'shipment.update';
  ELSIF v_intent IN (
    'shipment_cancel', 'shipment.canceled', 'shipment.cancelled', 'shipment.delete',
    'shipments.cancel', 'shipments.canceled', 'shipments.cancelled', 'shipments.delete'
  ) THEN
    RETURN 'shipment.delete';
  ELSIF v_intent IN (
    'shipment_reschedule', 'shipment.rescheduled',
    'shipments.reschedule', 'shipments.rescheduled'
  ) THEN
    RETURN 'shipment.reschedule';
  ELSIF v_intent IN ('shipments.update.status', 'shipment.update.status', 'shipment.status.update') THEN
    RETURN 'update.status';
  ELSIF v_intent IN ('shipments.update.address', 'shipment.update.address', 'shipment.address.update') THEN
    RETURN 'update.address';
  ELSIF v_intent IS NOT NULL THEN
    RETURN v_intent;
  END IF;

  v_mode := lower(COALESCE(p_policy #>> '{postprocess,mode}', ''));
  RETURN CASE v_mode
    WHEN 'shipment_create_v1' THEN 'shipment.create'
    WHEN 'shipment_update_v1' THEN 'shipment.update'
    WHEN 'shipment_update_status_v1' THEN 'update.status'
    WHEN 'shipment_update_address_v1' THEN 'update.address'
    WHEN 'shipment_update_geocode_v1' THEN 'update.geocode'
    WHEN 'shipment_update_driver_v1' THEN 'update.driver'
    WHEN 'shipment_update_action_v1' THEN 'update.action'
    WHEN 'shipment_update_attachment_v1' THEN 'update.attachment'
    WHEN 'shipment_cancel_v1' THEN 'shipment.delete'
    WHEN 'shipment_delete_v1' THEN 'shipment.delete'
    WHEN 'shipment_reschedule_v1' THEN 'shipment.reschedule'
    ELSE ''
  END;
END;
$function$;

COMMENT ON FUNCTION public.api_gateway_route_canonical_intent_v1(JSONB) IS
  'Normalizes API Gateway route policies into canonical shipment mutation intents for guards, workflow defaults, and Console tester parity.';

REVOKE ALL ON FUNCTION public.api_gateway_route_canonical_intent_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_gateway_route_canonical_intent_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.api_gateway_route_canonical_intent_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.api_gateway_route_canonical_intent_v1(JSONB) TO service_role, edge_api_gateway_role;

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
  COALESCE(oc.response_status_code, CASE WHEN rej.id IS NOT NULL THEN 400 END) AS status_code,
  CASE
    WHEN shp.shipment_id IS NOT NULL
      AND NOT (
        COALESCE(oc.status IN ('failed', 'permanently_failed'), FALSE)
        OR COALESCE(oc.response_status_code >= 400, FALSE)
      )
      THEN NULL
    WHEN rej.id IS NOT NULL THEN 'api_gateway_source_missing_sender_client'
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
    WHEN rej.id IS NOT NULL THEN 'source_binding_rejected'
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
  COALESCE(NULLIF(oc.error_message, ''), rej.decision_reason) AS outbound_error_message,
  COALESCE(NULLIF(agr.request_headers->>'idempotency-key', ''), NULLIF(agr.request_headers->>'x-idempotency-key', '')) AS idempotency_key,
  NULLIF(agr.request_headers->>'x-masarx-replay-of', '') AS replay_of_request_id,
  public.api_gateway_route_canonical_intent_v1(COALESCE(ar.policy, '{}'::jsonb)) AS mutation_intent,
  COALESCE(NULLIF(req_map.policy->>'mapping_config_id', ''), NULLIF(map_decision.decision_inputs #>> '{mapping,mapping_config_id}', '')) AS request_mapping_config_id,
  COALESCE(NULLIF(req_map.policy->>'mapping_key', ''), NULLIF(map_decision.decision_inputs #>> '{mapping,mapping_key}', '')) AS request_mapping_key,
  COALESCE(NULLIF(req_map.policy->>'mapping_type', ''), NULLIF(map_decision.decision_inputs #>> '{mapping,mapping_type}', '')) AS request_mapping_type,
  COALESCE(NULLIF(req_map.policy->>'target', ''), NULLIF(map_decision.decision_inputs #>> '{mapping,target}', '')) AS request_mapping_target,
  (map_decision.id IS NOT NULL) AS request_mapping_applied,
  mat.action_id AS materialization_action_id,
  mat.operation AS materialization_operation,
  rcp.id AS recipient_id,
  rcp.name AS recipient_label,
  rcp.external_id AS recipient_external_id,
  dest.id AS destination_address_id,
  dest.city AS destination_city,
  dest.validation_status AS destination_validation_status
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
  SELECT COALESCE(
    ar.policy->'request_mapping',
    ar.policy #> '{mapping_studio,request_mapping}',
    ar.policy #> '{mapping_studio,request_config,request_mapping}',
    '{}'::jsonb
  ) AS policy
) req_map ON TRUE
LEFT JOIN LATERAL (
  SELECT
    dl.id,
    dl.decision_inputs
  FROM public.decision_log dl
  WHERE dl.resource_type = 'api_gateway_request'
    AND dl.resource_id = agr.id
    AND dl.decision_point = 'api_gateway_request_mapping'
    AND dl.decision_outcome = 'applied'
  ORDER BY dl."timestamp" DESC
  LIMIT 1
) map_decision ON TRUE
LEFT JOIN LATERAL (
  SELECT
    dl.id,
    dl.decision_reason
  FROM public.decision_log dl
  WHERE dl.resource_type = 'api_gateway_request'
    AND dl.resource_id = agr.id
    AND dl.decision_point = 'api_gateway_source_sender_client_checked'
    AND dl.decision_outcome = 'rejected'
  ORDER BY dl."timestamp" DESC
  LIMIT 1
) rej ON TRUE
LEFT JOIN LATERAL (
  SELECT
    s.id AS shipment_id,
    s.client_id,
    s.tracking_number,
    s.status AS shipment_status,
    s.recipient_id,
    s.destination_address_id
  FROM public.shipments s
  WHERE s.organization_id = agr.organization_id
    AND (
      s.metadata #>> '{source,api_gateway_request_id}' = agr.id::text
      OR EXISTS (
        SELECT 1
        FROM public.shipment_actions sa
        WHERE sa.shipment_id = s.id
          AND sa.organization_id = agr.organization_id
          AND sa.action_data->>'api_gateway_request_id' = agr.id::text
          AND (
            sa.action_type = 'api_gateway_materialized'
            OR (
              sa.action_type IN ('address_update', 'status_change')
              AND sa.performed_by_system IN (
                'workflow_handlers.process_api_gateway_shipment_update_v1',
                'workflow_handlers.process_api_gateway_outbound_response_v1'
              )
            )
          )
      )
    )
  ORDER BY
    CASE
      WHEN s.metadata #>> '{source,api_gateway_request_id}' = agr.id::text THEN 0
      ELSE 1
    END,
    s.created_at DESC
  LIMIT 1
) shp ON TRUE
LEFT JOIN LATERAL (
  SELECT
    sa.id AS action_id,
    COALESCE(
      NULLIF(sa.action_data->>'operation', ''),
      CASE
        WHEN sa.action_type = 'address_update' THEN 'updated'
        WHEN sa.action_type = 'status_change' AND lower(COALESCE(sa.canonical_status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
        WHEN sa.action_type = 'status_change' THEN 'status_changed'
        ELSE NULLIF(sa.action_type, '')
      END
    ) AS operation
  FROM public.shipment_actions sa
  WHERE sa.organization_id = agr.organization_id
    AND sa.action_data->>'api_gateway_request_id' = agr.id::text
    AND (
      sa.action_type = 'api_gateway_materialized'
      OR (
        sa.action_type IN ('address_update', 'status_change')
        AND sa.performed_by_system IN (
          'workflow_handlers.process_api_gateway_shipment_update_v1',
          'workflow_handlers.process_api_gateway_outbound_response_v1'
        )
      )
    )
  ORDER BY
    CASE sa.action_type
      WHEN 'api_gateway_materialized' THEN 0
      WHEN 'address_update' THEN 1
      WHEN 'status_change' THEN 2
      ELSE 3
    END,
    sa."timestamp" DESC,
    sa.created_at DESC
  LIMIT 1
) mat ON TRUE
LEFT JOIN public.recipients rcp
  ON rcp.id = shp.recipient_id
 AND rcp.client_id = shp.client_id
LEFT JOIN public.addresses dest
  ON dest.id = shp.destination_address_id
 AND dest.client_id = shp.client_id;

COMMENT ON VIEW public.v_api_gateway_request_directory IS
  'Console V2 request-first API gateway intake projection. Starts from api_gateway_requests so failed pre-dispatch intake remains visible; linked canonical shipments project as shipment_materialized while provider failures and source-binding rejections remain visible as diagnostics. Shipment handoff resolves from direct shipment metadata or append-only API Gateway shipment action lineage, including create materialization plus update/delete provider-success actions. Request mapping, idempotency/replay, materialization action, recipient, and destination readback remain visible in the same Console request context.';

REVOKE ALL ON public.v_api_gateway_request_directory FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_request_directory FROM anon;
REVOKE ALL ON public.v_api_gateway_request_directory FROM authenticated;
GRANT SELECT ON public.v_api_gateway_request_directory TO service_role;

COMMIT;
