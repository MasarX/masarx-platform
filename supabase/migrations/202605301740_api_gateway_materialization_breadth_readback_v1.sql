-- Migration: API Gateway materialization breadth readback
-- Purpose:
--   - Keep API Gateway shipment mutation routes workflow-engine-first for
--     reschedule as well as update/cancel.
--   - Expose request mapping, replay/idempotency, materialization action, and
--     recipient/address readback in the existing Console V2 request projection.

BEGIN;

SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_lock(hashtext('202605301740_api_gateway_materialization_breadth_readback_v1'));

CREATE OR REPLACE FUNCTION public.api_gateway_shipment_mutation_default_workflow_template_v1(p_intent TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT CASE
    WHEN lower(COALESCE(p_intent, '')) = 'shipment.delete'
      THEN 'api_gateway_shipment_cancel_default_v1'
    WHEN lower(COALESCE(p_intent, '')) = 'shipment.reschedule'
      THEN 'shipment_reschedule_v1'
    WHEN lower(COALESCE(p_intent, '')) IN (
      'shipment.update',
      'update.status',
      'update.address',
      'update.geocode',
      'update.driver',
      'update.action',
      'update.attachment'
    )
      THEN 'api_gateway_shipment_update_default_v1'
    ELSE NULL
  END;
$function$;

COMMENT ON FUNCTION public.api_gateway_shipment_mutation_default_workflow_template_v1(TEXT)
  IS 'Resolves API Gateway shipment mutation intents to canonical workflow templates for update, cancel/delete, and reschedule routes.';

CREATE OR REPLACE FUNCTION public.apply_api_gateway_shipment_mutation_workflow_defaults_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(NEW.policy, '{}'::jsonb);
  v_delivery JSONB := COALESCE(v_policy->'delivery', '{}'::jsonb);
  v_intent TEXT;
  v_template_name TEXT;
  v_workflow_enabled BOOLEAN;
BEGIN
  IF COALESCE(NEW.enabled, FALSE) IS NOT TRUE THEN
    NEW.policy := v_policy;
    RETURN NEW;
  END IF;

  v_intent := public.api_gateway_route_canonical_intent_v1(v_policy);
  v_template_name := public.api_gateway_shipment_mutation_default_workflow_template_v1(v_intent);

  IF v_template_name IS NULL THEN
    NEW.policy := v_policy;
    RETURN NEW;
  END IF;

  BEGIN
    v_workflow_enabled := COALESCE((v_policy #>> '{workflow,enabled}')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_workflow_enabled := FALSE;
  END;

  IF (v_policy ? 'workflow') IS FALSE THEN
    v_policy := jsonb_set(
      v_policy,
      '{workflow}',
      jsonb_build_object(
        'enabled', TRUE,
        'template_name', v_template_name
      ),
      TRUE
    );
  ELSE
    IF v_workflow_enabled IS NOT TRUE THEN
      RAISE EXCEPTION 'enabled shipment mutation API Gateway routes must use workflow.enabled=true'
        USING ERRCODE = '23514';
    END IF;

    IF NULLIF(v_policy #>> '{workflow,template_name}', '') IS NULL
       AND NULLIF(v_policy #>> '{workflow,template_id}', '') IS NULL THEN
      v_policy := jsonb_set(
        v_policy,
        '{workflow,template_name}',
        to_jsonb(v_template_name),
        TRUE
      );
    END IF;
  END IF;

  IF jsonb_typeof(v_delivery) <> 'object' THEN
    v_delivery := '{}'::jsonb;
  END IF;

  IF NULLIF(v_delivery->>'mode', '') IS NULL THEN
    v_delivery := jsonb_set(v_delivery, '{mode}', to_jsonb('accepted_async'::TEXT), TRUE);
  END IF;

  IF NULLIF(v_delivery->>'status_code', '') IS NULL THEN
    v_delivery := jsonb_set(v_delivery, '{status_code}', to_jsonb(202), TRUE);
  END IF;

  v_policy := jsonb_set(v_policy, '{delivery}', v_delivery, TRUE);

  NEW.policy := v_policy;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.apply_api_gateway_shipment_mutation_workflow_defaults_v1()
  IS 'Before-insert/update guard for API Gateway shipment mutation routes: mutation ingress is workflow-engine-first and accepted-async by default, including routes without an existing delivery object.';

UPDATE public.api_routes r
   SET policy = COALESCE(r.policy, '{}'::jsonb),
       updated_at = now()
 WHERE r.enabled = TRUE
   AND public.api_gateway_shipment_mutation_default_workflow_template_v1(
         public.api_gateway_route_canonical_intent_v1(COALESCE(r.policy, '{}'::jsonb))
       ) IS NOT NULL
   AND (
     (COALESCE(r.policy, '{}'::jsonb) ? 'workflow') IS FALSE
     OR (
       lower(COALESCE(r.policy #>> '{workflow,enabled}', 'false')) = 'true'
       AND NULLIF(r.policy #>> '{workflow,template_name}', '') IS NULL
       AND NULLIF(r.policy #>> '{workflow,template_id}', '') IS NULL
     )
   );

DO $patch_workflow_context$
DECLARE
  v_def TEXT;
  v_next TEXT;
  v_marker TEXT := E'        ''correlation_id'', v_corr,\n        ''api_gateway'', jsonb_strip_nulls(jsonb_build_object(';
  v_replacement TEXT := E'        ''correlation_id'', v_corr,\n        ''payload'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb),\n        ''transformed_payload'', CASE\n          WHEN COALESCE((v_request_mapping->>''mapped'')::BOOLEAN, FALSE)\n            THEN COALESCE(v_safe_outbound_body, ''{}''::jsonb)\n          ELSE NULL\n        END,\n        ''api_gateway'', jsonb_strip_nulls(jsonb_build_object(';
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found for API Gateway materialization payload context patch';
  END IF;

  IF position('''transformed_payload'', CASE' IN v_def) > 0
     AND position('COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb)' IN v_def) > 0 THEN
    RAISE NOTICE 'workflow_intake_api_gateway_v1 already exposes mapped API Gateway payload at workflow context root';
    RETURN;
  END IF;

  IF position(v_marker IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected workflow context correlation marker not found in workflow_intake_api_gateway_v1';
  END IF;

  v_next := replace(v_def, v_marker, v_replacement);

  EXECUTE v_next;

  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF position('''transformed_payload'', CASE' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 transformed payload context patch did not apply';
  END IF;
  IF position('''payload'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 payload context patch did not apply';
  END IF;
END;
$patch_workflow_context$;

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
) shp ON TRUE
LEFT JOIN LATERAL (
  SELECT
    sa.id AS action_id,
    NULLIF(sa.action_data->>'operation', '') AS operation
  FROM public.shipment_actions sa
  WHERE sa.organization_id = agr.organization_id
    AND sa.action_type = 'api_gateway_materialized'
    AND sa.action_data->>'api_gateway_request_id' = agr.id::text
  ORDER BY sa."timestamp" DESC, sa.created_at DESC
  LIMIT 1
) mat ON TRUE
LEFT JOIN public.recipients rcp
  ON rcp.id = shp.recipient_id
 AND rcp.client_id = shp.client_id
LEFT JOIN public.addresses dest
  ON dest.id = shp.destination_address_id
 AND dest.client_id = shp.client_id;

COMMENT ON VIEW public.v_api_gateway_request_directory IS
  'Console V2 request-first API gateway intake projection. Starts from api_gateway_requests so failed pre-dispatch intake remains visible; linked canonical shipments project as shipment_materialized while provider failures and source-binding rejections remain visible as diagnostics. Shipment handoff resolves from direct shipment metadata or append-only api_gateway_materialized shipment_actions lineage so duplicate/replay requests keep stable shipment context. Request mapping, idempotency/replay, materialization action, recipient, and destination readback remain visible in the same Console request context.';

REVOKE ALL ON public.v_api_gateway_request_directory FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_request_directory FROM anon;
REVOKE ALL ON public.v_api_gateway_request_directory FROM authenticated;
GRANT SELECT ON public.v_api_gateway_request_directory TO service_role;

WITH wanted(field) AS (
  VALUES
    ('idempotency_key'),
    ('replay_of_request_id'),
    ('mutation_intent'),
    ('request_mapping_config_id'),
    ('request_mapping_key'),
    ('request_mapping_type'),
    ('request_mapping_target'),
    ('request_mapping_applied'),
    ('materialization_action_id'),
    ('materialization_operation'),
    ('recipient_id'),
    ('recipient_label'),
    ('recipient_external_id'),
    ('destination_address_id'),
    ('destination_city'),
    ('destination_validation_status')
),
applied AS (
  UPDATE public.settings_versions sv
     SET value = jsonb_set(
           sv.value,
           '{resources}',
           COALESCE(
             (
               SELECT jsonb_agg(
                 CASE
                   WHEN resource->>'key' = 'api_gateway_requests'
                     THEN jsonb_set(
                       resource,
                       '{select}',
                       COALESCE(resource->'select', '[]'::jsonb) || COALESCE(
                         (
                           SELECT jsonb_agg(to_jsonb(wanted.field))
                           FROM wanted
                           WHERE NOT COALESCE(resource->'select', '[]'::jsonb) ? wanted.field
                         ),
                         '[]'::jsonb
                       ),
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
         change_reason = 'Expose API Gateway materialization breadth readback for Console V2',
         approved_at = now(),
         effective_from = now()
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.settings_version_id = sv.id
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource(entry)
        WHERE resource.entry->>'key' = 'api_gateway_requests'
          AND EXISTS (
            SELECT 1
              FROM wanted
             WHERE NOT COALESCE(resource.entry->'select', '[]'::jsonb) ? wanted.field
          )
     )
   RETURNING sv.id, sv.value
)
UPDATE public.settings s
   SET cached_value = applied.value,
       last_updated = now()
  FROM applied
 WHERE s.category = 'ui_read_registry'
   AND s.settings_version_id = applied.id;

SELECT pg_advisory_unlock(hashtext('202605301740_api_gateway_materialization_breadth_readback_v1'));

COMMIT;
