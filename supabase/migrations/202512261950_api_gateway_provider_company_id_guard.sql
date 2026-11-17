-- Plan: PLAN-202512-api-gateway-logestechs-per-client-accounts / Step: S04
-- Migration: API gateway provider company-id path guard
-- Purpose:
--   - When provider_account requires a company_id and the matched route has a `{companyId}` path param,
--     enforce that the inbound path companyId matches the ladder-resolved provider_account.company_id.
--   - Prevent accidental cross-company calls when clients pass the wrong companyId in the URL path.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.workflow_intake_api_gateway_v1(
  p_token TEXT,
  p_method TEXT,
  p_path TEXT,
  p_query_string TEXT DEFAULT NULL,
  p_headers JSONB DEFAULT '{}'::jsonb,
  p_body JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_method TEXT := upper(COALESCE(p_method, ''));
  v_path TEXT := public.normalize_api_path(p_path);
  v_query TEXT := COALESCE(p_query_string, '');
  v_headers JSONB := COALESCE(p_headers, '{}'::jsonb);
  v_body JSONB := COALESCE(p_body, '{}'::jsonb);

  v_source RECORD;
  v_org UUID;
  v_client UUID;
  v_sender UUID;

  v_corr UUID;
  v_corr_text TEXT;
  v_rate_limit INT;
  v_window TIMESTAMPTZ;
  v_count INT;

  v_route JSONB;
  v_route_id UUID;
  v_settings_resolution_id UUID;
  v_path_params JSONB;
  v_route_row public.api_routes%ROWTYPE;

  v_provider_id UUID;
  v_base_url TEXT;
  v_upstream_path TEXT;
  v_upstream_method TEXT;
  v_url TEXT;

  v_policy JSONB;
  v_delivery JSONB;
  v_delivery_mode TEXT;
  v_timeout_seconds INT;

  v_auth JSONB;
  v_auth_mode TEXT;
  v_auth_type TEXT;
  v_auth_fields JSONB;
  v_safe_body JSONB;
  v_safe_headers JSONB;

  v_provider_account_policy JSONB;
  v_provider_account_category TEXT;
  v_provider_account_required BOOLEAN;
  v_provider_account_require_company_id BOOLEAN;
  v_provider_account_require_auth_config_id BOOLEAN;
  v_provider_account JSONB;
  v_provider_account_settings_id UUID;
  v_provider_account_settings_version_id UUID;
  v_provider_account_scope_type TEXT;
  v_provider_account_scope_id UUID;
  v_provider_account_version INT;
  v_provider_account_scope_path JSONB;
  v_provider_account_settings_resolution_id UUID;
  v_provider_account_company_id TEXT;
  v_path_company_id TEXT;
  v_provider_account_auth_config_id UUID;
  v_auth_config_count INT;

  v_outbound_headers JSONB;
  v_header_defaults JSONB;
  v_header_overrides JSONB;
  v_header_render_context JSONB;
  v_header_entry RECORD;
  v_header_name TEXT;
  v_header_value TEXT;

  v_request_id UUID;
  v_outbound_id UUID;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN jsonb_build_object('action', 'error', 'status', 401, 'body', jsonb_build_object('error', 'missing_token'));
  END IF;

  SELECT * INTO v_source
  FROM public.get_webhook_source_by_token(p_token)
  LIMIT 1;

  IF v_source.id IS NULL OR COALESCE(v_source.enabled, FALSE) IS FALSE THEN
    RETURN jsonb_build_object('action', 'error', 'status', 401, 'body', jsonb_build_object('error', 'invalid_token'));
  END IF;

  v_org := v_source.organization_id;
  v_sender := v_source.sender_id;
  v_client := v_source.client_id;

  -- Correlation ID handling:
  -- - Prefer client-provided x-correlation-id (or x-request-id) when valid UUID.
  -- - Otherwise use existing request.correlation_id or generate a new one.
  v_corr_text := NULLIF(v_headers->>'x-correlation-id', '');
  IF v_corr_text IS NULL THEN
    v_corr_text := NULLIF(v_headers->>'x-request-id', '');
  END IF;

  IF v_corr_text IS NOT NULL
    AND v_corr_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    v_corr := v_corr_text::UUID;
    PERFORM set_config('request.correlation_id', v_corr::text, true);
  ELSE
    v_corr := public.current_correlation_id();
    IF v_corr IS NULL THEN
      v_corr := gen_random_uuid();
      PERFORM set_config('request.correlation_id', v_corr::text, true);
    END IF;
  END IF;

  -- Normalize query string (accept '?a=b' or 'a=b').
  IF v_query ~ '^\\?' THEN
    v_query := substring(v_query FROM 2);
  END IF;

  -- Rate limiting (per source, per hour) using webhook_sources.rate_limit_per_hour.
  SELECT rate_limit_per_hour INTO v_rate_limit
  FROM public.webhook_sources
  WHERE id = v_source.id;

  v_rate_limit := COALESCE(v_rate_limit, 0);
  v_window := date_trunc('hour', v_now);

  IF v_rate_limit > 0 THEN
    INSERT INTO public.api_gateway_rate_limits (source_id, window_start, request_count, updated_at)
    VALUES (v_source.id, v_window, 1, v_now)
    ON CONFLICT (source_id, window_start) DO UPDATE
      SET request_count = public.api_gateway_rate_limits.request_count + 1,
          updated_at = EXCLUDED.updated_at
    RETURNING request_count INTO v_count;

    IF v_count > v_rate_limit THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'rate_limiting',
        p_resource_type := 'webhook_source',
        p_resource_id := v_source.id,
        p_decision_point := 'api_gateway_intake',
        p_decision_outcome := 'rate_limited',
        p_performed_by_system := 'api_gateway',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'window_start', v_window,
          'count', v_count,
          'limit', v_rate_limit,
          'method', v_method,
          'path', v_path
        )),
        p_decision_reason := 'API gateway request rejected by per-source hourly rate limit.'
      );

      RETURN jsonb_build_object(
        'action', 'error',
        'status', 429,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object('error', 'rate_limited')
      );
    END IF;
  END IF;

  v_route := public.resolve_api_route_v1(v_method, v_path, v_org, v_client, v_sender, v_source.id);
  IF COALESCE((v_route->>'found')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN jsonb_build_object(
      'action', 'error',
      'status', 404,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'route_not_found')
    );
  END IF;

  v_route_id := NULLIF(v_route->>'route_id', '')::UUID;
  v_settings_resolution_id := NULLIF(v_route->>'settings_resolution_id', '')::UUID;
  v_path_params := COALESCE(v_route->'path_params', '{}'::jsonb);

  SELECT * INTO v_route_row
  FROM public.api_routes
  WHERE id = v_route_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'error', 'status', 500, 'body', jsonb_build_object('error', 'route_missing'));
  END IF;

  v_policy := COALESCE(v_route_row.policy, '{}'::jsonb);
  v_delivery := COALESCE(v_policy->'delivery', '{}'::jsonb);
  v_delivery_mode := COALESCE(NULLIF(v_delivery->>'mode', ''), 'proxy');
  v_timeout_seconds := COALESCE(NULLIF(v_delivery->>'timeout_seconds', '')::INT, 30);

  v_auth := COALESCE(v_policy->'auth', '{}'::jsonb);
  v_auth_mode := NULLIF(v_auth->>'mode', '');
  v_auth_type := NULLIF(v_auth->>'auth_type', '');
  v_auth_fields := COALESCE(v_auth->'fields', '{}'::jsonb);

  v_provider_account_policy := COALESCE(v_policy->'provider_account', '{}'::jsonb);
  v_provider_account_category := NULLIF(v_provider_account_policy->>'category', '');
  IF v_provider_account_category IS NULL THEN
    -- Back-compat: allow auth.binding_category for older policies.
    v_provider_account_category := NULLIF(v_auth->>'binding_category', '');
  END IF;

  BEGIN
    v_provider_account_required := COALESCE((v_provider_account_policy->>'required')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_provider_account_required := TRUE;
  END;

  BEGIN
    v_provider_account_require_company_id := COALESCE((v_provider_account_policy->>'require_company_id')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_provider_account_require_company_id := FALSE;
  END;

  BEGIN
    v_provider_account_require_auth_config_id := COALESCE(
      (v_provider_account_policy->>'require_auth_config_id')::BOOLEAN,
      (v_auth_mode IS NOT NULL)
    );
  EXCEPTION
    WHEN others THEN
      v_provider_account_require_auth_config_id := (v_auth_mode IS NOT NULL);
  END;

  -- Strip sensitive headers (defense-in-depth) + internal tokens.
  v_safe_headers := public.redact_sensitive_headers(v_headers) - 'x-webhook-token' - 'x-internal-edge-token';

  -- Strip auth fields from stored body when using body_fields injection.
  v_safe_body := v_body;
  IF v_auth_mode = 'body_fields' AND jsonb_typeof(v_safe_body) = 'object' AND jsonb_typeof(v_auth_fields) = 'object' THEN
    SELECT COALESCE(
      jsonb_object_agg(kv.key, kv.value) FILTER (WHERE kv.key IS NOT NULL),
      '{}'::jsonb
    )
    INTO v_safe_body
    FROM (
      SELECT key, value
      FROM jsonb_each(v_safe_body)
      WHERE key NOT IN (SELECT key FROM jsonb_each_text(v_auth_fields))
    ) kv;
  END IF;

  v_safe_body := public.redact_sensitive_json(COALESCE(v_safe_body, '{}'::jsonb));

  -- Insert inbound request log (redacted).
  INSERT INTO public.api_gateway_requests (
    organization_id,
    client_id,
    sender_id,
    source_id,
    correlation_id,
    route_id,
    settings_resolution_id,
    method,
    path,
    query_string,
    request_headers,
    request_body,
    received_at,
    created_at,
    updated_at
  ) VALUES (
    v_org,
    v_client,
    v_sender,
    v_source.id,
    v_corr,
    v_route_id,
    v_settings_resolution_id,
    v_method,
    v_path,
    NULLIF(v_query, ''),
    COALESCE(v_safe_headers, '{}'::jsonb),
    COALESCE(v_safe_body, '{}'::jsonb),
    v_now,
    v_now,
    v_now
  )
  RETURNING id INTO v_request_id;

  -- Build outbound call spec (provider proxy).
  v_provider_id := v_route_row.provider_id;
  IF v_provider_id IS NULL THEN
    RETURN jsonb_build_object('action', 'error', 'status', 500, 'body', jsonb_build_object('error', 'provider_missing'));
  END IF;

  SELECT COALESCE(metadata->>'base_url', '') INTO v_base_url
  FROM public.providers
  WHERE id = v_provider_id;

  IF v_base_url IS NULL OR btrim(v_base_url) = '' THEN
    RETURN jsonb_build_object('action', 'error', 'status', 500, 'body', jsonb_build_object('error', 'provider_base_url_missing'));
  END IF;

  v_upstream_method := upper(COALESCE(NULLIF(v_route_row.upstream_method, ''), v_method));
  v_upstream_path := public.api_render_path_template(
    COALESCE(NULLIF(v_route_row.upstream_path_template, ''), v_route_row.path_template),
    v_path_params
  );

  v_url := rtrim(v_base_url, '/') || v_upstream_path;
  IF v_query IS NOT NULL AND btrim(v_query) <> '' THEN
    v_url := v_url || '?' || v_query;
  END IF;

  -- Provider account (ladder-driven settings):
  v_provider_account := NULL;
  v_provider_account_settings_resolution_id := NULL;
  v_provider_account_company_id := NULL;
  v_provider_account_auth_config_id := NULL;

  IF v_provider_account_category IS NOT NULL AND btrim(v_provider_account_category) <> '' THEN
    SELECT settings_id, settings_version_id, scope_type, scope_id, value, version, scope_path
      INTO v_provider_account_settings_id,
           v_provider_account_settings_version_id,
           v_provider_account_scope_type,
           v_provider_account_scope_id,
           v_provider_account,
           v_provider_account_version,
           v_provider_account_scope_path
      FROM public.resolve_settings_row_from_context(
        v_provider_account_category,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org,
          'client_id', v_client,
          'sender_id', v_sender,
          'webhook_source_id', v_source.id
        ))
      )
      LIMIT 1;

    IF v_provider_account_settings_id IS NOT NULL THEN
      v_provider_account_settings_resolution_id := public.log_settings_resolution(
        p_organization_id := v_org,
        p_category := v_provider_account_category,
        p_winning_scope_type := v_provider_account_scope_type,
        p_winning_scope_id := v_provider_account_scope_id,
        p_winning_settings_id := v_provider_account_settings_id,
        p_winning_settings_version_id := v_provider_account_settings_version_id,
        p_winning_version := v_provider_account_version,
        p_scope_path := v_provider_account_scope_path,
        p_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_id', v_provider_id,
          'route_id', v_route_id,
          'route_name', v_route_row.route_name,
          'method', v_method,
          'path', v_path
        ))
      );
    END IF;

    IF v_provider_account_required AND v_provider_account_settings_id IS NULL THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'settings_resolution',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request_id,
        p_decision_point := 'api_gateway_provider_account_resolved',
        p_decision_outcome := 'missing',
        p_performed_by_system := 'api_gateway',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_id', v_provider_id,
          'route_id', v_route_id,
          'route_name', v_route_row.route_name,
          'category', v_provider_account_category
        )),
        p_decision_reason := 'Provider account settings category missing for this scope; cannot proceed safely.',
        p_settings_resolution_id := v_provider_account_settings_resolution_id
      );

      RETURN jsonb_build_object(
        'action', 'error',
        'status', 500,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object('error', 'provider_account_missing')
      );
    END IF;

    v_provider_account_company_id := NULLIF(COALESCE(v_provider_account->>'company_id', ''), '');
    BEGIN
      v_provider_account_auth_config_id := NULLIF(COALESCE(v_provider_account->>'auth_config_id', ''), '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_provider_account_auth_config_id := NULL;
    END;

    IF v_provider_account_require_company_id AND v_provider_account_company_id IS NULL THEN
      RETURN jsonb_build_object(
        'action', 'error',
        'status', 500,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object('error', 'provider_company_id_missing')
      );
    END IF;

    IF v_provider_account_require_company_id THEN
      v_path_company_id := NULLIF(COALESCE(v_path_params->>'companyId', v_path_params->>'company_id', ''), '');
      IF v_path_company_id IS NOT NULL AND v_path_company_id <> v_provider_account_company_id THEN
        PERFORM public.log_decision(
          p_organization_id := v_org,
          p_decision_category := 'settings_resolution',
          p_resource_type := 'api_gateway_request',
          p_resource_id := v_request_id,
          p_decision_point := 'api_gateway_provider_account_company_id_checked',
          p_decision_outcome := 'mismatch',
          p_performed_by_system := 'api_gateway',
          p_correlation_id := v_corr,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'provider_id', v_provider_id,
            'route_id', v_route_id,
            'route_name', v_route_row.route_name,
            'category', v_provider_account_category,
            'expected_company_id', v_provider_account_company_id,
            'path_company_id', v_path_company_id
          )),
          p_decision_reason := 'Inbound path companyId does not match ladder-resolved provider_account.company_id; refusing to dispatch upstream.',
          p_settings_resolution_id := v_provider_account_settings_resolution_id
        );

        RETURN jsonb_build_object(
          'action', 'error',
          'status', 400,
          'headers', jsonb_build_object('content-type', 'application/json'),
          'body', jsonb_build_object('error', 'provider_company_id_mismatch')
        );
      END IF;
    END IF;

    -- Auth config selection safety:
    -- - If a specific auth_config_id is configured for this scope, use it.
    -- - Otherwise only allow fallback when there is exactly ONE provider_auth_configs row for provider+auth_type.
    IF v_auth_mode IS NOT NULL THEN
      IF v_provider_account_auth_config_id IS NOT NULL THEN
        v_auth := jsonb_set(v_auth, '{auth_config_id}', to_jsonb(v_provider_account_auth_config_id), TRUE);
      ELSIF v_provider_account_require_auth_config_id THEN
        SELECT count(*) INTO v_auth_config_count
        FROM public.provider_auth_configs
        WHERE provider_id = v_provider_id
          AND auth_type = v_auth_type;

        v_auth_config_count := COALESCE(v_auth_config_count, 0);
        IF v_auth_config_count = 0 THEN
          RETURN jsonb_build_object(
            'action', 'error',
            'status', 500,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'provider_auth_config_missing')
          );
        ELSIF v_auth_config_count > 1 THEN
          RETURN jsonb_build_object(
            'action', 'error',
            'status', 500,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'provider_auth_config_ambiguous')
          );
        END IF;
      END IF;
    END IF;

    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'settings_resolution',
      p_resource_type := 'api_gateway_request',
      p_resource_id := v_request_id,
      p_decision_point := 'api_gateway_provider_account_resolved',
      p_decision_outcome := 'resolved',
      p_performed_by_system := 'api_gateway',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'provider_id', v_provider_id,
        'route_id', v_route_id,
        'route_name', v_route_row.route_name,
        'category', v_provider_account_category,
        'company_id', v_provider_account_company_id,
        'auth_config_id', v_provider_account_auth_config_id
      )),
      p_decision_reason := 'Provider account settings resolved via ladder.',
      p_settings_resolution_id := v_provider_account_settings_resolution_id
    );
  END IF;

  -- Outbound headers:
  -- - Strip internal/gateway auth headers (defense-in-depth).
  -- - Apply row-driven defaults/overrides rendered via render_template().
  v_outbound_headers := COALESCE(v_headers, '{}'::jsonb)
    - 'authorization'
    - 'proxy-authorization'
    - 'x-webhook-token'
    - 'x-internal-edge-token';

  v_header_render_context := jsonb_build_object(
    'path_params', COALESCE(v_path_params, '{}'::jsonb),
    'headers', COALESCE(v_safe_headers, '{}'::jsonb),
    'body', COALESCE(v_safe_body, '{}'::jsonb),
    'source', jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'source_id', v_source.id
    )),
    'provider', jsonb_strip_nulls(jsonb_build_object(
      'id', v_provider_id
    )),
    'provider_account', COALESCE(v_provider_account, '{}'::jsonb)
  );

  -- Defaults: set only when missing.
  v_header_defaults := COALESCE(v_policy #> '{headers,defaults}', '{}'::jsonb);
  IF jsonb_typeof(v_header_defaults) = 'object' THEN
    v_header_defaults := public.render_template(v_header_defaults, v_header_render_context);
    IF jsonb_typeof(v_header_defaults) = 'object' THEN
      FOR v_header_entry IN SELECT key, value FROM jsonb_each(v_header_defaults) LOOP
        v_header_name := lower(btrim(v_header_entry.key));
        IF v_header_name IS NULL OR v_header_name = '' THEN
          CONTINUE;
        END IF;

        IF v_header_name IN ('authorization', 'proxy-authorization', 'x-webhook-token', 'x-internal-edge-token') THEN
          CONTINUE;
        END IF;

        v_header_value := btrim(trim(both '"' FROM v_header_entry.value::text));
        IF v_header_value IS NULL OR v_header_value = '' THEN
          CONTINUE;
        END IF;

        IF (v_outbound_headers ? v_header_name) IS FALSE OR btrim(COALESCE(v_outbound_headers->>v_header_name, '')) = '' THEN
          v_outbound_headers := jsonb_set(v_outbound_headers, ARRAY[v_header_name], to_jsonb(v_header_value), TRUE);
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- Overrides: always set (when non-empty).
  v_header_overrides := COALESCE(v_policy #> '{headers,overrides}', '{}'::jsonb);
  IF jsonb_typeof(v_header_overrides) = 'object' THEN
    v_header_overrides := public.render_template(v_header_overrides, v_header_render_context);
    IF jsonb_typeof(v_header_overrides) = 'object' THEN
      FOR v_header_entry IN SELECT key, value FROM jsonb_each(v_header_overrides) LOOP
        v_header_name := lower(btrim(v_header_entry.key));
        IF v_header_name IS NULL OR v_header_name = '' THEN
          CONTINUE;
        END IF;

        IF v_header_name IN ('authorization', 'proxy-authorization', 'x-webhook-token', 'x-internal-edge-token') THEN
          CONTINUE;
        END IF;

        v_header_value := btrim(trim(both '"' FROM v_header_entry.value::text));
        IF v_header_value IS NULL OR v_header_value = '' THEN
          CONTINUE;
        END IF;

        v_outbound_headers := jsonb_set(v_outbound_headers, ARRAY[v_header_name], to_jsonb(v_header_value), TRUE);
      END LOOP;
    END IF;
  END IF;

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    status,
    priority,
    max_retries,
    scheduled_at,
    correlation_id,
    context,
    created_at
  ) VALUES (
    'provider_api',
    'provider',
    v_provider_id,
    v_upstream_method,
    v_url,
    COALESCE(v_outbound_headers, '{}'::jsonb),
    COALESCE(v_safe_body, '{}'::jsonb),
    'pending_edge',
    COALESCE(NULLIF(v_policy->>'priority', '')::INT, 100),
    COALESCE(NULLIF(v_policy->>'max_retries', '')::INT, 3),
    v_now,
    v_corr,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'source_id', v_source.id,
      'api_gateway_request_id', v_request_id,
      'api_gateway_route_id', v_route_id,
      'api_gateway_route_name', v_route_row.route_name,
      'api_gateway_path_params', v_path_params,
      'provider_account_category', v_provider_account_category,
      'provider_account_settings_resolution_id', v_provider_account_settings_resolution_id,
      'auth', v_auth
    )),
    v_now
  )
  RETURNING id INTO v_outbound_id;

  UPDATE public.api_gateway_requests
  SET outbound_call_id = v_outbound_id,
      updated_at = v_now
  WHERE id = v_request_id;

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'settings_resolution',
    p_resource_type := 'api_gateway_request',
    p_resource_id := v_request_id,
    p_decision_point := 'api_gateway_route_resolved',
    p_decision_outcome := 'resolved',
    p_performed_by_system := 'api_gateway',
    p_correlation_id := v_corr,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'method', v_method,
      'path', v_path,
      'route_id', v_route_id,
      'route_name', v_route_row.route_name,
      'provider_id', v_provider_id,
      'outbound_call_id', v_outbound_id
    )),
    p_decision_reason := 'API gateway route resolved and outbound call enqueued.',
    p_settings_resolution_id := v_settings_resolution_id
  );

  IF v_delivery_mode = 'accepted_async' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'action', 'accepted_async',
      'status', COALESCE(NULLIF(v_delivery->>'status_code', '')::INT, 202),
      'headers', COALESCE(v_delivery->'headers', jsonb_build_object('content-type', 'application/json')),
      'body', COALESCE(v_delivery->'body', jsonb_build_object('status', 'accepted_async', 'correlation_id', v_corr)),
      'api_gateway_request_id', v_request_id,
      'outbound_call_id', v_outbound_id,
      'correlation_id', v_corr
    ));
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'action', 'proxy',
    'status', 200,
    'api_gateway_request_id', v_request_id,
    'outbound_call_id', v_outbound_id,
    'timeout_seconds', v_timeout_seconds,
    'correlation_id', v_corr
  ));
END;
$$;

COMMENT ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  IS 'API gateway intake RPC: resolve route (ladder), enforce per-source rate limit, log request, resolve provider account (ladder), enqueue outbound_calls, return proxy/async directive.';

COMMIT;
