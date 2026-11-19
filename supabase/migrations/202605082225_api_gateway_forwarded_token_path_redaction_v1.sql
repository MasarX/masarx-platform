-- API gateway forwarded-path token redaction.
--
-- Path-token auth is supported for provider compatibility, but edge proxies can
-- echo the full URL into forwarded headers. Those headers are useful for
-- debugging, but token material must never persist into request logs, outbound
-- call specs, workflow context, or Console V2 drawers.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605082225_api_gateway_forwarded_token_path_redaction_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.redact_api_gateway_header_token_paths_v1(p_headers jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      key,
      CASE
        WHEN jsonb_typeof(value) = 'string' THEN to_jsonb(
          regexp_replace(
            regexp_replace(
              value #>> '{}',
              '(/api-gateway/t/)[^/?#]+',
              '\1[redacted]',
              'gi'
            ),
            '([?&]token=)[^&#]+',
            '\1[redacted]',
            'gi'
          )
        )
        ELSE value
      END
    ),
    '{}'::jsonb
  )
  FROM jsonb_each(COALESCE(p_headers, '{}'::jsonb));
$$;

COMMENT ON FUNCTION public.redact_api_gateway_header_token_paths_v1(jsonb)
  IS 'Redacts api-gateway path-token/EXAMPLE_PASSWORD material from proxy-forwarded request headers before request logs are persisted or rendered.';

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

  IF position('redact_api_gateway_header_token_paths_v1(v_safe_headers)' in v_definition) = 0 THEN
    v_next := replace(
      v_definition,
      $$v_safe_headers := public.redact_sensitive_headers(v_headers) - 'x-webhook-token' - 'x-internal-edge-token';$$,
      $$v_safe_headers := public.redact_sensitive_headers(v_headers) - 'x-webhook-token' - 'x-internal-edge-token';
  v_safe_headers := public.redact_api_gateway_header_token_paths_v1(v_safe_headers);$$
    );

    IF v_next = v_definition THEN
      RAISE EXCEPTION 'Expected safe-header assignment was not found in workflow_intake_api_gateway_v1';
    END IF;

    EXECUTE v_next;
  END IF;

  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_definition;

  IF position('redact_api_gateway_header_token_paths_v1(v_outbound_headers)' in v_definition) = 0 THEN
    v_next := replace(
      v_definition,
      $$  -- Optional workflow mode branch (route.policy.workflow.enabled):
  v_workflow := COALESCE(v_policy->'workflow', '{}'::jsonb);$$,
      $$  v_outbound_headers := public.redact_api_gateway_header_token_paths_v1(v_outbound_headers);

  -- Optional workflow mode branch (route.policy.workflow.enabled):
  v_workflow := COALESCE(v_policy->'workflow', '{}'::jsonb);$$
    );

    IF v_next = v_definition THEN
      RAISE EXCEPTION 'Expected outbound-header workflow branch marker was not found in workflow_intake_api_gateway_v1';
    END IF;

    EXECUTE v_next;
  END IF;
END;
$patch$;

UPDATE public.outbound_calls
SET headers = public.redact_api_gateway_header_token_paths_v1(headers),
    updated_at = now()
WHERE headers::text ~* '/api-gateway/t/|[?&]token=';

UPDATE public.workflow_runs
SET context = jsonb_set(
      context,
      '{api_gateway,outbound_headers}',
      public.redact_api_gateway_header_token_paths_v1(context #> '{api_gateway,outbound_headers}'),
      true
    ),
    updated_at = now()
WHERE context #> '{api_gateway,outbound_headers}' IS NOT NULL
  AND (context #> '{api_gateway,outbound_headers}')::text ~* '/api-gateway/t/|[?&]token=';

SELECT pg_advisory_unlock(hashtext('202605082225_api_gateway_forwarded_token_path_redaction_v1'));

COMMIT;
