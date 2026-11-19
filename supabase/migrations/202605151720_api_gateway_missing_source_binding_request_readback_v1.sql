-- Console V2 API Gateway missing sender/client binding readback.
-- Shipment-create API sources should still fail closed, but the rejected
-- inbound request must be visible to operators in the API request intake view.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605151720_api_gateway_missing_source_binding_request_readback_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def text;
  v_from text;
  v_to text;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found';
  END IF;

  IF position('api_gateway_source_missing_sender_client_request_logged_v1' IN v_def) > 0 THEN
    RAISE NOTICE 'workflow_intake_api_gateway_v1 already logs missing sender/client rejected requests';
  ELSE
    v_from := $from$    IF COALESCE(v_source_binding_ok, FALSE) IS FALSE THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'settings_resolution',
        p_resource_type := 'webhook_source',
        p_resource_id := v_source.id,$from$;

    v_to := $to$    IF COALESCE(v_source_binding_ok, FALSE) IS FALSE THEN
      -- api_gateway_source_missing_sender_client_request_logged_v1
      -- Preserve a redacted inbound request row even when the shipment-create
      -- source binding guard fails. Operators need request/readback evidence;
      -- outbound dispatch and shipment materialization still fail closed.
      v_safe_headers := public.redact_sensitive_headers(v_headers) - 'x-webhook-token' - 'x-internal-edge-token';
      v_safe_headers := public.redact_api_gateway_header_token_paths_v1(v_safe_headers);
      v_safe_body := COALESCE(v_body, '{}'::jsonb);
      IF v_auth_fields IS NOT NULL AND jsonb_typeof(v_auth_fields) = 'object' THEN
        SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
          INTO v_safe_body
          FROM jsonb_each(v_safe_body)
         WHERE key NOT IN (SELECT key FROM jsonb_each_text(v_auth_fields));
      END IF;
      v_safe_body := public.redact_sensitive_json(COALESCE(v_safe_body, '{}'::jsonb));

      INSERT INTO public.api_gateway_requests (
        organization_id,
        client_id,
        sender_id,
        source_id,
        correlation_id,
        route_id,
        settings_resolution_id,
        method,
        path,
        query_string,
        request_headers,
        request_body,
        received_at,
        created_at,
        updated_at
      )
      VALUES (
        v_org,
        v_client,
        v_sender,
        v_source.id,
        v_corr,
        v_route_id,
        NULL,
        v_method,
        v_path,
        NULLIF(v_query, ''),
        COALESCE(v_safe_headers, '{}'::jsonb),
        COALESCE(v_safe_body, '{}'::jsonb),
        v_now,
        v_now,
        v_now
      )
      RETURNING id INTO v_request_id;

      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'settings_resolution',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request_id,$to$;

    IF position(v_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'missing sender/client guard marker not found in workflow_intake_api_gateway_v1';
    END IF;

    v_def := replace(v_def, v_from, v_to);
    v_def := replace(
      v_def,
      $from$          'source_id', v_source.id,
          'sender_id', v_sender,$from$,
      $to$          'source_id', v_source.id,
          'api_gateway_request_id', v_request_id,
          'sender_id', v_sender,$to$
    );
    v_def := replace(
      v_def,
      $from$          'error', 'api_gateway_source_missing_sender_client',
          'source_identifier', v_source.source_identifier$from$,
      $to$          'error', 'api_gateway_source_missing_sender_client',
          'api_gateway_request_id', v_request_id,
          'source_identifier', v_source.source_identifier$to$
    );

    EXECUTE v_def;
  END IF;
END;
$patch$;

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
  COALESCE(NULLIF(oc.error_message, ''), rej.decision_reason) AS outbound_error_message
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
  'Console V2 request-first API gateway intake projection. Starts from api_gateway_requests so failed pre-dispatch intake remains visible; linked canonical shipments project as shipment_materialized while provider failures and source-binding rejections remain visible as diagnostics. Shipment handoff resolves from direct shipment metadata or append-only api_gateway_materialized shipment_actions lineage so duplicate/replay requests keep stable shipment context.';

REVOKE ALL ON public.v_api_gateway_request_directory FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_request_directory FROM anon;
REVOKE ALL ON public.v_api_gateway_request_directory FROM authenticated;
GRANT SELECT ON public.v_api_gateway_request_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605151720_api_gateway_missing_source_binding_request_readback_v1'));
COMMIT;
