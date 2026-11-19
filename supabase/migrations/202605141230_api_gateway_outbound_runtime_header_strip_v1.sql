-- API gateway outbound runtime header strip hardening.
--
-- Provider calls must not inherit Supabase/browser/API-gateway runtime headers
-- from inbound requests. Route policy may still add intentional provider
-- headers after this sanitizer runs.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605141230_api_gateway_outbound_runtime_header_strip_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
      'accept-encoding',
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
  'Filters inbound API gateway headers before provider dispatch so Supabase runtime, idempotency, hop-by-hop, edge-forwarded, browser-only, and gateway auth headers are never sent upstream.';

UPDATE public.outbound_calls
   SET headers = public.api_gateway_sanitize_outbound_headers_v1(headers),
       updated_at = now()
 WHERE call_type = 'provider_api'
   AND context ? 'api_gateway_request_id'
   AND EXISTS (
     SELECT 1
       FROM jsonb_object_keys(COALESCE(headers, '{}'::jsonb)) AS header_name
      WHERE lower(header_name) IN (
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
        'accept-encoding',
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
      )
   );

SELECT pg_advisory_unlock(hashtext('202605141230_api_gateway_outbound_runtime_header_strip_v1'));

COMMIT;
