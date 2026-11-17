-- Keep executable API Gateway header hygiene total over legacy JSON shapes.
-- Historical backfills must fail closed instead of aborting on non-object rows.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202608161871_api_gateway_outbound_header_history_guard_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.api_gateway_sanitize_outbound_headers_v1(p_headers JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_headers IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_headers) <> 'object' THEN
    RETURN '"REDACTED"'::jsonb;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_object_agg(lower(btrim(entry.key)), entry.value), '{}'::jsonb)
    FROM jsonb_each_text(p_headers) entry
    WHERE NULLIF(btrim(entry.key), '') IS NOT NULL
      AND NULLIF(btrim(entry.value), '') IS NOT NULL
      AND lower(btrim(entry.key)) <> ALL (ARRAY[
        'authorization', 'proxy-authorization', 'apikey', 'x-api-key', 'x-client-info',
        'idempotency-key', 'x-idempotency-key', 'x-webhook-token', 'x-internal-edge-token',
        'x-masarx-replay-of', 'connection', 'content-length', 'host', 'keep-alive',
        'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade',
        'accept', 'accept-encoding', 'accept-language', 'origin', 'referer', 'user-agent',
        'traceparent', 'tracestate', 'baggage', 'sentry-trace', 'x-correlation-id',
        'x-request-id', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
        'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
        'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-path', 'x-forwarded-port',
        'x-forwarded-prefix', 'x-forwarded-proto', 'x-forwarded-url', 'x-original-uri',
        'x-real-ip', 'x-rewrite-url', 'x-envoy-original-path'
      ]::TEXT[])
  );
END;
$function$;

COMMENT ON FUNCTION public.api_gateway_sanitize_outbound_headers_v1(JSONB) IS
  'Strips unsafe provider egress headers, preserves SQL NULL, and fails closed for malformed historical JSON shapes.';

COMMIT;
