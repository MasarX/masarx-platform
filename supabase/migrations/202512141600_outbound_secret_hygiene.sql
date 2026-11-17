-- Migration: Outbound secret hygiene + auth injection + redacted API logs
-- Purpose:
--   - Ensure no secrets are stored in operation_templates, outbound_calls, or api_call_log.
--   - Inject provider auth (headers/query params) at dispatch time via get_job_call_spec().
--   - Redact sensitive values in api_call_log (headers/body/url) as defense-in-depth.
--   - Remove API key query params from geocoding outbound URLs (inject at dispatch instead).
-- Date: 2025-12-14

BEGIN;

-------------------------------------------------------------------------------
-- Redaction helpers (defense in depth)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.redact_sensitive_headers(p_headers JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_out JSONB := '{}'::jsonb;
  v_entry RECORD;
  v_key_lower TEXT;
BEGIN
  IF p_headers IS NULL OR jsonb_typeof(p_headers) <> 'object' THEN
    RETURN COALESCE(p_headers, '{}'::jsonb);
  END IF;

  FOR v_entry IN SELECT key, value FROM jsonb_each(p_headers) LOOP
    v_key_lower := lower(v_entry.key);
    IF v_key_lower IN (
      'authorization',
      'proxy-authorization',
      'd360-api-key',
      'x-api-key',
      'api-key',
      'apikey',
      'x-auth-token',
      'x-internal-edge-token',
      'cookie',
      'set-cookie'
    ) THEN
      v_out := v_out || jsonb_build_object(v_entry.key, 'REDACTED');
    ELSE
      v_out := v_out || jsonb_build_object(v_entry.key, v_entry.value);
    END IF;
  END LOOP;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.redact_sensitive_headers(JSONB)
  IS 'Redact sensitive HTTP headers (api keys, auth, cookies) for safe persistence/logging.';

CREATE OR REPLACE FUNCTION public.redact_sensitive_json(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_out JSONB;
  v_entry RECORD;
  v_key_lower TEXT;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_value) = 'object' THEN
    v_out := '{}'::jsonb;
    FOR v_entry IN SELECT key, value FROM jsonb_each(p_value) LOOP
      v_key_lower := lower(v_entry.key);
      IF v_key_lower IN (
        'api_key',
        'apikey',
        'password',
        'secret',
        'token',
        'access_token',
        'refresh_token',
        'signing_secret',
        'shared_secret'
      ) THEN
        v_out := v_out || jsonb_build_object(v_entry.key, 'REDACTED');
      ELSE
        v_out := v_out || jsonb_build_object(v_entry.key, public.redact_sensitive_json(v_entry.value));
      END IF;
    END LOOP;
    RETURN v_out;
  END IF;

  IF jsonb_typeof(p_value) = 'array' THEN
    v_out := '[]'::jsonb;
    FOR v_entry IN
      SELECT value, ordinality
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS arr(value, ordinality)
    LOOP
      v_out := v_out || jsonb_build_array(public.redact_sensitive_json(v_entry.value));
    END LOOP;
    RETURN v_out;
  END IF;

  RETURN p_value;
END;
$$;

COMMENT ON FUNCTION public.redact_sensitive_json(JSONB)
  IS 'Recursively redact sensitive JSON keys (api_key/password/token/etc) for safe persistence/logging.';

CREATE OR REPLACE FUNCTION public.redact_sensitive_url(p_url TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_url TEXT := COALESCE(p_url, '');
  v_base TEXT;
  v_query_and_frag TEXT;
  v_query TEXT;
  v_frag TEXT := '';
  v_pairs TEXT[];
  v_pair TEXT;
  v_key TEXT;
  v_val TEXT;
  v_out_pairs TEXT[] := ARRAY[]::TEXT[];
  v_key_lower TEXT;
BEGIN
  IF v_url = '' THEN
    RETURN p_url;
  END IF;
  IF position('?' IN v_url) = 0 THEN
    RETURN p_url;
  END IF;

  v_base := split_part(v_url, '?', 1);
  v_query_and_frag := substring(v_url from position('?' IN v_url) + 1);

  IF position('#' IN v_query_and_frag) > 0 THEN
    v_query := split_part(v_query_and_frag, '#', 1);
    v_frag := '#' || split_part(v_query_and_frag, '#', 2);
  ELSE
    v_query := v_query_and_frag;
  END IF;

  IF v_query IS NULL OR v_query = '' THEN
    RETURN v_base || v_frag;
  END IF;

  v_pairs := string_to_array(v_query, '&');
  FOREACH v_pair IN ARRAY v_pairs LOOP
    IF v_pair IS NULL OR v_pair = '' THEN
      CONTINUE;
    END IF;
    v_key := split_part(v_pair, '=', 1);
    v_val := CASE
      WHEN position('=' IN v_pair) > 0 THEN split_part(v_pair, '=', 2)
      ELSE NULL
    END;

    v_key_lower := lower(COALESCE(v_key, ''));
    IF v_key_lower IN (
      'apikey',
      'api_key',
      'key',
      'token',
      'access_token',
      'signature',
      'secret'
    ) THEN
      IF v_key IS NOT NULL AND v_key <> '' THEN
        v_out_pairs := v_out_pairs || (v_key || '=REDACTED');
      END IF;
    ELSE
      v_out_pairs := v_out_pairs || v_pair;
    END IF;
  END LOOP;

  IF array_length(v_out_pairs, 1) IS NULL THEN
    RETURN v_base || v_frag;
  END IF;

  RETURN v_base || '?' || array_to_string(v_out_pairs, '&') || v_frag;
END;
$$;

COMMENT ON FUNCTION public.redact_sensitive_url(TEXT)
  IS 'Redact sensitive query params (apiKey/token/etc) in URLs for safe persistence/logging.';

-------------------------------------------------------------------------------
-- API call logging: redact secrets before persisting api_call_log
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_api_call_event(
    p_job_id UUID,
    p_request JSONB,
    p_response JSONB,
    p_status INT,
    p_latency_ms INT,
    p_error TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_org UUID;
    v_provider UUID;
    v_operation TEXT;
    v_method TEXT;
    v_url TEXT;
    v_request_headers JSONB;
    v_request_body JSONB;
    v_response_headers JSONB;
    v_response_body JSONB;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    SELECT *
    INTO v_job
    FROM public.outbound_calls
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'log_api_call_event: job % not found', p_job_id;
    END IF;

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);
    IF v_job.target_type = 'provider' THEN
        v_provider := v_job.target_id;
    ELSE
        v_provider := NULL;
    END IF;

    v_operation := v_job.call_type;

    v_method := COALESCE(p_request->>'method', v_job.method, 'POST');
    v_url := COALESCE(p_request->>'url', v_job.url, '');

    v_request_headers := COALESCE(p_request->'headers', '{}'::jsonb);
    v_request_body := COALESCE(p_request->'body', '{}'::jsonb);

    v_response_headers := COALESCE(p_response->'headers', '{}'::jsonb);
    v_response_body := COALESCE(p_response->'body', '{}'::jsonb);

    -- Redact secrets before persisting.
    v_url := public.redact_sensitive_url(v_url);
    v_request_headers := public.redact_sensitive_headers(v_request_headers);
    v_request_body := public.redact_sensitive_json(v_request_body);
    v_response_headers := public.redact_sensitive_headers(v_response_headers);
    v_response_body := public.redact_sensitive_json(v_response_body);

    INSERT INTO public.api_call_log (
        organization_id,
        provider_id,
        operation,
        method,
        url,
        request_headers,
        request_body,
        response_status,
        response_headers,
        response_body,
        duration_ms,
        error_message
    )
    VALUES (
        v_org,
        v_provider,
        v_operation,
        v_method,
        v_url,
        v_request_headers,
        v_request_body,
        p_status,
        v_response_headers,
        v_response_body,
        p_latency_ms,
        p_error
    );
END;
$$;

-------------------------------------------------------------------------------
-- get_job_call_spec: inject auth at dispatch-time (no secrets stored in DB rows)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_job_call_spec(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_job RECORD;
    v_template RECORD;
    v_spec JSONB;

    v_provider_id UUID := NULL;
    v_operation_template_id UUID := NULL;
    v_auth JSONB := '{}'::jsonb;
    v_mode TEXT := NULL;
    v_auth_type TEXT := NULL;
    v_auth_config_id UUID := NULL;
    v_credentials JSONB := NULL;

    v_url TEXT;
    v_method TEXT;
    v_headers JSONB;
    v_body JSONB;

    v_header_name TEXT;
    v_query_param TEXT;
    v_credential_key TEXT;
    v_api_key TEXT;
    v_username TEXT;
    v_password TEXT;
    v_scheme TEXT;
    v_token TEXT;
BEGIN
    SELECT oc.*
    INTO v_job
    FROM public.outbound_calls oc
    WHERE oc.id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'get_job_call_spec: job % not found', p_job_id;
    END IF;

    IF v_job.target_type = 'provider' THEN
      v_provider_id := v_job.target_id;
    END IF;

    BEGIN
      v_operation_template_id := NULLIF(v_job.context->>'operation_template_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_operation_template_id := NULL;
    END;

    IF v_operation_template_id IS NOT NULL THEN
      SELECT *
      INTO v_template
      FROM public.operation_templates ot
      WHERE ot.id = v_operation_template_id
      LIMIT 1;
    END IF;

    IF v_job.url IS NOT NULL THEN
        v_url := v_job.url;
        v_method := v_job.method;
        v_headers := COALESCE(v_job.headers, '{}'::jsonb);
        v_body := COALESCE(v_job.body, '{}'::jsonb);
    ELSE
        SELECT ot.*
        INTO v_template
        FROM public.operation_templates ot
        WHERE ot.provider_id = v_job.target_id
          AND ot.operation_name = v_job.call_type
        LIMIT 1;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'get_job_call_spec: no operation template for job %', p_job_id;
        END IF;

        v_url := v_template.url_template;
        v_method := v_template.method;
        v_headers := COALESCE(v_template.headers_template, '{}'::jsonb);
        v_body := COALESCE(v_template.body_template, '{}'::jsonb);
    END IF;

    -- Auth config can come from job context (direct jobs) or operation template metadata.
    v_auth := COALESCE(
      v_job.context->'auth',
      v_template.metadata->'auth',
      '{}'::jsonb
    );

    v_mode := NULLIF(v_auth->>'mode', '');
    v_auth_type := NULLIF(v_auth->>'auth_type', '');

    -- Optionally select an auth_config_id (explicit or inferred by provider+auth_type).
    BEGIN
      v_auth_config_id := NULLIF(COALESCE(v_auth->>'auth_config_id', v_job.context->>'auth_config_id'), '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_auth_config_id := NULL;
    END;

    IF v_auth_config_id IS NULL AND v_provider_id IS NOT NULL AND v_auth_type IS NOT NULL THEN
      SELECT id
        INTO v_auth_config_id
        FROM public.provider_auth_configs
       WHERE provider_id = v_provider_id
         AND auth_type = v_auth_type
       ORDER BY created_at DESC
       LIMIT 1;
    END IF;

    IF v_mode IS NOT NULL THEN
      IF v_auth_config_id IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: auth_config_missing (mode=% job_id=%)', v_mode, p_job_id;
      END IF;

      SELECT credentials
        INTO v_credentials
        FROM public.provider_auth_configs
       WHERE id = v_auth_config_id;

      IF v_credentials IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: credentials_missing (auth_config_id=% job_id=%)', v_auth_config_id, p_job_id;
      END IF;
    END IF;

    IF v_mode = 'api_key_header' THEN
      v_header_name := NULLIF(v_auth->>'header', '');
      v_credential_key := COALESCE(NULLIF(v_auth->>'credential_key', ''), 'api_key');
      v_api_key := NULLIF(v_credentials->>v_credential_key, '');
      IF v_header_name IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: auth_header_missing (job_id=%)', p_job_id;
      END IF;
      IF v_api_key IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: api_key_missing (credential_key=% job_id=%)', v_credential_key, p_job_id;
      END IF;
      v_headers := jsonb_set(v_headers, ARRAY[v_header_name], to_jsonb(v_api_key), TRUE);
    ELSIF v_mode = 'basic_auth_header' THEN
      v_header_name := NULLIF(v_auth->>'header', '');
      v_scheme := COALESCE(NULLIF(v_auth->>'scheme', ''), 'Basic');
      v_username := NULLIF(v_credentials->>COALESCE(NULLIF(v_auth->>'username_key', ''), 'username'), '');
      v_password := NULLIF(v_credentials->>COALESCE(NULLIF(v_auth->>'password_key', ''), 'password'), '');
      IF v_header_name IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: auth_header_missing (job_id=%)', p_job_id;
      END IF;
      IF v_username IS NULL OR v_password IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: basic_auth_credentials_missing (job_id=%)', p_job_id;
      END IF;
      v_headers := jsonb_set(
        v_headers,
        ARRAY[v_header_name],
        to_jsonb(v_scheme || ' ' || encode(convert_to(v_username || ':' || v_password, 'utf8'), 'base64')),
        TRUE
      );
    ELSIF v_mode = 'bearer_token_header' THEN
      v_header_name := COALESCE(NULLIF(v_auth->>'header', ''), 'authorization');
      v_scheme := COALESCE(NULLIF(v_auth->>'scheme', ''), 'Bearer');
      v_credential_key := COALESCE(NULLIF(v_auth->>'credential_key', ''), 'token');
      v_token := NULLIF(v_credentials->>v_credential_key, '');
      IF v_token IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: bearer_token_missing (credential_key=% job_id=%)', v_credential_key, p_job_id;
      END IF;
      v_headers := jsonb_set(v_headers, ARRAY[v_header_name], to_jsonb(v_scheme || ' ' || v_token), TRUE);
    ELSIF v_mode = 'api_key_query' THEN
      v_query_param := NULLIF(v_auth->>'query_param', '');
      v_credential_key := COALESCE(NULLIF(v_auth->>'credential_key', ''), 'api_key');
      v_api_key := NULLIF(v_credentials->>v_credential_key, '');
      IF v_query_param IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: auth_query_param_missing (job_id=%)', p_job_id;
      END IF;
      IF v_api_key IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: api_key_missing (credential_key=% job_id=%)', v_credential_key, p_job_id;
      END IF;
      IF position('?' IN v_url) > 0 THEN
        v_url := v_url || '&' || public.urlencode(v_query_param) || '=' || public.urlencode(v_api_key);
      ELSE
        v_url := v_url || '?' || public.urlencode(v_query_param) || '=' || public.urlencode(v_api_key);
      END IF;
    END IF;

    v_spec := jsonb_build_object(
        'url', v_url,
        'method', v_method,
        'headers', COALESCE(v_headers, '{}'::jsonb),
        'body', COALESCE(v_body, '{}'::jsonb)
    );

    RETURN v_spec;
END;
$$;

-------------------------------------------------------------------------------
-- Row-driven auth metadata (no secrets) for canonical operation templates
-------------------------------------------------------------------------------

-- 360dialog WhatsApp send (template message)
UPDATE public.operation_templates
SET
  headers_template = COALESCE(headers_template, '{}'::jsonb) - 'D360-API-KEY',
  metadata = jsonb_strip_nulls(
    COALESCE(metadata, '{}'::jsonb)
    || jsonb_build_object(
      'auth',
      jsonb_build_object(
        'mode', 'api_key_header',
        'auth_type', 'api_key',
        'header', 'D360-API-KEY',
        'credential_key', 'api_key'
      )
    )
  )
WHERE operation_name = 'dialog360_send_whatsapp_status_v1';

-- Logestechs create shipment (basic auth)
UPDATE public.operation_templates
SET
  headers_template = (COALESCE(headers_template, '{}'::jsonb) - 'authorization' - 'Authorization'),
  metadata = jsonb_strip_nulls(
    COALESCE(metadata, '{}'::jsonb)
    || jsonb_build_object(
      'auth',
      jsonb_build_object(
        'mode', 'basic_auth_header',
        'auth_type', 'basic_auth',
        'header', 'authorization',
        'scheme', 'Basic',
        'username_key', 'username',
        'password_key', 'password'
      )
    )
  )
WHERE operation_name = 'logestechs_create_shipment_v1';

-- Geocoding forward templates: remove api key params from url_query_mapping and inject at dispatch.
UPDATE public.operation_templates
SET metadata = jsonb_set(
  jsonb_strip_nulls(
    COALESCE(metadata, '{}'::jsonb)
    || jsonb_build_object(
      'auth',
      CASE operation_name
        WHEN 'geocoding_here_forward_v1' THEN jsonb_build_object(
          'mode', 'api_key_query',
          'auth_type', 'api_key',
          'query_param', 'apiKey',
          'credential_key', 'api_key'
        )
        WHEN 'geocoding_google_forward_v1' THEN jsonb_build_object(
          'mode', 'api_key_query',
          'auth_type', 'api_key',
          'query_param', 'key',
          'credential_key', 'api_key'
        )
        ELSE NULL
      END
    )
  ),
  '{url_query_mapping}',
  COALESCE(
    (
      SELECT COALESCE(jsonb_agg(e.elem ORDER BY e.ord), '[]'::jsonb)
      FROM (
        SELECT elem, ord
        FROM jsonb_array_elements(COALESCE(metadata->'url_query_mapping', '[]'::jsonb)) WITH ORDINALITY AS a(elem, ord)
        WHERE lower(COALESCE(elem->>'param','')) NOT IN ('apikey', 'key')
      ) e
    ),
    '[]'::jsonb
  ),
  TRUE
)
WHERE operation_name IN ('geocoding_here_forward_v1', 'geocoding_google_forward_v1');

-------------------------------------------------------------------------------
-- Geocoding handler: stop fetching/storing api_key; inject via get_job_call_spec instead
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_provider_dispatch_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx RECORD;
    v_policy_record RECORD;
    v_policy JSONB;
    v_provider_candidates TEXT[];
    v_sequence_index INT;
    v_candidate_index INT;
    v_provider RECORD;
    v_provider_name TEXT;
    v_template operation_templates%ROWTYPE;
    v_template_metadata JSONB;
    v_template_query JSONB;
    v_query_context JSONB;
    v_query_element JSONB;
    v_query_string TEXT := '';
    v_address RECORD;
    v_address_text TEXT;
    v_lang TEXT := COALESCE(NULLIF(v_metadata->>'lang', ''), 'en');
    v_limit INT := COALESCE((v_metadata->>'limit')::INT, 1);
    v_attempt_type TEXT := COALESCE(NULLIF(v_metadata->>'attempt_type', ''), 'primary');
    v_step_record workflow_run_steps%ROWTYPE;
    v_backpressure JSONB;
    v_queue_depth INT := 0;
    v_max_queue_depth INT;
    v_throttle_depth INT;
    v_delay_seconds INT;
    v_resume_seconds INT;
    v_response workflow_handler_response;
    v_value JSONB;
    v_value_text TEXT;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: address_id unavailable for workflow_run %', p_step.workflow_run_id;
    END IF;

    SELECT *
    INTO v_policy_record
    FROM public.geocoding_resolve_policy(
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id
    )
    LIMIT 1;

    v_policy := v_policy_record.policy;

    IF v_policy IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: geocoding_policy missing for workflow_run %', p_step.workflow_run_id;
    END IF;

    v_backpressure := COALESCE(v_policy->'backpressure', '{}'::jsonb);
    v_max_queue_depth := COALESCE((v_backpressure->>'max_queue_depth')::INT, NULL);
    v_throttle_depth := COALESCE((v_backpressure->>'throttle_ingest_at')::INT, NULL);
    v_delay_seconds := COALESCE((v_backpressure->>'throttle_delay_seconds')::INT, 30);
    v_resume_seconds := COALESCE((v_backpressure->>'resume_after_seconds')::INT, 120);

    IF v_max_queue_depth IS NOT NULL OR v_throttle_depth IS NOT NULL THEN
        SELECT COALESCE(COUNT(*), 0)
        INTO v_queue_depth
        FROM workflow_runs wr
        JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
        JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
        LEFT JOIN LATERAL geocoding_extract_context(wr) ctx ON TRUE
        WHERE wt.name LIKE 'workflow_geocoding%'
          AND wrs.operation_name IN ('dispatch_provider', 'fallback_provider')
          AND wrs.step_status IN ('pending', 'in_progress')
          AND wr.id <> p_run.id
          AND ctx.client_id IS NOT NULL
          AND ctx.client_id = v_ctx.client_id;

        IF v_max_queue_depth IS NOT NULL
           AND v_queue_depth >= v_max_queue_depth
           AND COALESCE((v_backpressure->>'pause_workflow_when_full')::BOOLEAN, FALSE) THEN
            v_response.status := 'pending';
            v_response.next_run_at := now() + make_interval(secs => GREATEST(v_resume_seconds, 30));
            v_response.operation_result := jsonb_build_object(
                'skipped', TRUE,
                'reason', 'backpressure_max_queue',
                'queue_depth', v_queue_depth,
                'max_queue_depth', v_max_queue_depth
            );
            v_response.context_patch := jsonb_build_object(
                'geocoding', jsonb_build_object(
                    'backpressure', jsonb_build_object(
                        'status', 'paused',
                        'queue_depth', v_queue_depth,
                        'max_queue_depth', v_max_queue_depth
                    )
                )
            );
            RETURN v_response;
        ELSIF v_throttle_depth IS NOT NULL AND v_queue_depth >= v_throttle_depth THEN
            v_response.status := 'pending';
            v_response.next_run_at := now() + make_interval(secs => GREATEST(v_delay_seconds, 10));
            v_response.operation_result := jsonb_build_object(
                'skipped', TRUE,
                'reason', 'backpressure_throttle',
                'queue_depth', v_queue_depth,
                'throttle_ingest_at', v_throttle_depth
            );
            v_response.context_patch := jsonb_build_object(
                'geocoding', jsonb_build_object(
                    'backpressure', jsonb_build_object(
                        'status', 'throttled',
                        'queue_depth', v_queue_depth,
                        'throttle_ingest_at', v_throttle_depth
                    )
                )
            );
            RETURN v_response;
        END IF;
    END IF;

    v_provider_candidates := ARRAY(
        SELECT elem::TEXT
        FROM jsonb_array_elements_text(COALESCE(v_policy->'provider_priority', '[]'::jsonb)) AS elem
        WHERE elem::TEXT NOT IN ('internal_cache', 'manual_review_virtual')
    );

    v_sequence_index := COALESCE(
        NULLIF(v_metadata->>'provider_sequence_index', '')::INT,
        0
    );

    v_candidate_index := v_sequence_index;
    WHILE v_candidate_index < COALESCE(array_length(v_provider_candidates, 1), 0) LOOP
        v_provider_name := v_provider_candidates[v_candidate_index + 1];

        SELECT pr.*
        INTO v_provider
        FROM providers pr
        WHERE pr.name = v_provider_name
        LIMIT 1;

        IF v_provider.id IS NULL THEN
            v_candidate_index := v_candidate_index + 1;
            CONTINUE;
        END IF;

        SELECT *
        INTO v_template
        FROM operation_templates ot
        WHERE ot.provider_id = v_provider.id
          AND ot.operation_name = COALESCE(
                NULLIF(v_metadata->>'operation_name', ''),
                CASE
                    WHEN v_provider.name = 'google_maps' THEN 'geocoding_google_forward_v1'
                    ELSE 'geocoding_here_forward_v1'
                END
          )
          AND COALESCE(ot.metadata->>'operation_role', '') = 'geocoding_forward'
        ORDER BY ot.updated_at DESC
        LIMIT 1;

        IF v_template.id IS NOT NULL THEN
            EXIT;
        END IF;

        v_candidate_index := v_candidate_index + 1;
    END LOOP;

    IF v_template.id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: operation template missing for provider %', v_provider_name;
    END IF;

    SELECT
        COALESCE(a.normalized_line1, a.line1, (a.raw_input::jsonb)->>'line1', '') AS line1,
        COALESCE(a.normalized_line2, a.line2, (a.raw_input::jsonb)->>'line2', '') AS line2,
        COALESCE(a.district, '') AS district,
        COALESCE(a.city, (a.raw_input::jsonb)->>'city', '') AS city,
        COALESCE(a.province, (a.raw_input::jsonb)->>'province', '') AS province,
        COALESCE(a.country, (a.raw_input::jsonb)->>'country', '') AS country
    INTO v_address
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id;

    v_address_text := COALESCE(
        NULLIF(p_run.context->'geocoding'->>'normalized_address', ''),
        NULLIF(trim(concat_ws(
            ' ',
            NULLIF(v_address.line1, ''),
            NULLIF(v_address.line2, ''),
            NULLIF(v_address.district, ''),
            NULLIF(v_address.city, ''),
            NULLIF(v_address.province, ''),
            NULLIF(v_address.country, '')
        )), '')
    );

    IF v_address_text IS NULL OR v_address_text = '' THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: normalized address unavailable for workflow_run_step %', p_step.id;
    END IF;

    v_template_metadata := COALESCE(v_template.metadata, '{}'::jsonb);
    v_template_query := COALESCE(v_template_metadata->'url_query_mapping', '[]'::jsonb);

    v_query_context := jsonb_strip_nulls(
        jsonb_build_object(
            'address', jsonb_strip_nulls(
                jsonb_build_object(
                    'text', v_address_text,
                    'lang', v_lang,
                    'limit', v_limit
                )
            ),
            'provider', jsonb_strip_nulls(
                jsonb_build_object(
                    'name', v_provider.name
                )
            ),
            'policy', v_policy,
            'step', COALESCE(p_step.metadata, '{}'::jsonb),
            'run', jsonb_strip_nulls(
                jsonb_build_object(
                    'id', p_run.id,
                    'attempt_type', v_attempt_type
                )
            )
        )
    );

    v_query_string := '';
    FOR v_query_element IN SELECT * FROM jsonb_array_elements(v_template_query)
    LOOP
        IF COALESCE(v_query_element->>'param', '') = '' THEN
            CONTINUE;
        END IF;

        v_value := safe_jsonpath_query_first(
            v_query_context,
            COALESCE(v_query_element->>'value_path', '')
        );

        IF v_value IS NULL OR v_value = 'null'::jsonb THEN
            CONTINUE;
        END IF;

        v_value_text := CASE jsonb_typeof(v_value)
            WHEN 'string' THEN trim(both '\"' FROM v_value::TEXT)
            ELSE v_value::TEXT
        END;

        IF v_value_text IS NULL OR v_value_text = '' THEN
            CONTINUE;
        END IF;

        v_query_string := v_query_string ||
            CASE WHEN v_query_string = '' THEN '' ELSE '&' END ||
            format('%s=%s',
                   COALESCE(v_query_element->>'param', ''),
                   public.urlencode(v_value_text));
    END LOOP;

    v_step_record := p_step;

    v_step_record.metadata := jsonb_strip_nulls(
        COALESCE(p_step.metadata, '{}'::jsonb)
        || jsonb_build_object(
            'operation_template_id', v_template.id::TEXT,
            'override_url',
                v_template.url_template ||
                CASE
                    WHEN v_query_string IS NULL OR v_query_string = '' THEN ''
                    WHEN position('?' IN v_template.url_template) > 0 THEN '&' || v_query_string
                    ELSE '?' || v_query_string
                END,
            'provider_id', v_provider.id::TEXT,
            'provider_name', v_provider.name,
            'provider_sequence_index', v_sequence_index,
            'attempt_type', v_attempt_type,
            'lang', v_lang,
            'limit', v_limit
        )
    );

    UPDATE workflow_run_steps
    SET metadata = v_step_record.metadata,
        updated_at = now()
    WHERE id = p_step.id;

    RETURN workflow_handlers.execute_outbound_http_v1(
        v_step_record,
        p_run,
        p_operation_result
    );
END;
$$;

COMMIT;
