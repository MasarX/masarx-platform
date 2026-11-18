-- Console V2 first-tenant readiness: shipment-creating API Gateway intake
-- should produce route-planning-ready shipments when the inbound/provider
-- payload carries a promised date and the source can resolve a default service
-- offering from row-owned tenant configuration.

SELECT pg_advisory_lock(hashtext('202605150110_api_gateway_route_planning_defaults_v1'));

UPDATE public.api_routes
   SET policy = jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      COALESCE(policy, '{}'::jsonb),
                      '{postprocess,extract,promised_delivery_date_path}',
                      to_jsonb('expected_delivery_date|expectedDeliveryDate|promised_delivery_date'::text),
                      true
                    ),
                    '{postprocess,extract,service_level_path}',
                    to_jsonb('service_level|service.level'::text),
                    true
                  ),
                '{postprocess,extract,client_reference_path}',
                to_jsonb('client_reference_number|external_reference|reference'::text),
                true
                ),
       updated_at = now()
 WHERE COALESCE(policy #>> '{postprocess,mode}', '') = 'shipment_create_v1'
   AND (
     policy #>> '{postprocess,extract,promised_delivery_date_path}' IS NULL
     OR policy #>> '{postprocess,extract,service_level_path}' IS NULL
     OR policy #>> '{postprocess,extract,client_reference_path}' IS NULL
     OR policy #>> '{postprocess,extract,client_reference_path}' = 'client_reference_number'
   );

WITH active_standard_offerings AS (
  SELECT
    sl.organization_id,
    so.id AS service_offering_id,
    count(*) OVER (PARTITION BY sl.organization_id) AS offering_count
  FROM public.service_offerings so
  JOIN public.service_levels sl
    ON sl.id = so.service_level_id
  JOIN public.branches b
    ON b.id = so.branch_id
  WHERE lower(sl.key) = 'standard'
    AND so.is_active IS TRUE
    AND sl.is_active IS TRUE
    AND b.is_active IS TRUE
    AND now() >= so.effective_from
    AND (so.effective_to IS NULL OR now() < so.effective_to)
    AND lower(COALESCE(sl.metadata->'display'->>'status', 'active')) NOT IN ('archived', 'draft')
    AND lower(COALESCE(so.metadata->'display'->>'status', 'active')) NOT IN ('archived', 'draft')
),
unique_standard_offerings AS (
  SELECT organization_id, service_offering_id
    FROM active_standard_offerings
   WHERE offering_count = 1
)
UPDATE public.webhook_sources ws
   SET managed_metadata = COALESCE(ws.managed_metadata, '{}'::jsonb)
                          || jsonb_build_object(
                            'defaults',
                            COALESCE(ws.managed_metadata->'defaults', '{}'::jsonb)
                            || jsonb_build_object(
                              'service_offering_id',
                              uso.service_offering_id::text
                            )
                          ),
       updated_at = now()
  FROM unique_standard_offerings uso
 WHERE ws.organization_id = uso.organization_id
   AND ws.sender_id IS NOT NULL
   AND ws.enabled IS TRUE
   AND NULLIF(ws.managed_metadata #>> '{defaults,service_offering_id}', '') IS NULL
   AND (
     ws.source_identifier ILIKE 'api-gateway%'
     OR ws.name ILIKE '%api gateway%'
  );

DO $patch$
DECLARE
  v_def text;
  v_next text;
  v_old text := E'  BEGIN\n    v_promised_delivery_date := (workflow_handlers.resolve_path_text(p_response, v_extract->>''promised_delivery_date_path''))::timestamptz::date;\n  EXCEPTION\n    WHEN others THEN\n      BEGIN\n        v_promised_delivery_date := (workflow_handlers.resolve_path_text(p_response, v_extract->>''promised_delivery_date_path''))::date;\n      EXCEPTION\n        WHEN others THEN\n          v_promised_delivery_date := NULL;\n      END;\n  END;';
  v_new text := E'  BEGIN\n    v_promised_delivery_date := COALESCE(\n      NULLIF(workflow_handlers.resolve_path_text(p_response, v_extract->>''promised_delivery_date_path''), ''''),\n      NULLIF(workflow_handlers.resolve_path_text(v_request_body, v_extract->>''promised_delivery_date_path''), '''')\n    )::timestamptz::date;\n  EXCEPTION\n    WHEN others THEN\n      BEGIN\n        v_promised_delivery_date := COALESCE(\n          NULLIF(workflow_handlers.resolve_path_text(p_response, v_extract->>''promised_delivery_date_path''), ''''),\n          NULLIF(workflow_handlers.resolve_path_text(v_request_body, v_extract->>''promised_delivery_date_path''), '''')\n        )::date;\n      EXCEPTION\n        WHEN others THEN\n          v_promised_delivery_date := NULL;\n      END;\n  END;';
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_shipment_create_v1(public.outbound_calls,jsonb,public.api_gateway_requests,public.api_routes)'::regprocedure
  )
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 definition not found';
  END IF;

  IF position('workflow_handlers.resolve_path_text(v_request_body, v_extract->>''promised_delivery_date_path'')' in v_def) = 0 THEN
    IF position(v_old in v_def) = 0 THEN
      RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 promised date block not found';
    END IF;
    v_def := replace(v_def, v_old, v_new);
    EXECUTE v_def;
  END IF;

  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_shipment_create_v1(public.outbound_calls,jsonb,public.api_gateway_requests,public.api_routes)'::regprocedure
  )
    INTO v_next;

  IF position('workflow_handlers.resolve_path_text(v_request_body, v_extract->>''promised_delivery_date_path'')' in v_next) = 0 THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 promised date request-body fallback verification failed';
  END IF;
END;
$patch$;

COMMENT ON FUNCTION public.resolve_api_gateway_shipment_service_offering_v1(
  uuid, uuid, text, jsonb, jsonb, jsonb
) IS
  'Resolves API Gateway shipment-create service offering from route/source/policy rows. Console V2 first-tenant API sources may set webhook_sources.managed_metadata.defaults.service_offering_id; shipment-create routes should expose promised_delivery_date_path, client_reference_path, and service_level_path in postprocess.extract so route-plan handoff can become eligible without app-side defaults.';

COMMENT ON FUNCTION workflow_handlers.process_api_gateway_shipment_create_v1(
  public.outbound_calls,
  jsonb,
  public.api_gateway_requests,
  public.api_routes
) IS
  'API Gateway shipment-create postprocessor. Materializes canonical shipment readback, resolves promised delivery date from provider response or original request payload, and projects service-offering planning fields for Console V2 route-plan handoff.';

CREATE OR REPLACE FUNCTION public.api_gateway_sanitize_outbound_headers_v1(p_headers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_out jsonb := '{}'::jsonb;
  v_entry record;
  v_key text;
  v_value text;
BEGIN
  FOR v_entry IN
    SELECT key, value
      FROM jsonb_each_text(COALESCE(p_headers, '{}'::jsonb))
  LOOP
    v_key := lower(btrim(v_entry.key));
    v_value := v_entry.value;

    IF v_key IS NULL OR v_key = '' THEN
      CONTINUE;
    END IF;

    IF v_key IN (
      'authorization',
      'proxy-authorization',
      'apikey',
      'x-api-key',
      'x-client-info',
      'idempotency-key',
      'x-idempotency-key',
      'x-webhook-token',
      'x-internal-edge-token',
      'connection',
      'content-length',
      'host',
      'keep-alive',
      'proxy-authenticate',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'accept',
      'accept-encoding',
      'accept-language',
      'origin',
      'referer',
      'baggage',
      'sentry-trace',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'sec-fetch-user',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-path',
      'x-forwarded-port',
      'x-forwarded-prefix',
      'x-forwarded-proto',
      'x-original-uri',
      'x-real-ip',
      'x-rewrite-url',
      'x-envoy-original-path'
    ) THEN
      CONTINUE;
    END IF;

    IF v_value IS NULL OR btrim(v_value) = '' THEN
      CONTINUE;
    END IF;

    v_out := jsonb_set(v_out, ARRAY[v_key], to_jsonb(v_value), TRUE);
  END LOOP;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.api_gateway_sanitize_outbound_headers_v1(jsonb) IS
  'Filters inbound API gateway headers before provider dispatch so Supabase runtime, idempotency, hop-by-hop, edge-forwarded, Sentry propagation, browser-origin, browser-client-hint, and gateway auth headers are never sent upstream.';

DO $patch$
DECLARE
  v_definition text;
  v_next text;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found';
  END IF;

  IF position('api_gateway_sanitize_outbound_headers_v1(v_headers)' IN v_definition) = 0 THEN
    IF position($$v_outbound_headers := COALESCE(v_headers, '{}'::jsonb)
    - 'authorization'
    - 'proxy-authorization'
    - 'x-webhook-token'
    - 'x-internal-edge-token';$$ IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Expected outbound header assignment was not found in workflow_intake_api_gateway_v1';
    END IF;

    v_definition := replace(
      v_definition,
      $$v_outbound_headers := COALESCE(v_headers, '{}'::jsonb)
    - 'authorization'
    - 'proxy-authorization'
    - 'x-webhook-token'
    - 'x-internal-edge-token';$$,
      $$v_outbound_headers := public.api_gateway_sanitize_outbound_headers_v1(v_headers);$$
    );

    EXECUTE v_definition;
  END IF;

  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_next;

  IF position('api_gateway_sanitize_outbound_headers_v1(v_headers)' IN v_next) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 outbound header sanitization verification failed';
  END IF;
END;
$patch$;

UPDATE public.outbound_calls
   SET headers = public.api_gateway_sanitize_outbound_headers_v1(headers),
       updated_at = now()
 WHERE call_type = 'provider_api'
   AND context ? 'api_gateway_request_id'
   AND EXISTS (
     SELECT 1
       FROM jsonb_object_keys(COALESCE(headers, '{}'::jsonb)) AS header_name
      WHERE lower(header_name) IN ('baggage', 'sentry-trace')
   );

SELECT pg_advisory_unlock(hashtext('202605150110_api_gateway_route_planning_defaults_v1'));
