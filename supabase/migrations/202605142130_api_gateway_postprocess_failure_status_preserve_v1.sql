-- Preserve API Gateway postprocess terminal validation failures after upstream
-- HTTP success. Shipment-create postprocess can fail closed after a provider
-- returns 2xx; the generic response store must not overwrite that operator
-- visible validation failure with the provider status.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605142130_api_gateway_postprocess_failure_status_preserve_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.orchestrate_api_response_processing(
    p_job_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_job_after public.outbound_calls%ROWTYPE;
    v_status_code INT;
    v_response JSONB;
    v_processed JSONB;
    v_success BOOLEAN;
    v_handled BOOLEAN;
    v_terminal_postprocess_failure BOOLEAN;
BEGIN
    SELECT *
    INTO v_job
    FROM public.outbound_calls
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'orchestrate_api_response_processing: outbound job % not found', p_job_id;
    END IF;

    v_status_code := COALESCE(v_job.response_status_code, 0);
    v_response := COALESCE(v_job.response_body, '{}'::jsonb);

    v_processed := workflow_handlers.process_outbound_response_v1(v_job, v_response);
    v_handled := COALESCE((v_processed->>'handled')::BOOLEAN, FALSE);

    SELECT *
    INTO v_job_after
    FROM public.outbound_calls
    WHERE id = p_job_id;

    v_terminal_postprocess_failure :=
        v_handled
        AND COALESCE(v_processed #>> '{postprocess,status}', '') = 'failed'
        AND COALESCE(v_job_after.status, '') = 'permanently_failed';

    IF v_handled AND NOT v_terminal_postprocess_failure THEN
        PERFORM public.store_response(p_job_id, v_response, v_status_code);

        SELECT *
        INTO v_job_after
        FROM public.outbound_calls
        WHERE id = p_job_id;
    END IF;

    v_status_code := COALESCE(v_job_after.response_status_code, v_status_code, 0);
    v_success := (v_status_code BETWEEN 200 AND 299)
                 AND COALESCE(v_job_after.status, '') <> 'permanently_failed';

    RETURN jsonb_build_object(
        'status', CASE WHEN v_success THEN 'success' ELSE 'error' END,
        'job_id', p_job_id,
        'status_code', v_status_code,
        'processed_metadata', v_processed
    );
END;
$$;

COMMENT ON FUNCTION public.orchestrate_api_response_processing(UUID)
  IS 'Entry point invoked after outbound HTTP execution; delegates to workflow handlers and preserves terminal postprocess validation failures instead of masking them with upstream 2xx status.';

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
    AND s.metadata #>> '{source,api_gateway_request_id}' = agr.id::text
  ORDER BY s.created_at DESC
  LIMIT 1
) shp ON TRUE;

COMMENT ON VIEW public.v_api_gateway_request_directory IS
  'Console V2 request-first API gateway intake projection. Starts from api_gateway_requests so failed pre-dispatch intake remains visible; linked canonical shipments project as shipment_materialized while provider failures remain visible as diagnostics, including outbound_error_message for operator-readable terminal failure detail. SSOT remains api_gateway_requests, api_routes, webhook_sources, clients, senders, outbound_calls, and shipment metadata linkage.';

REVOKE ALL ON public.v_api_gateway_request_directory FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_request_directory FROM anon;
REVOKE ALL ON public.v_api_gateway_request_directory FROM authenticated;
GRANT SELECT ON public.v_api_gateway_request_directory TO service_role;

WITH applied AS (
  UPDATE public.settings_versions sv
     SET value = jsonb_set(
           sv.value,
           '{resources}',
           COALESCE(
             (
               SELECT jsonb_agg(
                 CASE
                   WHEN resource->>'key' = 'api_gateway_requests'
                     AND NOT COALESCE(resource->'select', '[]'::jsonb) ? 'outbound_error_message'
                     THEN jsonb_set(
                       resource,
                       '{select}',
                       COALESCE(resource->'select', '[]'::jsonb) || jsonb_build_array('outbound_error_message'),
                       true
                     )
                   ELSE resource
                 END
                 ORDER BY ord
               )
               FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) WITH ORDINALITY AS item(resource, ord)
             ),
             '[]'::jsonb
           ),
           true
         ),
         version = sv.version + 1,
         change_reason = 'Expose API Gateway outbound terminal error detail for Console V2',
         approved_at = now(),
         effective_from = now()
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.settings_version_id = sv.id
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource(entry)
        WHERE resource.entry->>'key' = 'api_gateway_requests'
          AND NOT COALESCE(resource.entry->'select', '[]'::jsonb) ? 'outbound_error_message'
     )
   RETURNING sv.id, sv.value
)
UPDATE public.settings s
   SET cached_value = applied.value,
       last_updated = now()
  FROM applied
 WHERE s.category = 'ui_read_registry'
   AND s.settings_version_id = applied.id;

SELECT pg_advisory_unlock(hashtext('202605142130_api_gateway_postprocess_failure_status_preserve_v1'));
COMMIT;
