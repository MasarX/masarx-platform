-- API gateway outbound header sanitization.
--
-- Provider dispatch must not inherit edge/browser hop-by-hop headers from the
-- inbound gateway request. In HTTP/2 those headers are invalid and can fail at
-- the transport layer before the provider returns an application response.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605090010_api_gateway_outbound_header_sanitization_v1'));

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
  'Filters inbound API gateway headers before provider dispatch so hop-by-hop, edge-forwarded, browser-only, and gateway auth headers are never sent upstream.';

UPDATE public.settings_versions sv
   SET value = jsonb_set(
                 COALESCE(sv.value, '{}'::jsonb),
                 '{policy,header_allowlist}',
                 public.jsonb_text_array_union_v1(
                   COALESCE(sv.value #> '{policy,header_allowlist}', '[]'::jsonb),
                   '["company-id","x-correlation-id","traceparent","tracestate"]'::jsonb
                 ),
                 TRUE
               ),
       version = sv.version + 1,
       change_reason = 'Allow canonical provider and trace headers after API gateway outbound header sanitization',
       approved_at = now(),
       effective_from = now(),
       updated_at = now()
 WHERE sv.category = 'outbound_egress_policy'
   AND public.jsonb_text_array_union_v1(
         COALESCE(sv.value #> '{policy,header_allowlist}', '[]'::jsonb),
         '["company-id","x-correlation-id","traceparent","tracestate"]'::jsonb
       ) IS DISTINCT FROM COALESCE(sv.value #> '{policy,header_allowlist}', '[]'::jsonb);

UPDATE public.settings s
   SET cached_value = sv.value,
       last_updated = now()
  FROM public.settings_versions sv
 WHERE s.settings_version_id = sv.id
   AND s.category = 'outbound_egress_policy'
   AND s.cached_value IS DISTINCT FROM sv.value;

CREATE SCHEMA IF NOT EXISTS api;

CREATE OR REPLACE FUNCTION api.resolve_effective_outbound_egress_policy_v1(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, api, extensions, pg_temp
AS $$
  SELECT public.resolve_effective_outbound_egress_policy_v1(p_job_id);
$$;

REVOKE ALL ON FUNCTION api.resolve_effective_outbound_egress_policy_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_effective_outbound_egress_policy_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_effective_outbound_egress_policy_v1(uuid) TO service_role;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA api TO edge_api_caller_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION api.resolve_effective_outbound_egress_policy_v1(uuid) TO edge_api_caller_role';
  END IF;
END;
$grant$;

DO $patch$
DECLARE
  v_definition text;
  v_new_definition text;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found';
  END IF;

  v_new_definition := replace(
    v_definition,
    $$v_outbound_headers := COALESCE(v_headers, '{}'::jsonb)
    - 'authorization'
    - 'proxy-authorization'
    - 'x-webhook-token'
    - 'x-internal-edge-token';$$,
    $$v_outbound_headers := public.api_gateway_sanitize_outbound_headers_v1(v_headers);$$
  );

  v_new_definition := replace(
    v_new_definition,
    $$  v_outbound_headers := public.redact_api_gateway_header_token_paths_v1(v_outbound_headers);$$,
    $$  v_outbound_headers := public.redact_api_gateway_header_token_paths_v1(v_outbound_headers);
  v_outbound_headers := public.api_gateway_sanitize_outbound_headers_v1(v_outbound_headers);$$
  );

  IF v_new_definition = v_definition THEN
    IF position('api_gateway_sanitize_outbound_headers_v1(v_headers)' IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Expected outbound header assignment was not found in workflow_intake_api_gateway_v1';
    END IF;
  ELSE
    EXECUTE v_new_definition;
  END IF;
END;
$patch$;

SELECT pg_advisory_unlock(hashtext('202605090010_api_gateway_outbound_header_sanitization_v1'));

COMMIT;
