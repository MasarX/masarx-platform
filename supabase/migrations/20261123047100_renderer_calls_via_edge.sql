-- Keep renderer credentials in the leased Edge worker.
BEGIN;

CREATE FUNCTION public.sql_transport_headers_v1(p_headers jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_headers jsonb := COALESCE(p_headers, '{}'::jsonb);
  v_safe jsonb;
BEGIN
  IF jsonb_typeof(v_headers) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_headers_invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_headers) AS h(name)
    WHERE lower(btrim(h.name) COLLATE "C") IN (
      'authorization', 'cookie', 'set-cookie', 'd360-api-key', 'x-api-key', 'apikey', 'api-key',
      'x-provider-auth', 'x-auth-token', 'x-webhook-token'
    ) OR lower(btrim(h.name) COLLATE "C") LIKE 'proxy-%'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_credential_headers_refused';
  END IF;
  SELECT COALESCE(jsonb_object_agg(h.name, h.value), '{}'::jsonb)
    INTO v_safe
    FROM jsonb_each(v_headers) AS h(name, value)
   WHERE lower(h.name COLLATE "C") IN (
     'accept', 'accept-language', 'company-id', 'content-type', 'idempotency-key', 'user-agent',
     'x-client-id', 'x-correlation-id', 'x-idempotency-key', 'x-request-id', 'traceparent', 'tracestate'
   )
     AND jsonb_typeof(h.value) = 'string'
     AND (h.value #>> '{}') !~ '[[:cntrl:]]';
  RETURN v_safe;
END;
$function$;

REVOKE ALL ON FUNCTION public.sql_transport_headers_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;

CREATE OR REPLACE FUNCTION public.dispatch_api_request_v1(
    p_url TEXT,
    p_method TEXT DEFAULT 'POST',
    p_headers JSONB DEFAULT '{}'::jsonb,
    p_body JSONB DEFAULT '{}'::jsonb,
    p_timeout_seconds INT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_request_id BIGINT;
    v_timeout_seconds INT := GREATEST(COALESCE(p_timeout_seconds, 30), 1);
    v_method TEXT := UPPER(COALESCE(NULLIF(p_method, ''), 'POST'));
    v_headers JSONB := public.sql_transport_headers_v1(p_headers);
    v_body JSONB := COALESCE(p_body, '{}'::jsonb);
    v_pg_net_available BOOLEAN := FALSE;
BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
      INTO v_pg_net_available;

    IF NOT v_pg_net_available THEN
        RAISE EXCEPTION 'pg_net extension not available. Enable pg_net or configure api-caller edge function to handle HTTP execution.';
    END IF;

    CASE v_method
        WHEN 'GET' THEN
            SELECT net.http_get(
                url := p_url,
                params := '{}'::jsonb,
                headers := v_headers,
                timeout_milliseconds := v_timeout_seconds * 1000
            ) INTO v_request_id;
        WHEN 'POST' THEN
            SELECT net.http_post(
                url := p_url,
                body := v_body,
                params := '{}'::jsonb,
                headers := v_headers,
                timeout_milliseconds := v_timeout_seconds * 1000
            ) INTO v_request_id;
        WHEN 'DELETE' THEN
            SELECT net.http_delete(
                url := p_url,
                params := '{}'::jsonb,
                headers := v_headers,
                timeout_milliseconds := v_timeout_seconds * 1000,
                body := v_body
            ) INTO v_request_id;
        WHEN 'PUT' THEN
            SELECT net.http_post(
                url := p_url,
                body := v_body,
                params := '{}'::jsonb,
                headers := jsonb_set(v_headers, '{X-HTTP-Method-Override}', '"PUT"'),
                timeout_milliseconds := v_timeout_seconds * 1000
            ) INTO v_request_id;
        WHEN 'PATCH' THEN
            SELECT net.http_post(
                url := p_url,
                body := v_body,
                params := '{}'::jsonb,
                headers := jsonb_set(v_headers, '{X-HTTP-Method-Override}', '"PATCH"'),
                timeout_milliseconds := v_timeout_seconds * 1000
            ) INTO v_request_id;
        ELSE
            RAISE EXCEPTION 'Unsupported HTTP method: %. Supported methods: GET, POST, PUT, PATCH, DELETE', p_method;
    END CASE;

    RETURN v_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.call_api(
    p_url TEXT,
    p_method TEXT DEFAULT 'POST',
    p_headers JSONB DEFAULT '{}'::jsonb,
    p_body JSONB DEFAULT '{}'::jsonb,
    p_timeout_seconds INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_start_time          TIMESTAMPTZ := clock_timestamp();
    v_api_caller_config   JSONB;
    v_edge_settings       JSONB;
    v_edge_url            TEXT;
    v_edge_enabled        BOOLEAN := FALSE;
    v_resolved_timeout    INT;
    v_request_id          BIGINT;
    v_response_status     INT;
    v_response_headers    JSONB;
    v_response_body       TEXT;
    v_wait_iterations     INT := 0;
    v_max_iterations      INT := 10;
    v_method              TEXT := COALESCE(NULLIF(p_method, ''), 'POST');
    v_request_headers JSONB := public.sql_transport_headers_v1(p_headers);
BEGIN
    v_api_caller_config := resolve_settings('api_caller_policy', 'global', NULL);

    IF p_timeout_seconds IS NOT NULL THEN
        v_resolved_timeout := p_timeout_seconds;
    ELSIF v_api_caller_config ? 'default_timeout_seconds' THEN
        v_resolved_timeout := (v_api_caller_config->>'default_timeout_seconds')::INT;
    ELSE
        v_resolved_timeout := 30;
    END IF;

    IF v_resolved_timeout <= 0 THEN
        RAISE EXCEPTION 'Resolved timeout must be positive (resolved=%)', v_resolved_timeout;
    END IF;

    BEGIN
        v_edge_settings := resolve_settings('edge_dispatch_policy', 'global', NULL);
        v_edge_url := NULLIF(COALESCE(v_edge_settings->>'endpoint_url', ''), '');
        BEGIN
            v_edge_enabled := COALESCE(NULLIF(v_edge_settings->>'enabled', '')::BOOLEAN, TRUE);
        EXCEPTION
            WHEN others THEN
                v_edge_enabled := TRUE;
        END;
    EXCEPTION
        WHEN others THEN
            v_edge_settings := NULL;
            v_edge_url := NULL;
            v_edge_enabled := FALSE;
    END;

    IF v_edge_enabled AND v_edge_url IS NOT NULL THEN
        RETURN jsonb_build_object(
            'status', 202,
            'completed', FALSE,
            'edge_dispatch', jsonb_build_object(
                'url', p_url,
                'method', UPPER(v_method),
                'headers', v_request_headers,
                'body', COALESCE(p_body, '{}'::jsonb),
                'timeout_seconds', v_resolved_timeout
            ),
            'latency_ms', 0
        );
    END IF;

    v_request_id := public.dispatch_api_request_v1(
        p_url,
        v_method,
        v_request_headers,
        COALESCE(p_body, '{}'::jsonb),
        v_resolved_timeout
    );

    WHILE v_wait_iterations < v_max_iterations LOOP
        BEGIN
            SELECT status_code, headers, content::TEXT
            INTO v_response_status, v_response_headers, v_response_body
            FROM net._http_response
            WHERE id = v_request_id;

            IF v_response_status IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'status', v_response_status,
                    'headers', COALESCE(v_response_headers, '{}'::jsonb),
                    'body', CASE
                        WHEN v_response_body IS NULL THEN '{}'::jsonb
                        WHEN v_response_body ~ '^\\s*[\\[\\{]' THEN v_response_body::JSONB
                        ELSE to_jsonb(v_response_body)
                    END,
                    'completed', TRUE,
                    'request_id', v_request_id,
                    'latency_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000)::INT,
                    'poll_iterations', v_wait_iterations + 1
                );
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;

        PERFORM pg_sleep(0.1);
        v_wait_iterations := v_wait_iterations + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'status', 202,
        'headers', '{}'::jsonb,
        'body', jsonb_build_object(
            'message', 'HTTP request accepted - response pending',
            'request_id', v_request_id,
            'poll_sql', format('SELECT * FROM check_async_response(%s);', v_request_id),
            'note', 'Call check_async_response(request_id) or query net._http_response for completion'
        ),
        'completed', FALSE,
        'request_id', v_request_id,
        'latency_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000)::INT,
        'poll_iterations', v_wait_iterations
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.call_api_wait(
    p_url TEXT,
    p_method TEXT DEFAULT 'POST',
    p_headers JSONB DEFAULT '{}'::jsonb,
    p_body JSONB DEFAULT '{}'::jsonb,
    p_timeout_seconds INT DEFAULT NULL,
    p_wait_seconds INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_start_time TIMESTAMPTZ := clock_timestamp();
    v_api_caller_config JSONB;
    v_edge_settings JSONB;
    v_edge_url TEXT;
    v_edge_enabled BOOLEAN := FALSE;
    v_timeout_seconds INT;
    v_wait_seconds INT;
    v_deadline TIMESTAMPTZ;
    v_poll_iterations INT := 0;
    v_max_iterations INT;
    v_request_id BIGINT;
    v_check JSONB;
    v_status INT;
    v_headers JSONB;
    v_body JSONB;
    v_method TEXT := COALESCE(NULLIF(p_method, ''), 'POST');
    v_request_headers JSONB := public.sql_transport_headers_v1(p_headers);
BEGIN
    v_api_caller_config := resolve_settings('api_caller_policy', 'global', NULL);

    IF p_timeout_seconds IS NOT NULL THEN
        v_timeout_seconds := p_timeout_seconds;
    ELSIF v_api_caller_config ? 'default_timeout_seconds' THEN
        v_timeout_seconds := (v_api_caller_config->>'default_timeout_seconds')::INT;
    ELSE
        v_timeout_seconds := 30;
    END IF;

    IF v_timeout_seconds <= 0 THEN
        RAISE EXCEPTION 'Resolved timeout must be positive (resolved=%)', v_timeout_seconds;
    END IF;

    IF p_wait_seconds IS NOT NULL THEN
        v_wait_seconds := p_wait_seconds;
    ELSE
        v_wait_seconds := v_timeout_seconds;
    END IF;

    IF v_wait_seconds <= 0 THEN
        RAISE EXCEPTION 'call_api_wait: wait_seconds must be positive (got=%)', v_wait_seconds;
    END IF;

    BEGIN
        v_edge_settings := resolve_settings('edge_dispatch_policy', 'global', NULL);
        v_edge_url := NULLIF(COALESCE(v_edge_settings->>'endpoint_url', ''), '');
        BEGIN
            v_edge_enabled := COALESCE(NULLIF(v_edge_settings->>'enabled', '')::BOOLEAN, TRUE);
        EXCEPTION
            WHEN others THEN
                v_edge_enabled := TRUE;
        END;
    EXCEPTION
        WHEN others THEN
            v_edge_settings := NULL;
            v_edge_url := NULL;
            v_edge_enabled := FALSE;
    END;

    IF v_edge_enabled AND v_edge_url IS NOT NULL THEN
        RETURN jsonb_build_object(
            'status', 202,
            'completed', FALSE,
            'edge_dispatch', jsonb_build_object(
                'url', p_url,
                'method', UPPER(v_method),
                'headers', v_request_headers,
                'body', COALESCE(p_body, '{}'::jsonb),
                'timeout_seconds', v_timeout_seconds
            ),
            'latency_ms', 0,
            'wait_seconds', v_wait_seconds,
            'wait_poll_iterations', 0
        );
    END IF;

    v_deadline := clock_timestamp() + make_interval(secs => v_wait_seconds);
    v_max_iterations := CEIL(v_wait_seconds::numeric / 0.2)::INT;
    v_request_id := public.dispatch_api_request_v1(
        p_url,
        v_method,
        v_request_headers,
        COALESCE(p_body, '{}'::jsonb),
        v_timeout_seconds
    );

    WHILE clock_timestamp() < v_deadline AND v_poll_iterations < v_max_iterations LOOP
        v_check := public.check_async_response(v_request_id);
        IF COALESCE((v_check->>'completed')::BOOLEAN, FALSE) THEN
            v_status := NULLIF(v_check->>'status', '')::INT;
            v_headers := COALESCE(v_check->'headers', '{}'::jsonb);
            v_body := COALESCE(v_check->'body', '{}'::jsonb);

            RETURN jsonb_build_object(
                'status', v_status,
                'headers', v_headers,
                'body', v_body,
                'completed', TRUE,
                'request_id', v_request_id,
                'latency_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000)::INT,
                'poll_iterations', v_poll_iterations + 1,
                'wait_seconds', v_wait_seconds,
                'wait_poll_iterations', v_poll_iterations + 1
            );
        END IF;

        PERFORM pg_sleep(0.2);
        v_poll_iterations := v_poll_iterations + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'status', 202,
        'headers', '{}'::jsonb,
        'body', jsonb_build_object(
            'message', 'HTTP request accepted - response pending',
            'request_id', v_request_id,
            'poll_sql', format('SELECT * FROM check_async_response(%s);', v_request_id),
            'note', 'Call check_async_response(request_id) or query net._http_response for completion'
        ),
        'completed', FALSE,
        'request_id', v_request_id,
        'latency_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000)::INT,
        'poll_iterations', v_poll_iterations,
        'wait_seconds', v_wait_seconds,
        'wait_poll_iterations', v_poll_iterations
    );
END;
$$;

ALTER TABLE public.outbound_calls
  ADD COLUMN renderer_request_id bigint,
  ADD COLUMN renderer_credential_ref uuid;

CREATE UNIQUE INDEX outbound_calls_renderer_request_id_idx
  ON public.outbound_calls (renderer_request_id)
  WHERE renderer_request_id IS NOT NULL;

CREATE FUNCTION public.resolve_label_renderer_edge_config_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_settings jsonb;
  v_provider jsonb;
  v_url text;
  v_ref uuid;
  v_timeout_ms integer;
BEGIN
  IF p_organization_id IS NOT NULL THEN
    v_settings := public.resolve_settings('label_provider', 'tenant', p_organization_id);
    v_url := NULLIF(v_settings #>> '{providers,0,invoke_url}', '');
  END IF;
  IF v_settings IS NULL OR v_url LIKE ('https://' || 'example' || '.%') THEN
    v_settings := public.resolve_settings('label_provider', 'global', NULL);
  END IF;

  v_provider := v_settings #> '{providers,0}';
  v_url := NULLIF(v_provider->>'invoke_url', '');
  IF v_url LIKE ('https://' || 'example' || '.%') THEN
    RETURN jsonb_build_object('state', 'placeholder_url');
  END IF;
  IF v_url IS NULL OR NOT public.outbound_url_allowed_v1(v_url, NULL) THEN
    RETURN jsonb_build_object('state', 'missing_or_invalid_url');
  END IF;
  IF v_provider #>> '{invoke_secret_ref,type}' IS DISTINCT FROM 'SecretRef'
     OR pg_input_is_valid(v_provider #>> '{invoke_secret_ref,id}', 'uuid') IS NOT TRUE THEN
    RETURN jsonb_build_object('state', 'missing_secret_ref');
  END IF;

  v_ref := (v_provider #>> '{invoke_secret_ref,id}')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets s
    WHERE s.id = v_ref AND starts_with(s.name, 'label_provider/')
      AND s.description::jsonb->>'pinned_invoke_url' = v_url
  ) THEN
    RETURN jsonb_build_object('state', 'pin_mismatch');
  END IF;

  v_timeout_ms := COALESCE(NULLIF(v_provider->>'timeout_ms', '')::integer, 15000);
  RETURN jsonb_build_object(
    'state', 'ready', 'url', v_url, 'renderer_credential_ref', v_ref,
    'provider_name', NULLIF(v_provider->>'name', ''),
    'timeout_seconds', GREATEST((v_timeout_ms + 999) / 1000, 1)
  );
END;
$function$;

CREATE FUNCTION public.enqueue_label_renderer_edge_v1(p_organization_id uuid, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_provider jsonb := public.resolve_label_renderer_edge_config_v1(p_organization_id);
  v_job_id uuid := gen_random_uuid();
  v_run_id uuid := gen_random_uuid();
  v_step_id uuid := gen_random_uuid();
  v_request_id bigint;
  v_template public.workflow_templates%ROWTYPE;
  v_template_step public.workflow_template_steps%ROWTYPE;
  v_prior_run text := current_setting('app.workflow_run_id', true);
  v_prior_step text := current_setting('app.workflow_run_step_id', true);
BEGIN
  IF v_provider->>'state' <> 'ready' THEN
    RETURN jsonb_build_object('completed', true, 'status', 503, 'body',
      jsonb_build_object('error', 'label_renderer_unavailable', 'reason', v_provider->>'state'));
  END IF;

  -- Keep transport settlement independent from the renderer's owning-step callback.
  SELECT wt.* INTO STRICT v_template
    FROM public.resolve_settings_row_from_context('workflow_defaults',
      jsonb_strip_nulls(jsonb_build_object('organization_id', p_organization_id))) d
    JOIN public.workflow_templates wt ON wt.id = NULLIF(d.value->>'legacy_outbound_template_id', '')::uuid
   WHERE wt.status = 'active';
  SELECT s.* INTO STRICT v_template_step
    FROM public.workflow_template_steps s
   WHERE s.workflow_template_id = v_template.id AND s.enabled
   ORDER BY s.sequence_order, s.id
   LIMIT 1;

  PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
  PERFORM set_config('app.workflow_run_step_id', v_step_id::text, true);
  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context, metadata,
    started_at, completed_at
  ) VALUES (
    v_run_id, v_template.id, v_template.version, 'enqueue_outbound_call', 'completed',
    jsonb_strip_nulls(jsonb_build_object('organization_id', p_organization_id)), '{}'::jsonb, now(), now()
  );
  INSERT INTO public.workflow_run_steps (
    id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name,
    handler_key, handler_version, max_retries, operation_started_at, operation_completed_at, enqueued_at
  ) VALUES (
    v_step_id, v_run_id, v_template_step.id, v_template_step.sequence_order, 'completed',
    v_template_step.operation_name, v_template_step.handler_key, v_template_step.handler_version,
    1, now(), now(), now()
  );

  -- Allocate from the same sequence so legacy and Edge readback IDs never collide.
  v_request_id := nextval('net.http_request_queue_id_seq'::regclass);
  INSERT INTO public.outbound_calls (
    id, call_type, target_type, target_id, url, method, headers, body, status, max_retries,
    workflow_run_step_id, context, renderer_request_id, renderer_credential_ref
  ) VALUES (
    v_job_id, 'provider_api', 'provider', (v_provider->>'renderer_credential_ref')::uuid,
    v_provider->>'url', 'POST', '{}'::jsonb, p_payload, 'pending_edge', 1, v_step_id,
    jsonb_strip_nulls(jsonb_build_object('organization_id', p_organization_id)),
    v_request_id, (v_provider->>'renderer_credential_ref')::uuid
  );
  PERFORM set_config('app.workflow_run_id', COALESCE(v_prior_run, ''), true);
  PERFORM set_config('app.workflow_run_step_id', COALESCE(v_prior_step, ''), true);

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', 202, 'completed', FALSE, 'request_id', v_request_id, 'edge_job_id', v_job_id,
    'latency_ms', 0, 'headers', '{}'::jsonb,
    'body', jsonb_build_object('message', 'Renderer job accepted', 'request_id', v_request_id),
    'request_payload', p_payload, 'provider_name', v_provider->>'provider_name'
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_label_renderer_edge_config_v1(uuid) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.enqueue_label_renderer_edge_v1(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;


-- PostgreSQL cannot remove defaults in place. Preserve the defaults on the one-argument overload.
DROP FUNCTION public.invoke_label_renderer(integer, jsonb);
CREATE OR REPLACE FUNCTION public.invoke_label_renderer(
    p_max_jobs INT,
    p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_body JSONB;
    v_org_id UUID;
BEGIN
    v_body := CASE
        WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
            THEN jsonb_strip_nulls(p_payload)
        ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
    END;

    -- Preserve the canonical conflicting-envelope rejection before selecting
    -- tenant-scoped provider authority.
    v_org_id := public.resolve_label_renderer_organization_id_v1(v_body);
    RETURN public.enqueue_label_renderer_edge_v1(v_org_id, v_body);
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_label_renderer(integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(integer, jsonb) TO service_role;
DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(integer, jsonb) TO edge_label_renderer_role;
  END IF;
END;
$roles$;

CREATE OR REPLACE FUNCTION public.invoke_label_renderer(p_max_jobs INT DEFAULT 5)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
BEGIN
  -- Delegate to the primary implementation with NULL payload. This preserves
  -- existing behaviour for callers that only provide max_jobs while allowing
  -- richer payloads via the extended signature.
  RETURN public.invoke_label_renderer(p_max_jobs, NULL::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_label_renderer_print_sync_v1(
  p_workflow_run_id uuid,
  p_workflow_run_step_id uuid,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_print_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_org_id uuid := NULL;
  v_workflow_progress_enabled boolean := true;
  v_workflow_progress_budget_ms int := 1200;
  v_workflow_progress_max_steps int := 10;
  v_execute_dispatch_mode text := 'async';
  v_execute_wait_seconds int := 12;
  v_execute_wait_poll_ms int := 100;
  v_request_body jsonb;
  v_enabled_text text := '';
BEGIN
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires workflow_run_id';
  END IF;
  IF p_workflow_run_step_id IS NULL THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires workflow_run_step_id';
  END IF;
  IF jsonb_typeof(v_print_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires object payload';
  END IF;

  IF jsonb_typeof(v_print_payload->'print') = 'object' THEN
    v_print_payload := v_print_payload->'print';
  END IF;

  v_org_id := public.resolve_label_renderer_organization_id_v1(p_payload);
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires organization_id in payload';
  END IF;

  v_enabled_text := lower(COALESCE(NULLIF(v_print_payload->>'workflow_progress_enabled', ''), 'true'));
  v_workflow_progress_enabled := v_enabled_text IN ('1', 't', 'true', 'y', 'yes', 'on');

  IF COALESCE(v_print_payload->>'workflow_progress_budget_ms', '') ~ '^\d+$' THEN
    v_workflow_progress_budget_ms := LEAST(GREATEST((v_print_payload->>'workflow_progress_budget_ms')::int, 25), 5000);
  END IF;
  IF COALESCE(v_print_payload->>'workflow_progress_max_steps', '') ~ '^\d+$' THEN
    v_workflow_progress_max_steps := LEAST(GREATEST((v_print_payload->>'workflow_progress_max_steps')::int, 1), 50);
  END IF;

  v_execute_dispatch_mode := lower(COALESCE(NULLIF(v_print_payload->>'execute_dispatch_mode', ''), 'async'));
  IF v_execute_dispatch_mode NOT IN ('async', 'sync_wait') THEN
    v_execute_dispatch_mode := 'async';
  END IF;
  IF COALESCE(v_print_payload->>'execute_wait_seconds', '') ~ '^\d+$' THEN
    v_execute_wait_seconds := LEAST(GREATEST((v_print_payload->>'execute_wait_seconds')::int, 1), 60);
  END IF;
  IF COALESCE(v_print_payload->>'execute_wait_poll_ms', '') ~ '^\d+$' THEN
    v_execute_wait_poll_ms := LEAST(GREATEST((v_print_payload->>'execute_wait_poll_ms')::int, 25), 1000);
  END IF;

  -- The renderer callback must be able to acquire the workflow row after commit.
  IF v_execute_dispatch_mode = 'sync_wait' THEN
    v_execute_dispatch_mode := 'async';
    v_workflow_progress_enabled := TRUE;
  END IF;

  v_print_payload := jsonb_strip_nulls(
    v_print_payload || jsonb_build_object(
      'organization_id', v_org_id,
      'workflow_run_id', p_workflow_run_id,
      'workflow_run_step_id', p_workflow_run_step_id,
      'workflow_progress_enabled', v_workflow_progress_enabled,
      'workflow_progress_budget_ms', v_workflow_progress_budget_ms,
      'workflow_progress_max_steps', v_workflow_progress_max_steps,
      'execute_dispatch_mode', v_execute_dispatch_mode,
      'execute_wait_seconds', v_execute_wait_seconds,
      'execute_wait_poll_ms', v_execute_wait_poll_ms
    )
  );

  v_request_body := jsonb_build_object('organization_id', v_org_id, 'print', v_print_payload);
  RETURN public.enqueue_label_renderer_edge_v1(v_org_id, v_request_body)
    || jsonb_build_object('dispatch_mode', v_execute_dispatch_mode);
END;
$$;

CREATE OR REPLACE FUNCTION public.check_async_response(p_request_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_response_status  INT;
    v_response_headers JSONB;
    v_response_body    TEXT;
    v_error_msg        TEXT;
    v_timed_out        BOOLEAN;
    v_renderer        RECORD;
BEGIN
    SELECT status, response_status_code, response_headers, response_body, error_message
      INTO v_renderer
      FROM public.outbound_calls
     WHERE renderer_request_id = p_request_id;
    IF FOUND THEN
        IF v_renderer.status IN ('completed', 'permanently_failed', 'skipped') THEN
            RETURN jsonb_build_object(
                'completed', TRUE,
                'status', COALESCE(v_renderer.response_status_code, 0),
                'headers', COALESCE(v_renderer.response_headers, '{}'::jsonb),
                'body', COALESCE(v_renderer.response_body, jsonb_build_object('error', v_renderer.error_message))
            );
        END IF;
        RETURN jsonb_build_object('completed', FALSE, 'status', NULL, 'headers', '{}'::jsonb, 'body', '{}'::jsonb);
    END IF;

    BEGIN
        SELECT status_code, headers, content::TEXT, error_msg, timed_out
          INTO v_response_status, v_response_headers, v_response_body, v_error_msg, v_timed_out
          FROM net._http_response
         WHERE id = p_request_id;
    EXCEPTION
        WHEN undefined_table THEN
            RAISE EXCEPTION 'pg_net extension not available (net._http_response missing). Enable pg_net to use check_async_response().';
    END;

    -- If the HTTP worker wrote an error (or timed out), treat it as completed so callers can handle failure.
    IF v_error_msg IS NOT NULL OR COALESCE(v_timed_out, FALSE) THEN
        RETURN jsonb_build_object(
            'completed', TRUE,
            'status', COALESCE(v_response_status, 0),
            'headers', COALESCE(v_response_headers, '{}'::jsonb),
            'body', jsonb_build_object(
              'error', COALESCE(v_error_msg, 'timed_out'),
              'timed_out', COALESCE(v_timed_out, FALSE)
            )
        );
    END IF;

    IF v_response_status IS NULL THEN
        RETURN jsonb_build_object(
            'completed', FALSE,
            'status', NULL,
            'headers', '{}'::jsonb,
            'body', '{}'::jsonb
        );
    END IF;

    RETURN jsonb_build_object(
        'completed', TRUE,
        'status', v_response_status,
        'headers', COALESCE(v_response_headers, '{}'::jsonb),
        'body', CASE
            WHEN v_response_body IS NULL THEN '{}'::jsonb
            WHEN v_response_body ~ '^\s*[\[\{]' THEN v_response_body::JSONB
            ELSE to_jsonb(v_response_body)
        END
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_pending_jobs(
    p_batch_size INT
)
RETURNS TABLE (
    job_id UUID,
    call_type TEXT,
    target_type TEXT,
    target_id UUID,
    method TEXT,
    url TEXT,
    headers JSONB,
    body JSONB,
    priority INT,
    retry_count INT,
    max_retries INT,
    correlation_id UUID,
    shipment_id UUID,
    context JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_edge_ready BOOLEAN := FALSE;
    v_edge_settings JSONB;
    v_endpoint_url TEXT;
    v_edge_jwt_present BOOLEAN := FALSE;
    v_edge_enabled BOOLEAN := TRUE;
BEGIN
    v_edge_ready := to_regprocedure('public.run_api_caller_batch(int)') IS NOT NULL;

    v_edge_settings := resolve_settings('edge_dispatch_policy', 'global', NULL);
    v_endpoint_url := NULLIF(COALESCE(v_edge_settings->>'endpoint_url', ''), '');
    BEGIN
      v_edge_enabled := COALESCE(NULLIF(v_edge_settings->>'enabled', '')::BOOLEAN, TRUE);
    EXCEPTION
      WHEN others THEN
        v_edge_enabled := TRUE;
    END;

    SELECT EXISTS (
      SELECT 1
        FROM public.providers p
        JOIN public.provider_auth_configs pac ON pac.provider_id = p.id
       WHERE p.name = 'edge_api_caller'
         AND NULLIF(COALESCE(pac.credentials->>'shared_secret', ''), '') IS NOT NULL
    ) INTO v_edge_jwt_present;

    v_edge_ready := v_edge_ready AND v_edge_enabled AND v_endpoint_url IS NOT NULL AND v_edge_jwt_present;

    RETURN QUERY
    UPDATE public.outbound_calls AS oc
       SET lease_expires_at = now() + interval '30 seconds'
     WHERE oc.id IN (
        SELECT oc2.id
          FROM public.outbound_calls oc2
         WHERE (
               oc2.status = 'pending'
               OR (NOT v_edge_ready AND oc2.status = 'pending_edge')
         )
           AND oc2.renderer_credential_ref IS NULL
           AND oc2.scheduled_at <= now()
           AND (oc2.lease_expires_at IS NULL OR oc2.lease_expires_at < now())
         ORDER BY oc2.priority DESC, oc2.scheduled_at
         LIMIT GREATEST(COALESCE(p_batch_size, 10), 1)
         FOR UPDATE SKIP LOCKED
     )
     RETURNING oc.id, oc.call_type, oc.target_type, oc.target_id, oc.method, oc.url, oc.headers, oc.body,
               oc.priority, oc.retry_count, oc.max_retries, oc.correlation_id, oc.shipment_id, oc.context;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_pending_edge_jobs(p_batch INT DEFAULT 10)
RETURNS TABLE (
  job_id UUID,
  dispatch JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_limit INT := GREATEST(COALESCE(p_batch, 10), 1);
  v_candidate RECORD;
  v_optout JSONB;
  v_effective_context JSONB := '{}'::jsonb;
  v_org_text TEXT;
  v_org_id UUID;
  v_spec JSONB;
  v_dispatch JSONB;
  v_error TEXT;
  v_failover_candidate JSONB;
BEGIN
  IF to_regclass('public.outbound_calls') IS NULL THEN
    RETURN;
  END IF;

  FOR v_candidate IN
    SELECT
      oc.id,
      oc.call_type,
      oc.shipment_id,
      oc.context
    FROM public.outbound_calls oc
    WHERE oc.status IN ('pending_edge', 'failed')
      AND oc.renderer_credential_ref IS NULL
      AND oc.scheduled_at <= now()
      AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
      AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries)
    ORDER BY oc.priority DESC, oc.scheduled_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_candidate.call_type = 'provider_api' THEN
      v_failover_candidate := public.resolve_outbound_failover_candidate_v1(
        v_candidate.id,
        'claim_pending_edge_jobs',
        NULL,
        NULL
      );
      IF COALESCE((v_failover_candidate->>'applied')::BOOLEAN, FALSE) THEN
        PERFORM public.apply_outbound_call_failover_v1(
          v_candidate.id,
          v_failover_candidate,
          'claim_pending_edge_jobs',
          NULL
        );
      END IF;
    END IF;

    SELECT COALESCE(oc.context, '{}'::jsonb)
    INTO v_effective_context
    FROM public.outbound_calls oc
    WHERE oc.id = v_candidate.id;

    v_optout := public.should_skip_outbound_call_for_opt_out(
      v_candidate.call_type,
      v_candidate.shipment_id,
      v_effective_context
    );

    IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
      UPDATE public.outbound_calls oc
      SET
        status = 'skipped',
        error_message = COALESCE(v_optout->>'reason', 'skipped'),
        completed_at = now(),
        lease_expires_at = NULL
      WHERE oc.id = v_candidate.id;

      v_org_text := COALESCE(v_effective_context->>'organization_id', '');
      IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        PERFORM public.log_decision(
          p_organization_id := v_org_text::UUID,
          p_decision_category := 'outbound_call',
          p_resource_type := 'outbound_call',
          p_resource_id := v_candidate.id,
          p_decision_point := 'opt_out_enforcement',
          p_decision_outcome := 'skipped',
          p_performed_by_system := 'claim_pending_edge_jobs',
          p_correlation_id := NULL,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'reason', v_optout->>'reason',
            'recipient_id', v_optout->>'recipient_id',
            'channel', v_optout->>'channel'
          )),
          p_decision_reason := 'Outbound call suppressed by opt-out policy.'
        );
      END IF;

      CONTINUE;
    END IF;

    BEGIN
      v_spec := public.get_job_call_spec(v_candidate.id);
    EXCEPTION
      WHEN others THEN
        v_error := SQLERRM;

        UPDATE public.outbound_calls oc
        SET
          status = 'permanently_failed',
          error_message = v_error,
          completed_at = now(),
          lease_expires_at = NULL
        WHERE oc.id = v_candidate.id;

        v_org_id := NULL;
        v_org_text := COALESCE(v_effective_context->>'organization_id', '');
        IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          v_org_id := v_org_text::UUID;
        END IF;

        IF v_org_id IS NOT NULL THEN
          PERFORM public.log_decision(
            p_organization_id := v_org_id,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := v_candidate.id,
            p_decision_point := 'edge_claim_spec',
            p_decision_outcome := 'permanently_failed',
            p_performed_by_system := 'claim_pending_edge_jobs',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
              'call_type', v_candidate.call_type,
              'reason', 'spec_resolution_failed',
              'error', v_error
            )),
            p_decision_reason := 'Edge claim skipped due to invalid job spec (get_job_call_spec failure).'
          );
        END IF;

        CONTINUE;
    END;

    UPDATE public.outbound_calls oc
    SET
      status = 'in_progress_edge',
      lease_expires_at = now() + interval '5 minutes'
    WHERE oc.id = v_candidate.id;

    v_dispatch := jsonb_build_object(
      'url', COALESCE((v_effective_context->'edge_dispatch')->>'url', v_spec->>'url'),
      'method', COALESCE(upper((v_effective_context->'edge_dispatch')->>'method'), upper(v_spec->>'method'), 'POST'),
      'headers', COALESCE((v_effective_context->'edge_dispatch')->'headers', v_spec->'headers', '{}'::jsonb),
      'body', COALESCE((v_effective_context->'edge_dispatch')->'body', v_spec->'body', '{}'::jsonb),
      'timeout_seconds', COALESCE(
        NULLIF((v_effective_context->'edge_dispatch')->>'timeout_seconds', '')::INT,
        NULLIF(v_spec->>'timeout_seconds', '')::INT,
        30
      )
    );

    job_id := v_candidate.id;
    dispatch := v_dispatch;
    RETURN NEXT;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_pending_edge_job_ids_v1(p_batch INT DEFAULT 1)
RETURNS TABLE (job_id UUID, lease_token UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  -- Runtime concurrency is one. Claiming more than one would start lease clocks for
  -- work that cannot execute yet, so the database enforces one claim per call.
  v_limit CONSTANT INT := 1;
  v_lease_interval CONSTANT INTERVAL := interval '12 minutes';
  v_candidate RECORD;
  v_optout JSONB;
  v_effective_context JSONB := '{}'::jsonb;
  v_org_text TEXT;
  v_failover_candidate JSONB;
  v_lease_token UUID;
BEGIN
  IF to_regclass('public.outbound_calls') IS NULL THEN
    RETURN;
  END IF;

  -- Retain p_batch in the signature for compatibility, but fail closed on nonsensical input.
  IF COALESCE(p_batch, 1) < 1 THEN
    RETURN;
  END IF;

  FOR v_candidate IN
    SELECT
      oc.id,
      oc.call_type,
      oc.renderer_credential_ref,
      oc.shipment_id
    FROM public.outbound_calls oc
    WHERE oc.status IN ('pending_edge', 'failed')
      AND oc.scheduled_at <= now()
      AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
      AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries)
    ORDER BY oc.priority DESC, oc.scheduled_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_candidate.call_type = 'provider_api' AND v_candidate.renderer_credential_ref IS NULL THEN
      v_failover_candidate := public.resolve_outbound_failover_candidate_v1(
        v_candidate.id,
        'claim_pending_edge_jobs',
        NULL,
        NULL
      );
      IF COALESCE((v_failover_candidate->>'applied')::BOOLEAN, FALSE) THEN
        PERFORM public.apply_outbound_call_failover_v1(
          v_candidate.id,
          v_failover_candidate,
          'claim_pending_edge_jobs',
          NULL
        );
      END IF;
    END IF;

    SELECT COALESCE(oc.context, '{}'::jsonb)
    INTO v_effective_context
    FROM public.outbound_calls oc
    WHERE oc.id = v_candidate.id;

    v_optout := public.should_skip_outbound_call_for_opt_out(
      v_candidate.call_type,
      v_candidate.shipment_id,
      v_effective_context
    );

    IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
      UPDATE public.outbound_calls oc
      SET
        status = 'skipped',
        error_message = COALESCE(v_optout->>'reason', 'skipped'),
        completed_at = now(),
        lease_expires_at = NULL,
        edge_lease_token = NULL
      WHERE oc.id = v_candidate.id;

      v_org_text := COALESCE(v_effective_context->>'organization_id', '');
      IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        PERFORM public.log_decision(
          p_organization_id := v_org_text::UUID,
          p_decision_category := 'outbound_call',
          p_resource_type := 'outbound_call',
          p_resource_id := v_candidate.id,
          p_decision_point := 'opt_out_enforcement',
          p_decision_outcome := 'skipped',
          p_performed_by_system := 'claim_pending_edge_job_ids_v1',
          p_correlation_id := NULL,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'reason', v_optout->>'reason',
            'recipient_id', v_optout->>'recipient_id',
            'channel', v_optout->>'channel'
          )),
          p_decision_reason := 'Outbound call suppressed by opt-out policy.'
        );
      END IF;
      CONTINUE;
    END IF;

    v_lease_token := gen_random_uuid();
    UPDATE public.outbound_calls oc
    SET
      status = 'in_progress_edge',
      lease_expires_at = now() + v_lease_interval,
      edge_lease_token = v_lease_token
    WHERE oc.id = v_candidate.id;

    job_id := v_candidate.id;
    lease_token := v_lease_token;
    RETURN NEXT;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_claimed_edge_job_call_spec_v1(p_job_id uuid, p_lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_spec JSONB;
  v_error TEXT;
  v_org_text TEXT;
BEGIN
  SELECT oc.call_type, oc.url, oc.body, oc.renderer_credential_ref, COALESCE(oc.context, '{}'::jsonb) AS context
  INTO v_job
  FROM public.outbound_calls oc
  WHERE oc.id = p_job_id
    AND oc.status = 'in_progress_edge'
    AND oc.edge_lease_token = p_lease_token
    AND oc.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'get_claimed_edge_job_call_spec_v1: active lease for job % not found', p_job_id;
  END IF;

  BEGIN
    IF v_job.renderer_credential_ref IS NOT NULL THEN
      v_spec := public.resolve_label_renderer_edge_config_v1(NULLIF(v_job.context->>'organization_id', '')::uuid);
      IF v_spec->>'state' <> 'ready'
         OR v_spec->>'url' IS DISTINCT FROM v_job.url
         OR (v_spec->>'renderer_credential_ref')::uuid IS DISTINCT FROM v_job.renderer_credential_ref THEN
        RAISE EXCEPTION 'label_renderer_configuration_changed';
      END IF;
      RETURN jsonb_build_object(
        'url', v_job.url, 'method', 'POST', 'body', v_job.body, 'headers', '{}'::jsonb,
        'timeout_seconds', v_spec->'timeout_seconds',
        'renderer_credential_ref', v_job.renderer_credential_ref
      );
    END IF;
    v_spec := public.get_job_call_spec(p_job_id);
    v_spec := v_spec || jsonb_build_object(
      'url', COALESCE(v_job.context #>> '{edge_dispatch,url}', v_spec->>'url'),
      'headers', public.outbound_dispatch_headers_v1(
        COALESCE(v_job.context #>> '{edge_dispatch,url}', v_spec->>'url'),
        COALESCE(v_job.context #> '{edge_dispatch,headers}', v_spec->'headers'),
        p_job_id
      )
    );
  EXCEPTION
    WHEN others THEN
      v_error := SQLERRM;
      UPDATE public.outbound_calls oc
      SET
        status = 'permanently_failed',
        error_message = v_error,
        completed_at = now(),
        lease_expires_at = NULL,
        edge_lease_token = NULL
      WHERE oc.id = p_job_id
        AND oc.status = 'in_progress_edge'
        AND oc.edge_lease_token = p_lease_token
        AND oc.lease_expires_at > now();

      IF NOT FOUND THEN
        RAISE EXCEPTION 'get_claimed_edge_job_call_spec_v1: lease for job % changed during spec resolution', p_job_id;
      END IF;

      v_org_text := COALESCE(v_job.context->>'organization_id', '');
      IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        BEGIN
          PERFORM public.log_decision(
            p_organization_id := v_org_text::UUID,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'edge_claim_spec',
            p_decision_outcome := 'permanently_failed',
            p_performed_by_system := 'get_claimed_edge_job_call_spec_v1',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
              'call_type', v_job.call_type,
              'reason', 'spec_resolution_failed',
              'error', v_error
            )),
            p_decision_reason := 'Claimed Edge job has an invalid call specification.'
          );
        EXCEPTION WHEN OTHERS THEN
          IF v_error <> 'outbound_url_invalid' THEN
            RAISE;
          END IF;
          -- Preserve the terminal URL rejection if its audit insert fails.
          RAISE WARNING 'outbound_edge_claim_spec_audit_failed';
        END;
      END IF;
      RETURN NULL;
  END;

  RETURN jsonb_build_object(
    'url', v_spec->>'url',
    'method', COALESCE(upper((v_job.context->'edge_dispatch')->>'method'), upper(v_spec->>'method'), 'POST'),
    'headers', v_spec->'headers',
    'body', COALESCE((v_job.context->'edge_dispatch')->'body', v_spec->'body', '{}'::jsonb),
    'timeout_seconds', COALESCE(
      NULLIF((v_job.context->'edge_dispatch')->>'timeout_seconds', '')::INT,
      NULLIF(v_spec->>'timeout_seconds', '')::INT,
      30
    )
  ) || CASE WHEN v_spec->>'url' COLLATE "C" ~* '^http://' THEN
    jsonb_build_object('http_allowed_host',
      substring(lower((v_spec->>'url') COLLATE "C") FROM '^http://([a-z0-9.-]+)'))
  ELSE '{}'::jsonb END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_claimed_edge_job_success_v1(
  p_job_id UUID,
  p_lease_token UUID,
  p_status_code INT,
  p_headers JSONB,
  p_body JSONB,
  p_latency_ms INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  PERFORM 1
  FROM public.outbound_calls oc
  WHERE oc.id = p_job_id
    AND oc.status = 'in_progress_edge'
    AND oc.edge_lease_token = p_lease_token
    AND oc.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_claimed_edge_job_success_v1: active lease for job % not found', p_job_id;
  END IF;

  UPDATE public.outbound_calls
     SET status = 'completed',
         response_status_code = p_status_code,
         response_headers = public.redact_sensitive_headers(COALESCE(p_headers, '{}'::jsonb)),
         response_body = p_body,
         latency_ms = p_latency_ms,
         completed_at = now(),
         lease_expires_at = NULL,
         edge_lease_token = NULL
   WHERE id = p_job_id AND renderer_credential_ref IS NOT NULL;
  IF FOUND THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM public.log_api_call_event(p_job_id, '{}'::jsonb,
      jsonb_build_object('headers', p_headers, 'body', p_body), p_status_code, p_latency_ms);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'outbound_api_audit_failed';
  END;

  PERFORM public.mark_outbound_call_success(
    p_job_id,
    p_status_code,
    p_headers,
    p_body,
    p_latency_ms
  );
END;
$function$;

CREATE FUNCTION public.mark_claimed_edge_job_failure_v1(
  p_job_id UUID,
  p_lease_token UUID,
  p_status_code INT,
  p_headers JSONB,
  p_body JSONB,
  p_error TEXT,
  p_latency_ms INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  PERFORM 1
  FROM public.outbound_calls oc
  WHERE oc.id = p_job_id
    AND oc.status = 'in_progress_edge'
    AND oc.edge_lease_token = p_lease_token
    AND oc.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_claimed_edge_job_failure_v1: active lease for job % not found', p_job_id;
  END IF;

  UPDATE public.outbound_calls
     SET status = 'permanently_failed',
         response_status_code = p_status_code,
         response_headers = public.redact_sensitive_headers(COALESCE(p_headers, '{}'::jsonb)),
         response_body = p_body,
         error_message = COALESCE(p_error, 'label_renderer_dispatch_failed'),
         completed_at = now(),
         lease_expires_at = NULL,
         edge_lease_token = NULL
   WHERE id = p_job_id AND renderer_credential_ref IS NOT NULL;
  IF FOUND THEN
    RETURN;
  END IF;

  -- The failure policy may retarget the canonical request before scheduling a retry.
  BEGIN
    PERFORM public.log_api_call_event(p_job_id, '{}'::jsonb,
      jsonb_build_object('headers', p_headers, 'body', p_body), p_status_code, p_latency_ms, 'outbound_call_failed');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'outbound_api_audit_failed';
  END;

  PERFORM public.mark_outbound_call_failure(
    p_job_id,
    p_status_code,
    p_headers,
    p_body,
    p_error
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_claimed_edge_job_failure_v1(
  p_job_id UUID, p_lease_token UUID, p_status_code INT, p_headers JSONB, p_body JSONB, p_error TEXT
)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
  SELECT public.mark_claimed_edge_job_failure_v1(p_job_id, p_lease_token, p_status_code, p_headers, p_body, p_error, NULL);
$function$;

CREATE FUNCTION api.mark_claimed_edge_job_failure_v1(
  p_job_id UUID, p_lease_token UUID, p_status_code INT, p_headers JSONB, p_body JSONB, p_error TEXT, p_latency_ms INT
)
RETURNS VOID
LANGUAGE sql
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.mark_claimed_edge_job_failure_v1(p_job_id, p_lease_token, p_status_code, p_headers, p_body, p_error, p_latency_ms);
$function$;

REVOKE ALL ON FUNCTION public.mark_claimed_edge_job_failure_v1(uuid, uuid, int, jsonb, jsonb, text, int),
  api.mark_claimed_edge_job_failure_v1(uuid, uuid, int, jsonb, jsonb, text, int) FROM PUBLIC, anon, authenticated, ui_rpc_executor;
GRANT EXECUTE ON FUNCTION public.mark_claimed_edge_job_failure_v1(uuid, uuid, int, jsonb, jsonb, text, int),
  api.mark_claimed_edge_job_failure_v1(uuid, uuid, int, jsonb, jsonb, text, int) TO service_role, edge_api_caller_role;

CREATE OR REPLACE FUNCTION public.ops_sweeper_label_renderer_cron_guard(p_task JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_schedule TEXT;
  v_batch_size INT;
  v_command TEXT;
  v_action TEXT := NULL;

  v_cron RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'pg_cron_not_installed');
  END IF;

  IF public.resolve_label_renderer_edge_config_v1(NULL)->>'state' <> 'ready' THEN
    UPDATE public.cron_config
       SET enabled = FALSE,
           notes = 'Auto-dispatch label renderer via invoke_label_renderer(); enable after invoke_url/invoke_secret rotated'
     WHERE worker_name = 'label_job_renderer';

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'label_renderer_dispatch') THEN
      PERFORM cron.unschedule('label_renderer_dispatch');
      v_action := 'unscheduled';
    ELSE
      v_action := 'already_unscheduled';
    END IF;

    RETURN jsonb_build_object(
      'status', 'disabled',
      'reason', 'label_provider_invoke_configuration_placeholder',
      'action', v_action
    );
  END IF;

  IF to_regprocedure('public.invoke_label_renderer(integer,jsonb)') IS NULL THEN
    UPDATE public.cron_config
       SET enabled = FALSE,
           notes = 'Auto-dispatch label renderer disabled: invoke_label_renderer(int) missing'
     WHERE worker_name = 'label_job_renderer';

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'label_renderer_dispatch') THEN
      PERFORM cron.unschedule('label_renderer_dispatch');
      v_action := 'unscheduled';
    ELSE
      v_action := 'already_unscheduled';
    END IF;

    RETURN jsonb_build_object(
      'status', 'disabled',
      'reason', 'invoke_label_renderer_missing',
      'action', v_action
    );
  END IF;

  UPDATE public.cron_config
     SET enabled = TRUE,
         notes = 'Auto-dispatch label renderer via invoke_label_renderer(); enabled (invoke configuration present)'
   WHERE worker_name = 'label_job_renderer';

  SELECT wr.schedule
    INTO v_schedule
    FROM public.worker_registry wr
   WHERE wr.worker_name = 'label_job_renderer'
   LIMIT 1;

  v_schedule := COALESCE(NULLIF(btrim(v_schedule), ''), '*/1 * * * *');

  SELECT c.batch_size
    INTO v_batch_size
    FROM public.cron_config c
   WHERE c.worker_name = 'label_job_renderer'
   LIMIT 1;

  v_batch_size := GREATEST(COALESCE(v_batch_size, 10), 1);
  v_command := format($cron$
    SELECT public.invoke_label_renderer(%s,NULL::jsonb)
    WHERE EXISTS (
      SELECT 1 FROM public.label_jobs lj
      LEFT JOIN LATERAL public.resolve_settings_row_from_context('label_print_policy',
        jsonb_strip_nulls(jsonb_build_object('organization_id', lj.organization_id, 'client_id', lj.client_id))) policy
        ON lj.requested_source = 'label_print_sync'
      WHERE lj.status = 'pending' AND lj.scheduled_at <= now() AND lj.attempts < lj.max_attempts
        AND (lj.requested_source IS DISTINCT FROM 'label_print_sync'
          OR lj.created_at <= now() - make_interval(secs => GREATEST(
            COALESCE(NULLIF(policy.value->>'print_sync_worker_grace_seconds', '')::integer, 0), 0)))
    );$cron$, v_batch_size);

  SELECT j.jobid, j.schedule, j.command
    INTO v_cron
    FROM cron.job j
   WHERE j.jobname = 'label_renderer_dispatch'
   LIMIT 1;

  IF FOUND THEN
    IF COALESCE(v_cron.schedule, '') = v_schedule
       AND COALESCE(v_cron.command, '') = v_command THEN
      v_action := 'unchanged';
    ELSE
      PERFORM cron.unschedule('label_renderer_dispatch');
      PERFORM cron.schedule('label_renderer_dispatch', v_schedule, v_command);
      v_action := 'updated';
    END IF;
  ELSE
    PERFORM cron.schedule('label_renderer_dispatch', v_schedule, v_command);
    v_action := 'created';
  END IF;

  RETURN jsonb_build_object(
    'status', 'enabled',
    'action', v_action,
    'schedule', v_schedule,
    'command', v_command
  );
END;
$$;


COMMENT ON FUNCTION public.invoke_label_renderer(integer, jsonb)
  IS 'Queue the tenant-scoped renderer in Edge so its callback can run after commit.';
COMMENT ON FUNCTION public.invoke_label_renderer_print_sync_v1(uuid, uuid, jsonb)
  IS 'Queue a renderer print request with owning-workflow payload and async readback.';
COMMENT ON FUNCTION public.check_async_response(bigint)
  IS 'Read a renderer Edge receipt or an existing pg_net request result.';



CREATE FUNCTION public.fail_sql_outbound_credential_job_v1(p_job_id uuid, p_executor text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
BEGIN
  UPDATE public.outbound_calls
     SET status = 'permanently_failed',
         error_message = 'outbound_credential_headers_refused',
         completed_at = now(),
         lease_expires_at = NULL,
         edge_lease_token = NULL,
         context = context - 'edge_dispatch' - 'async_request_id'
   WHERE id = p_job_id;
  BEGIN
    PERFORM public.finalize_outbound_workflow_step_v1(p_job_id, p_executor);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'outbound_credential_refusal_workflow_finalization_failed';
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.fail_sql_outbound_credential_job_v1(uuid, text) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;

CREATE OR REPLACE FUNCTION public.run_outbound_worker()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_job RECORD;
    v_org UUID;
    v_spec JSONB;
    v_dispatch_headers JSONB;
    v_result JSONB;
    v_status INT;
    v_completed BOOLEAN;
    v_optout JSONB;
    v_async_request_id BIGINT := NULL;
    v_poll JSONB := NULL;
    v_policy_row RECORD;
    v_policy_ctx JSONB;
    v_defaults JSONB;
    v_poll_seconds INT := NULL;
    v_poll_min INT := NULL;
    v_poll_max INT := NULL;
    v_settings_resolution_id UUID := NULL;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_settings_version_id UUID;
    v_policy_version INT;
    v_scope_path JSONB;
BEGIN
    SELECT * INTO v_throttle FROM public.check_throttle('outbound_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := public.create_request_context('outbound_worker');

    FOR v_job IN SELECT oc.workflow_run_step_id, cpj.* FROM public.claim_pending_jobs(v_throttle.batch_size) cpj JOIN public.outbound_calls oc ON oc.id = cpj.job_id
    LOOP
        BEGIN
            IF v_job.target_type = 'provider' THEN
                v_org := public.resolve_organization_id_strict('provider', v_job.target_id);
            ELSIF v_job.target_type = 'client' THEN
                v_org := public.resolve_organization_id_strict('client', v_job.target_id);
            ELSIF v_job.shipment_id IS NOT NULL THEN
                v_org := public.resolve_organization_id_strict('shipment', v_job.shipment_id);
            ELSE
                v_org := public.resolve_organization_id_strict('outbound_call', v_job.job_id);
            END IF;

            v_policy_ctx := NULL;
            v_policy_row := NULL;
            v_defaults := NULL;
            v_poll_seconds := NULL;
            v_poll_min := NULL;
            v_poll_max := NULL;
            v_settings_resolution_id := NULL;
            v_scope_path := NULL;

            IF v_job.workflow_run_step_id IS NOT NULL THEN
                SELECT r.context
                  INTO v_policy_ctx
                  FROM public.workflow_run_steps s
                  JOIN public.workflow_runs r ON r.id = s.workflow_run_id
                 WHERE s.id = v_job.workflow_run_step_id;
            END IF;

            v_policy_ctx := jsonb_strip_nulls(
              COALESCE(v_policy_ctx, v_job.context, '{}'::jsonb) || jsonb_build_object('organization_id', v_org)
            );

            SELECT *
              INTO v_policy_row
              FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
             LIMIT 1;

            IF NOT FOUND OR v_policy_row.value IS NULL THEN
                SELECT *
                  INTO v_policy_row
                  FROM public.resolve_settings_row('workflow_defaults', 'global', NULL)
                 LIMIT 1;
            END IF;

            v_defaults := v_policy_row.value;
            IF v_defaults IS NULL THEN
                RAISE EXCEPTION 'workflow_defaults_missing';
            END IF;

            v_policy_scope_type := v_policy_row.scope_type;
            v_policy_scope_id := v_policy_row.scope_id;
            v_policy_settings_id := v_policy_row.settings_id;
            v_policy_settings_version_id := v_policy_row.settings_version_id;
            v_policy_version := v_policy_row.version;
            v_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb);

            v_settings_resolution_id := public.log_settings_resolution(
                p_organization_id := v_org,
                p_category := 'workflow_defaults',
                p_winning_scope_type := v_policy_scope_type,
                p_winning_scope_id := v_policy_scope_id,
                p_winning_settings_id := v_policy_settings_id,
                p_winning_settings_version_id := v_policy_settings_version_id,
                p_winning_version := v_policy_version,
                p_scope_path := v_scope_path,
                p_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'job_id', v_job.job_id,
                    'call_type', v_job.call_type,
                    'target_type', v_job.target_type,
                    'target_id', v_job.target_id
                )),
                p_merge_notes := jsonb_build_object('source', 'run_outbound_worker')
            );

            BEGIN
                v_poll_seconds := NULLIF(v_defaults->>'outbound_poll_seconds', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_seconds := NULL;
            END;
            IF v_poll_seconds IS NULL THEN
                BEGIN
                    v_poll_seconds := NULLIF(v_defaults->>'poll_seconds', '')::INT;
                EXCEPTION
                    WHEN others THEN
                        v_poll_seconds := NULL;
                END;
            END IF;
            IF v_poll_seconds IS NULL THEN
                RAISE EXCEPTION 'workflow_defaults.poll_seconds missing';
            END IF;

            BEGIN
                v_poll_min := NULLIF(v_defaults->>'poll_seconds_min', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_min := NULL;
            END;
            BEGIN
                v_poll_max := NULLIF(v_defaults->>'poll_seconds_max', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_max := NULL;
            END;

            v_poll_min := COALESCE(v_poll_min, v_poll_seconds);
            v_poll_max := COALESCE(v_poll_max, v_poll_seconds);
            v_poll_seconds := LEAST(GREATEST(v_poll_seconds, v_poll_min), v_poll_max);

            v_optout := public.should_skip_outbound_call_for_opt_out(
              v_job.call_type,
              v_job.shipment_id,
              COALESCE(v_job.context, '{}'::jsonb)
            );
            IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
                UPDATE public.outbound_calls
                   SET status = 'skipped',
                       completed_at = now(),
                       lease_expires_at = NULL,
                       error_message = COALESCE(v_optout->>'reason', 'skipped')
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'opt_out',
                    p_decision_outcome := 'skipped',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := v_optout,
                    p_decision_reason := v_optout->>'reason',
                    p_settings_resolution_id := v_settings_resolution_id
                );

                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;
            v_async_request_id := NULL;
            BEGIN
                v_async_request_id := NULLIF(v_job.context->>'async_request_id', '')::BIGINT;
            EXCEPTION
                WHEN others THEN
                    v_async_request_id := NULL;
            END;

            IF v_async_request_id IS NOT NULL THEN
                v_poll := public.check_async_response(v_async_request_id);
                v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
                v_status := COALESCE((v_poll->>'status')::INT, 0);

                IF NOT v_completed THEN
                    UPDATE public.outbound_calls
                       SET status = 'pending',
                           scheduled_at = now() + make_interval(secs => v_poll_seconds),
                           lease_expires_at = NULL
                     WHERE id = v_job.job_id;

                    PERFORM public.log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'async_pending',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_inputs := jsonb_build_object(
                          'async_request_id', v_async_request_id,
                          'poll', v_poll,
                          'poll_seconds', v_poll_seconds
                        ),
                        p_decision_reason := 'Awaiting async HTTP response (polling pg_net).',
                        p_settings_resolution_id := v_settings_resolution_id
                    );

                    v_items_processed := v_items_processed + 1;
                    CONTINUE;
                END IF;

                IF v_completed AND v_status BETWEEN 200 AND 299 THEN
                    UPDATE public.outbound_calls
                       SET status = 'completed',
                           response_status_code = v_status,
                           response_body = v_poll->'body',
                           response_headers = v_poll->'headers',
                           completed_at = now(),
                           error_message = NULL,
                           lease_expires_at = NULL,
                           context = (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id' - 'edge_dispatch')
                     WHERE id = v_job.job_id;

                    -- Response processing failures should not flip delivery state or trigger resends.
                    BEGIN
                      PERFORM public.orchestrate_api_response_processing(v_job.job_id);
                    EXCEPTION
                      WHEN OTHERS THEN
                        v_error := TRUE;
                        UPDATE public.outbound_calls
                           SET requires_investigation = TRUE,
                               root_cause = 'response_processing_exception',
                               resolution_notes = SQLERRM
                         WHERE id = v_job.job_id;

                        PERFORM public.log_decision(
                          p_organization_id := v_org,
                          p_decision_category := 'outbound_call',
                          p_resource_type := 'outbound_call',
                          p_resource_id := v_job.job_id,
                          p_decision_point := 'response_processing',
                          p_decision_outcome := 'exception',
                          p_performed_by_system := 'outbound_worker',
                          p_correlation_id := v_job.correlation_id,
                          p_decision_reason := SQLERRM
                        );
                    END;

                    -- F267 audit begin
                    BEGIN
                        PERFORM public.log_api_call_event(
                            v_job.job_id, '{}'::jsonb,
                            jsonb_build_object('headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                                               'body', COALESCE(v_poll->'body', '{}'::jsonb)),
                            v_status, NULL, NULL
                        );
                    EXCEPTION
                        WHEN OTHERS THEN
                            -- Audit failure must not undo a delivered request or schedule a resend.
                            RAISE WARNING 'outbound_api_audit_failed';
                    END;
                    -- F267 audit end

                    PERFORM public.log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'success',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_inputs := jsonb_build_object(
                          'status', v_status,
                          'async_request_id', v_async_request_id
                        ),
                        p_decision_reason := 'Outbound HTTP request completed successfully.'
                    );

                    BEGIN
                      PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                    EXCEPTION
                      WHEN OTHERS THEN
                        NULL;
                    END;
                ELSE
                    -- F267 audit begin
                    BEGIN
                        PERFORM public.log_api_call_event(
                            v_job.job_id, '{}'::jsonb,
                            jsonb_build_object('headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                                               'body', COALESCE(v_poll->'body', '{}'::jsonb)),
                            v_status, NULL, 'outbound_call_failed'
                        );
                    EXCEPTION
                        WHEN OTHERS THEN
                            -- Audit failure must not undo a delivered request or schedule a resend.
                            RAISE WARNING 'outbound_api_audit_failed';
                    END;
                    -- F267 audit end

                    PERFORM public.mark_outbound_call_failure_v2(
                      p_job_id := v_job.job_id,
                      p_status_code := v_status,
                      p_headers := COALESCE(v_poll->'headers', '{}'::jsonb),
                      p_body := COALESCE(v_poll->'body', '{}'::jsonb),
                      p_error := COALESCE(v_poll->'body'->>'error', format('HTTP %s failure', v_status)),
                      p_performed_by_system := 'outbound_worker',
                      p_correlation_id := v_job.correlation_id
                    );


                    BEGIN
                      PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                    EXCEPTION
                      WHEN OTHERS THEN
                        NULL;
                    END;
                END IF;

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

            -- First attempt: build call spec and dispatch via call_api (pg_net).
            v_spec := public.get_job_call_spec(v_job.job_id);
            BEGIN
                v_dispatch_headers := public.outbound_dispatch_headers_v1(v_spec->>'url', v_spec->'headers', v_job.job_id);
            EXCEPTION
                WHEN invalid_parameter_value THEN
                    IF SQLERRM <> 'outbound_url_invalid' THEN
                        RAISE;
                    END IF;
                    PERFORM public.mark_outbound_url_invalid_v1(v_job.job_id, 'outbound_worker');
                    v_error := TRUE;
                    v_items_processed := v_items_processed + 1;
                    CONTINUE;
            END;
            BEGIN
              -- Check the original spec before any application header filter can hide a credential.
              PERFORM public.sql_transport_headers_v1(v_spec->'headers');
            EXCEPTION WHEN invalid_parameter_value THEN
              IF SQLERRM <> 'outbound_credential_headers_refused' THEN RAISE; END IF;
                PERFORM public.fail_sql_outbound_credential_job_v1(v_job.job_id, 'outbound_worker');
                v_error := TRUE;
                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END;
            v_result := public.call_api(
                v_spec->>'url',
                COALESCE(v_spec->>'method', 'POST'),
                v_dispatch_headers,
                COALESCE(v_spec->'body', '{}'::jsonb),
                NULL
            );

            v_status := COALESCE((v_result->>'status')::INT, 0);
            v_completed := COALESCE((v_result->>'completed')::BOOLEAN, FALSE);

            IF v_result ? 'edge_dispatch' THEN
                UPDATE public.outbound_calls
                   SET status = 'pending_edge',
                       scheduled_at = now(),
                       lease_expires_at = NULL,
                       context = jsonb_set(
                           (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id'),
                           '{edge_dispatch}',
                           v_result->'edge_dispatch',
                           TRUE
                       )
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'async_pending',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := v_result->'edge_dispatch',
                    p_decision_reason := 'Edge dispatch required for outbound HTTP execution.',
                    p_settings_resolution_id := v_settings_resolution_id
                );

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

            IF v_completed AND v_status BETWEEN 200 AND 299 THEN
                UPDATE public.outbound_calls
                   SET status = 'completed',
                       response_status_code = v_status,
                       response_body = v_result->'body',
                       response_headers = v_result->'headers',
                       latency_ms = NULLIF(v_result->>'latency_ms', '')::INT,
                       completed_at = now(),
                       error_message = NULL,
                       lease_expires_at = NULL,
                       context = (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id' - 'edge_dispatch')
                 WHERE id = v_job.job_id;

                -- Response processing failures should not flip delivery state or trigger resends.
                BEGIN
                  PERFORM public.orchestrate_api_response_processing(v_job.job_id);
                EXCEPTION
                  WHEN OTHERS THEN
                    v_error := TRUE;
                    UPDATE public.outbound_calls
                       SET requires_investigation = TRUE,
                           root_cause = 'response_processing_exception',
                           resolution_notes = SQLERRM
                     WHERE id = v_job.job_id;

                    PERFORM public.log_decision(
                      p_organization_id := v_org,
                      p_decision_category := 'outbound_call',
                      p_resource_type := 'outbound_call',
                      p_resource_id := v_job.job_id,
                      p_decision_point := 'response_processing',
                      p_decision_outcome := 'exception',
                      p_performed_by_system := 'outbound_worker',
                      p_correlation_id := v_job.correlation_id,
                      p_decision_reason := SQLERRM
                    );
                END;

                -- F267 audit begin
                BEGIN
                    PERFORM public.log_api_call_event(
                        v_job.job_id, '{}'::jsonb,
                        jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                           'body', COALESCE(v_result->'body', '{}'::jsonb)),
                        v_status, NULL, NULL
                    );
                EXCEPTION
                    WHEN OTHERS THEN
                        -- Audit failure must not undo a delivered request or schedule a resend.
                        RAISE WARNING 'outbound_api_audit_failed';
                END;
                -- F267 audit end

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'success',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := jsonb_build_object(
                      'status', v_status,
                      'async_request_id', v_async_request_id
                    ),
                    p_decision_reason := 'Outbound HTTP request completed successfully.'
                );

                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;
            ELSIF v_completed THEN
                -- F267 audit begin
                BEGIN
                    PERFORM public.log_api_call_event(
                        v_job.job_id, '{}'::jsonb,
                        jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                           'body', COALESCE(v_result->'body', '{}'::jsonb)),
                        v_status, NULL, 'outbound_call_failed'
                    );
                EXCEPTION
                    WHEN OTHERS THEN
                        -- Audit failure must not undo a delivered request or schedule a resend.
                        RAISE WARNING 'outbound_api_audit_failed';
                END;
                -- F267 audit end

                PERFORM public.mark_outbound_call_failure_v2(
                  p_job_id := v_job.job_id,
                  p_status_code := v_status,
                  p_headers := COALESCE(v_result->'headers', '{}'::jsonb),
                  p_body := COALESCE(v_result->'body', '{}'::jsonb),
                  p_error := COALESCE(v_result->'body'->>'error', format('HTTP %s failure', v_status)),
                  p_performed_by_system := 'outbound_worker',
                  p_correlation_id := v_job.correlation_id
                );


                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;
            ELSE
                UPDATE public.outbound_calls
                   SET status = 'pending',
                       scheduled_at = now() + make_interval(secs => v_poll_seconds),
                       lease_expires_at = NULL,
                       context = CASE
                           WHEN v_result ? 'request_id' THEN
                               jsonb_set(
                                   COALESCE(public.outbound_calls.context, '{}'::jsonb),
                                   '{async_request_id}',
                                   to_jsonb(v_result->>'request_id'),
                                   TRUE
                               )
                           ELSE public.outbound_calls.context
                       END
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'async_pending',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := COALESCE(v_result, '{}'::jsonb) || jsonb_build_object('poll_seconds', v_poll_seconds),
                    p_decision_reason := 'HTTP request accepted asynchronously; awaiting polling.',
                    p_settings_resolution_id := v_settings_resolution_id
                );
            END IF;

            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;

                BEGIN
                  PERFORM public.mark_outbound_call_failure_v2(
                    p_job_id := v_job.job_id,
                    p_status_code := 0,
                    p_headers := '{}'::jsonb,
                    p_body := '{}'::jsonb,
                    p_error := format('exception: %s', SQLERRM),
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id
                  );

                  BEGIN
                    PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                  EXCEPTION
                    WHEN OTHERS THEN
                      NULL;
                  END;
                EXCEPTION
                  WHEN OTHERS THEN
                    UPDATE public.outbound_calls
                       SET status = 'permanently_failed',
                           retry_count = v_job.retry_count + 1,
                           error_message = SQLERRM,
                           completed_at = now(),
                           lease_expires_at = NULL
                     WHERE id = v_job.job_id;
                END;
        END;
    END LOOP;

    PERFORM public.complete_request_context(v_context, v_error, v_items_processed);
    PERFORM public.update_cron_config('outbound_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.dispatch_outbound_call_inline(p_job_id uuid, p_options jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_org UUID;
    v_optout JSONB;
    v_spec JSONB;
    v_dispatch_headers JSONB;
    v_result JSONB := NULL;
    v_status INT := 0;
    v_completed BOOLEAN := FALSE;
    v_request_id BIGINT := NULL;
    v_poll JSONB := NULL;
    v_started_at TIMESTAMPTZ := clock_timestamp();
    v_deadline TIMESTAMPTZ := NULL;
    v_latency_ms INT := NULL;

    -- Options (strict; no behavioral defaults in code)
    v_timeout_seconds INT := NULL;
    v_poll_max_seconds INT := NULL;
    v_poll_interval_ms INT := NULL;
    v_pending_reschedule_seconds INT := NULL;
    v_lease_seconds INT := NULL;
    v_performed_by_system TEXT := NULL;
    v_correlation_id UUID := NULL;
    v_sleep_seconds DOUBLE PRECISION := NULL;

    v_error TEXT := NULL;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN jsonb_build_object('status', 'skipped', 'reason', 'outbound_calls_missing');
    END IF;

    IF p_job_id IS NULL THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'job_id_missing');
    END IF;

    -- Parse options. Thresholds/timeouts are policy-driven; caller must provide.
    v_timeout_seconds := NULLIF(p_options->>'timeout_seconds', '')::INT;
    v_poll_max_seconds := NULLIF(p_options->>'poll_max_seconds', '')::INT;
    v_poll_interval_ms := NULLIF(p_options->>'poll_interval_ms', '')::INT;
    v_pending_reschedule_seconds := NULLIF(p_options->>'pending_reschedule_seconds', '')::INT;
    v_lease_seconds := NULLIF(p_options->>'lease_seconds', '')::INT;

    v_performed_by_system := NULLIF(p_options->>'performed_by_system', '');
    IF v_performed_by_system IS NULL THEN
        v_performed_by_system := 'dispatch_outbound_call_inline';
    END IF;

    BEGIN
        v_correlation_id := NULLIF(p_options->>'correlation_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_correlation_id := NULL;
    END;

    IF v_timeout_seconds IS NULL OR v_timeout_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_timeout_missing_or_invalid';
    END IF;
    IF v_poll_max_seconds IS NULL OR v_poll_max_seconds < 0 THEN
        RAISE EXCEPTION 'inline_dispatch_poll_max_missing_or_invalid';
    END IF;
    IF v_poll_interval_ms IS NULL OR v_poll_interval_ms <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_poll_interval_missing_or_invalid';
    END IF;
    IF v_pending_reschedule_seconds IS NULL OR v_pending_reschedule_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_reschedule_missing_or_invalid';
    END IF;
    IF v_lease_seconds IS NULL OR v_lease_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_lease_missing_or_invalid';
    END IF;

    v_sleep_seconds := GREATEST(v_poll_interval_ms, 10)::DOUBLE PRECISION / 1000.0;

    SELECT *
      INTO v_job
      FROM public.outbound_calls
     WHERE id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'job_not_found', 'job_id', p_job_id);
    END IF;

    -- Only dispatch queued jobs; completed/skipped etc are no-ops.
    IF v_job.renderer_credential_ref IS NOT NULL OR v_job.status NOT IN ('pending', 'failed') THEN
        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', 'job_not_dispatchable',
            'job_id', p_job_id,
            'job_status', v_job.status
        );
    END IF;

    -- Respect due time (no early sends).
    IF v_job.scheduled_at IS NOT NULL AND v_job.scheduled_at > now() THEN
        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', 'job_not_due',
            'job_id', p_job_id,
            'scheduled_at', v_job.scheduled_at
        );
    END IF;

    -- Acquire a short lease so cron workers don't concurrently dispatch this job.
    UPDATE public.outbound_calls
       SET lease_expires_at = now() + make_interval(secs => v_lease_seconds)
     WHERE id = p_job_id;

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    v_optout := public.should_skip_outbound_call_for_opt_out(
        v_job.call_type,
        v_job.shipment_id,
        COALESCE(v_job.context, '{}'::jsonb)
    );

    IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
        UPDATE public.outbound_calls
           SET status = 'skipped',
               error_message = COALESCE(v_optout->>'reason', 'skipped'),
               completed_at = now(),
               lease_expires_at = NULL
         WHERE id = p_job_id;

        PERFORM public.log_decision(
            p_organization_id := v_org,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'opt_out',
            p_decision_outcome := 'skipped',
            p_performed_by_system := v_performed_by_system,
            p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
            p_decision_inputs := v_optout,
            p_decision_reason := v_optout->>'reason'
        );

        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', v_optout->>'reason',
            'job_id', p_job_id
        );
    END IF;

    -- If an async pg_net request_id already exists, poll it first (avoid duplicate sends).
    BEGIN
        v_request_id := NULLIF(v_job.context->>'async_request_id', '')::BIGINT;
    EXCEPTION
        WHEN others THEN
            v_request_id := NULL;
    END;

    IF v_request_id IS NOT NULL THEN
        v_poll := public.check_async_response(v_request_id);
        v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
        v_status := COALESCE((v_poll->>'status')::INT, 0);

        IF v_completed THEN
            v_result := jsonb_build_object(
                'status', v_status,
                'headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                'body', COALESCE(v_poll->'body', '{}'::jsonb),
                'completed', TRUE,
                'request_id', v_request_id
            );
        END IF;
    END IF;

    IF NOT v_completed AND v_request_id IS NULL THEN
        -- Dispatch a new HTTP request and optionally wait within the policy budget.
        v_spec := public.get_job_call_spec(p_job_id);
        BEGIN
            v_dispatch_headers := public.outbound_dispatch_headers_v1(v_spec->>'url', v_spec->'headers', p_job_id);
        EXCEPTION
            WHEN invalid_parameter_value THEN
                IF SQLERRM <> 'outbound_url_invalid' THEN
                    RAISE;
                END IF;
                PERFORM public.mark_outbound_url_invalid_v1(p_job_id, v_performed_by_system);
                RETURN jsonb_build_object('status', 'failed', 'job_id', p_job_id, 'reason', 'outbound_url_invalid');
        END;
        BEGIN
          -- Check the original spec before any application header filter can hide a credential.
          PERFORM public.sql_transport_headers_v1(v_spec->'headers');
        EXCEPTION WHEN invalid_parameter_value THEN
          IF SQLERRM <> 'outbound_credential_headers_refused' THEN RAISE; END IF;
            PERFORM public.fail_sql_outbound_credential_job_v1(p_job_id, v_performed_by_system);
            RETURN jsonb_build_object('status', 'failed', 'job_id', p_job_id, 'reason', 'outbound_credential_headers_refused');
        END;
        v_result := public.call_api(
            v_spec->>'url',
            COALESCE(v_spec->>'method', 'POST'),
            v_dispatch_headers,
            COALESCE(v_spec->'body', '{}'::jsonb),
            v_timeout_seconds
        );

        v_status := COALESCE((v_result->>'status')::INT, 0);
        v_completed := COALESCE((v_result->>'completed')::BOOLEAN, FALSE);

        IF v_result ? 'edge_dispatch' THEN
            UPDATE public.outbound_calls
               SET status = 'pending_edge', scheduled_at = now(), lease_expires_at = NULL,
                   context = jsonb_set(COALESCE(context, '{}'::jsonb) - 'async_request_id',
                     '{edge_dispatch}', v_result->'edge_dispatch', true)
             WHERE id = p_job_id;
            RETURN jsonb_build_object('status', 'pending', 'job_id', p_job_id,
                'http_status', v_status, 'completed', FALSE);
        END IF;

        IF NOT v_completed THEN
            BEGIN
                v_request_id := NULLIF(v_result->>'request_id', '')::BIGINT;
            EXCEPTION
                WHEN others THEN
                    v_request_id := NULL;
            END;

            IF v_request_id IS NOT NULL THEN
                UPDATE public.outbound_calls
                   SET context = jsonb_set(
                       COALESCE(context, '{}'::jsonb),
                       '{async_request_id}',
                       to_jsonb(v_request_id),
                       TRUE
                   )
                 WHERE id = p_job_id;
            END IF;
        END IF;
    END IF;

    -- Extra polling budget (beyond call_api's internal poll window) to keep reply SLA <10s.
    IF NOT v_completed AND v_request_id IS NOT NULL AND v_poll_max_seconds > 0 THEN
        v_deadline := clock_timestamp() + make_interval(secs => v_poll_max_seconds);

        WHILE clock_timestamp() < v_deadline LOOP
            v_poll := public.check_async_response(v_request_id);
            v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
            v_status := COALESCE((v_poll->>'status')::INT, 0);

            IF v_completed THEN
                v_result := jsonb_build_object(
                    'status', v_status,
                    'headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                    'body', COALESCE(v_poll->'body', '{}'::jsonb),
                    'completed', TRUE,
                    'request_id', v_request_id
                );
                EXIT;
            END IF;

            PERFORM pg_sleep(v_sleep_seconds);
        END LOOP;
    END IF;

    v_latency_ms := ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000)::INT;

    IF v_completed AND v_status BETWEEN 200 AND 299 THEN
        UPDATE public.outbound_calls
           SET status = 'completed',
               response_status_code = v_status,
               response_body = COALESCE(v_result->'body', '{}'::jsonb),
               response_headers = COALESCE(v_result->'headers', '{}'::jsonb),
               latency_ms = v_latency_ms,
               completed_at = now(),
               error_message = NULL,
               lease_expires_at = NULL,
               context = (COALESCE(context, '{}'::jsonb) - 'async_request_id')
         WHERE id = p_job_id;

        -- Response processing failures should not flip delivery state or trigger resends.
        BEGIN
            PERFORM public.orchestrate_api_response_processing(p_job_id);
        EXCEPTION
            WHEN OTHERS THEN
                UPDATE public.outbound_calls
                   SET requires_investigation = TRUE,
                       root_cause = 'response_processing_exception',
                       resolution_notes = SQLERRM
                 WHERE id = p_job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := p_job_id,
                    p_decision_point := 'response_processing',
                    p_decision_outcome := 'exception',
                    p_performed_by_system := v_performed_by_system,
                    p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
                    p_decision_reason := SQLERRM
                );
        END;

        -- F267 audit begin
        BEGIN
            PERFORM public.log_api_call_event(
                p_job_id, '{}'::jsonb,
                jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                   'body', COALESCE(v_result->'body', '{}'::jsonb)),
                v_status, v_latency_ms, NULL
            );
        EXCEPTION
            WHEN OTHERS THEN
                -- Audit failure must not undo a delivered request or schedule a resend.
                RAISE WARNING 'outbound_api_audit_failed';
        END;
        -- F267 audit end

        PERFORM public.log_decision(
            p_organization_id := v_org,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'http_execution',
            p_decision_outcome := 'success',
            p_performed_by_system := v_performed_by_system,
            p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
            p_decision_inputs := jsonb_build_object('status', v_status, 'latency_ms', v_latency_ms),
            p_decision_reason := 'Outbound HTTP request completed inline.'
        );

        RETURN jsonb_build_object(
            'status', 'completed',
            'job_id', p_job_id,
            'http_status', v_status,
            'completed', TRUE,
            'latency_ms', v_latency_ms
        );
    END IF;

    IF v_completed THEN
        -- F267 audit begin
        BEGIN
            PERFORM public.log_api_call_event(
                p_job_id, '{}'::jsonb,
                jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                   'body', COALESCE(v_result->'body', '{}'::jsonb)),
                v_status, v_latency_ms, 'outbound_call_failed'
            );
        EXCEPTION
            WHEN OTHERS THEN
                -- Audit failure must not undo a delivered request or schedule a resend.
                RAISE WARNING 'outbound_api_audit_failed';
        END;
        -- F267 audit end

        PERFORM public.mark_outbound_call_failure(
            p_job_id,
            v_status,
            COALESCE(v_result->'headers', '{}'::jsonb),
            COALESCE(v_result->'body', '{}'::jsonb),
            COALESCE(
                NULLIF(v_result->'body'->>'error', ''),
                NULLIF(v_result->'body'->>'message', ''),
                format('HTTP %s failure', v_status)
            )
        );


        UPDATE public.outbound_calls
           SET lease_expires_at = NULL
         WHERE id = p_job_id;

        RETURN jsonb_build_object(
            'status', 'failed',
            'job_id', p_job_id,
            'http_status', v_status,
            'completed', TRUE,
            'latency_ms', v_latency_ms
        );
    END IF;

    -- Still pending: release lease and reschedule for worker.
    UPDATE public.outbound_calls
       SET status = 'pending',
           scheduled_at = now() + make_interval(secs => v_pending_reschedule_seconds),
           lease_expires_at = NULL
     WHERE id = p_job_id;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := 'async_pending',
        p_performed_by_system := v_performed_by_system,
        p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'status', v_status,
            'async_request_id', v_request_id,
            'latency_ms', v_latency_ms
        )),
        p_decision_reason := 'Inline dispatch did not complete within budget; left queued for worker.'
    );

    RETURN jsonb_build_object(
        'status', 'pending',
        'job_id', p_job_id,
        'completed', FALSE,
        'async_request_id', v_request_id,
        'latency_ms', v_latency_ms
    );
EXCEPTION
    WHEN OTHERS THEN
        v_error := SQLERRM;
        BEGIN
            UPDATE public.outbound_calls
               SET lease_expires_at = NULL
             WHERE id = p_job_id;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;
        RETURN jsonb_build_object('status', 'error', 'job_id', p_job_id, 'reason', v_error);
END;
$function$;

-- The credential-free relay now owns wakeups. Keep the old tick disabled until it is retired.
UPDATE public.cron_config
   SET enabled = false
 WHERE worker_name = 'edge_api_caller_worker';

SELECT cron.alter_job(jobid, active := false)
FROM cron.job
WHERE jobname = 'api_caller_batch_tick' AND active;

COMMIT;
