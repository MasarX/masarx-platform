-- API Gateway replay lineage is internal Console/operator metadata.
-- Persist it on request readback, but never forward it to provider egress.

SELECT pg_advisory_lock(hashtext('202605232020_api_gateway_replay_header_sanitization_v1'));

CREATE OR REPLACE FUNCTION public.api_gateway_sanitize_outbound_headers_v1(p_headers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
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
      'x-masarx-replay-of',
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
      'user-agent',
      'traceparent',
      'tracestate',
      'baggage',
      'sentry-trace',
      'x-correlation-id',
      'x-request-id',
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
$function$;

COMMENT ON FUNCTION public.api_gateway_sanitize_outbound_headers_v1(jsonb)
  IS 'Sanitizes provider-bound API Gateway headers by stripping auth, browser/proxy/runtime, internal tracing, and replay-lineage headers before egress policy checks.';

SELECT pg_advisory_unlock(hashtext('202605232020_api_gateway_replay_header_sanitization_v1'));
