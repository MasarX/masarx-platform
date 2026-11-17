-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: API Gateway core (DB-driven routing + intake RPC)
-- Purpose:
--   - Provide a single, row-driven routing layer that mirrors upstream APIs (Logestechs V2) with no per-endpoint code.
--   - Resolve routes via override ladder: Global < Tenant < Client < Sender < Source.
--   - Enqueue outbound_calls for upstream dispatch and preserve full observability (decision + settings provenance).
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Tables (RLS: service_role only)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.api_route_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.api_route_packs IS 'Named packs of API gateway routes (enable/disable as a unit).';

CREATE TABLE IF NOT EXISTS public.api_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id UUID NOT NULL REFERENCES public.api_route_packs(id) ON DELETE CASCADE,
  route_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- Match (client-facing)
  method TEXT NOT NULL,
  path_template TEXT NOT NULL,

  -- Resolution scope (override ladder)
  scope_type TEXT NOT NULL DEFAULT 'global', -- global|tenant|client|sender|source
  scope_id UUID,

  -- Upstream target
  provider_id UUID REFERENCES public.providers(id),
  upstream_method TEXT,
  upstream_path_template TEXT,

  -- Behavior and transforms (row-driven)
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT api_routes_method_ck CHECK (btrim(method) <> ''),
  CONSTRAINT api_routes_path_template_ck CHECK (btrim(path_template) <> ''),
  CONSTRAINT api_routes_scope_type_ck CHECK (scope_type IN ('global', 'tenant', 'client', 'sender', 'source')),
  CONSTRAINT api_routes_scope_global_ck CHECK ((scope_type = 'global' AND scope_id IS NULL) OR (scope_type <> 'global')),
  UNIQUE (method, path_template, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_api_routes_pack_enabled ON public.api_routes(pack_id) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_api_routes_method ON public.api_routes(upper(method));
CREATE INDEX IF NOT EXISTS idx_api_routes_scope ON public.api_routes(scope_type, scope_id);

COMMENT ON TABLE public.api_routes IS 'API gateway routes resolved by ladder (scope_type/scope_id) and matched via path_template.';
COMMENT ON COLUMN public.api_routes.policy IS 'Row-driven behavior (delivery mode, auth injection, postprocess) for this route.';

CREATE TABLE IF NOT EXISTS public.api_gateway_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  client_id UUID REFERENCES public.clients(id),
  sender_id UUID REFERENCES public.senders(id),
  source_id UUID NOT NULL REFERENCES public.webhook_sources(id),
  correlation_id UUID,

  route_id UUID NOT NULL REFERENCES public.api_routes(id),
  settings_resolution_id UUID,

  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query_string TEXT,
  request_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_body JSONB NOT NULL DEFAULT '{}'::jsonb,

  outbound_call_id UUID REFERENCES public.outbound_calls(id),

  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_gateway_requests_received_at ON public.api_gateway_requests(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_gateway_requests_source ON public.api_gateway_requests(source_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_gateway_requests_route ON public.api_gateway_requests(route_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_gateway_requests_outbound_call ON public.api_gateway_requests(outbound_call_id);

COMMENT ON TABLE public.api_gateway_requests IS 'Inbound API gateway request log (redacted) linking to outbound_calls (provider dispatch).';

CREATE TABLE IF NOT EXISTS public.api_gateway_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.webhook_sources(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, window_start),
  CONSTRAINT api_gateway_rate_limits_count_ck CHECK (request_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_api_gateway_rate_limits_updated_at
  ON public.api_gateway_rate_limits(updated_at DESC);

COMMENT ON TABLE public.api_gateway_rate_limits IS 'Hourly rate limit counters for API gateway (per source token).';

-- RLS: service_role only (least privilege)
ALTER TABLE public.api_route_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_gateway_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_gateway_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.api_route_packs FROM PUBLIC;
REVOKE ALL ON TABLE public.api_routes FROM PUBLIC;
REVOKE ALL ON TABLE public.api_gateway_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.api_gateway_rate_limits FROM PUBLIC;

REVOKE ALL ON TABLE public.api_route_packs FROM anon;
REVOKE ALL ON TABLE public.api_routes FROM anon;
REVOKE ALL ON TABLE public.api_gateway_requests FROM anon;
REVOKE ALL ON TABLE public.api_gateway_rate_limits FROM anon;

REVOKE ALL ON TABLE public.api_route_packs FROM authenticated;
REVOKE ALL ON TABLE public.api_routes FROM authenticated;
REVOKE ALL ON TABLE public.api_gateway_requests FROM authenticated;
REVOKE ALL ON TABLE public.api_gateway_rate_limits FROM authenticated;

DROP POLICY IF EXISTS api_route_packs_service_policy ON public.api_route_packs;
CREATE POLICY api_route_packs_service_policy ON public.api_route_packs
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS api_routes_service_policy ON public.api_routes;
CREATE POLICY api_routes_service_policy ON public.api_routes
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS api_gateway_requests_service_policy ON public.api_gateway_requests;
CREATE POLICY api_gateway_requests_service_policy ON public.api_gateway_requests
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS api_gateway_rate_limits_service_policy ON public.api_gateway_rate_limits;
CREATE POLICY api_gateway_rate_limits_service_policy ON public.api_gateway_rate_limits
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 2) Path template helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normalize_api_path(p_path TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_path TEXT := COALESCE(p_path, '');
  v_qpos INT;
BEGIN
  v_qpos := position('?' IN v_path);
  IF v_qpos > 0 THEN
    v_path := left(v_path, v_qpos - 1);
  END IF;

  v_path := regexp_replace(v_path, '\\s+', '', 'g');
  v_path := regexp_replace(v_path, '/+', '/', 'g');

  IF v_path = '' THEN
    v_path := '/';
  END IF;

  IF left(v_path, 1) <> '/' THEN
    v_path := '/' || v_path;
  END IF;

  IF length(v_path) > 1 AND right(v_path, 1) = '/' THEN
    v_path := left(v_path, length(v_path) - 1);
  END IF;

  RETURN v_path;
END;
$$;

COMMENT ON FUNCTION public.normalize_api_path(TEXT)
  IS 'Normalize a request path: strip query, collapse slashes, enforce leading slash, trim trailing slash.';

CREATE OR REPLACE FUNCTION public.api_match_path_template(p_path TEXT, p_template TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_path TEXT := public.normalize_api_path(p_path);
  v_template TEXT := public.normalize_api_path(p_template);
  v_path_parts TEXT[];
  v_tpl_parts TEXT[];
  v_i INT;
  v_tpl_seg TEXT;
BEGIN
  v_path_parts := string_to_array(trim(both '/' FROM v_path), '/');
  v_tpl_parts := string_to_array(trim(both '/' FROM v_template), '/');

  IF array_length(v_path_parts, 1) IS DISTINCT FROM array_length(v_tpl_parts, 1) THEN
    RETURN FALSE;
  END IF;

  FOR v_i IN 1..COALESCE(array_length(v_tpl_parts, 1), 0) LOOP
    v_tpl_seg := v_tpl_parts[v_i];
    IF v_tpl_seg ~ '^\\{[A-Za-z0-9_]+\\}$' THEN
      IF v_path_parts[v_i] IS NULL OR v_path_parts[v_i] = '' THEN
        RETURN FALSE;
      END IF;
    ELSE
      IF v_path_parts[v_i] IS DISTINCT FROM v_tpl_seg THEN
        RETURN FALSE;
      END IF;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION public.api_match_path_template(TEXT, TEXT)
  IS 'Return true when a normalized path matches a template with {param} segments (segment-aligned).';

CREATE OR REPLACE FUNCTION public.api_extract_path_params(p_path TEXT, p_template TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_path TEXT := public.normalize_api_path(p_path);
  v_template TEXT := public.normalize_api_path(p_template);
  v_path_parts TEXT[];
  v_tpl_parts TEXT[];
  v_i INT;
  v_tpl_seg TEXT;
  v_name TEXT;
  v_out JSONB := '{}'::jsonb;
BEGIN
  IF NOT public.api_match_path_template(v_path, v_template) THEN
    RETURN '{}'::jsonb;
  END IF;

  v_path_parts := string_to_array(trim(both '/' FROM v_path), '/');
  v_tpl_parts := string_to_array(trim(both '/' FROM v_template), '/');

  FOR v_i IN 1..COALESCE(array_length(v_tpl_parts, 1), 0) LOOP
    v_tpl_seg := v_tpl_parts[v_i];
    IF v_tpl_seg ~ '^\\{[A-Za-z0-9_]+\\}$' THEN
      v_name := regexp_replace(v_tpl_seg, '^\\{([A-Za-z0-9_]+)\\}$', '\\1');
      v_out := v_out || jsonb_build_object(v_name, v_path_parts[v_i]);
    END IF;
  END LOOP;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.api_extract_path_params(TEXT, TEXT)
  IS 'Extract path params from a matching path/template pair as JSONB.';

CREATE OR REPLACE FUNCTION public.api_render_path_template(p_template TEXT, p_params JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_template TEXT := public.normalize_api_path(p_template);
  v_out TEXT := v_template;
  v_entry RECORD;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RETURN v_out;
  END IF;

  FOR v_entry IN SELECT key, value FROM jsonb_each_text(p_params) LOOP
    v_out := replace(v_out, '{' || v_entry.key || '}', public.urlencode(v_entry.value));
  END LOOP;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.api_render_path_template(TEXT, JSONB)
  IS 'Render a template with {param} placeholders using URL-encoded values from JSONB.';

CREATE OR REPLACE FUNCTION public.api_path_template_specificity_score(p_template TEXT)
RETURNS INT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_template TEXT := public.normalize_api_path(p_template);
  v_parts TEXT[];
  v_i INT;
  v_score INT := 0;
  v_seg TEXT;
BEGIN
  v_parts := string_to_array(trim(both '/' FROM v_template), '/');
  FOR v_i IN 1..COALESCE(array_length(v_parts, 1), 0) LOOP
    v_seg := v_parts[v_i];
    IF v_seg ~ '^\\{[A-Za-z0-9_]+\\}$' THEN
      v_score := v_score + 0;
    ELSE
      v_score := v_score + 10;
    END IF;
  END LOOP;
  v_score := v_score + COALESCE(array_length(v_parts, 1), 0);
  RETURN v_score;
END;
$$;

COMMENT ON FUNCTION public.api_path_template_specificity_score(TEXT)
  IS 'Score templates so more literal segments rank higher than {param} segments.';

-------------------------------------------------------------------------------
-- 3) Resolver: resolve_api_route_v1 (ladder + provenance)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_api_route_v1(
  p_method TEXT,
  p_path TEXT,
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_source_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_method TEXT := upper(COALESCE(p_method, ''));
  v_path TEXT := public.normalize_api_path(p_path);

  v_candidate RECORD;
  v_scope_rank INT;
  v_scope_path JSONB := '[]'::jsonb;
  v_settings_resolution_id UUID;
BEGIN
  IF v_method = '' THEN
    RETURN jsonb_build_object('found', FALSE, 'reason', 'method_missing');
  END IF;

  FOR v_candidate IN
    SELECT
      r.*,
      public.api_extract_path_params(v_path, r.path_template) AS path_params,
      public.api_path_template_specificity_score(r.path_template) AS specificity,
      CASE r.scope_type
        WHEN 'source' THEN 50
        WHEN 'sender' THEN 40
        WHEN 'client' THEN 30
        WHEN 'tenant' THEN 20
        WHEN 'global' THEN 10
        ELSE 0
      END AS scope_rank
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id AND p.enabled = TRUE
    WHERE r.enabled = TRUE
      AND upper(r.method) = v_method
      AND public.api_match_path_template(v_path, r.path_template)
      AND (
        (r.scope_type = 'source' AND r.scope_id = p_source_id)
        OR (r.scope_type = 'sender' AND r.scope_id = p_sender_id)
        OR (r.scope_type = 'client' AND r.scope_id = p_client_id)
        OR (r.scope_type = 'tenant' AND r.scope_id = p_organization_id)
        OR (r.scope_type = 'global' AND r.scope_id IS NULL)
      )
    ORDER BY
      scope_rank DESC,
      specificity DESC,
      r.updated_at DESC
    LIMIT 1
  LOOP
    v_scope_rank := v_candidate.scope_rank;

    v_scope_path := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object('scope_type', 'source', 'scope_id', p_source_id)),
      jsonb_strip_nulls(jsonb_build_object('scope_type', 'sender', 'scope_id', p_sender_id)),
      jsonb_strip_nulls(jsonb_build_object('scope_type', 'client', 'scope_id', p_client_id)),
      jsonb_strip_nulls(jsonb_build_object('scope_type', 'tenant', 'scope_id', p_organization_id)),
      jsonb_strip_nulls(jsonb_build_object('scope_type', 'global', 'scope_id', NULL))
    );

    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := p_organization_id,
      p_category := 'api_gateway_route',
      p_winning_scope_type := v_candidate.scope_type,
      p_winning_scope_id := v_candidate.scope_id,
      p_winning_settings_id := v_candidate.id,
      p_winning_settings_version_id := NULL,
      p_winning_version := NULL,
      p_scope_path := v_scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'method', v_method,
        'path', v_path
      )),
      p_merge_notes := NULL
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'found', TRUE,
      'route_id', v_candidate.id,
      'route_name', v_candidate.route_name,
      'scope_type', v_candidate.scope_type,
      'scope_id', v_candidate.scope_id,
      'path_params', COALESCE(v_candidate.path_params, '{}'::jsonb),
      'settings_resolution_id', v_settings_resolution_id
    ));
  END LOOP;

  RETURN jsonb_build_object('found', FALSE, 'reason', 'route_not_found');
END;
$$;

COMMENT ON FUNCTION public.resolve_api_route_v1(TEXT, TEXT, UUID, UUID, UUID, UUID)
  IS 'Resolve API gateway route via ladder precedence and log settings resolution provenance (category=api_gateway_route).';

-------------------------------------------------------------------------------
-- 4) Intake RPC: workflow_intake_api_gateway_v1
-------------------------------------------------------------------------------

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
  v_auth_fields JSONB;
  v_safe_body JSONB;
  v_safe_headers JSONB;

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

  v_corr := public.current_correlation_id();
  IF v_corr IS NULL THEN
    v_corr := gen_random_uuid();
    PERFORM set_config('request.correlation_id', v_corr::text, true);
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
  v_auth_fields := COALESCE(v_auth->'fields', '{}'::jsonb);

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
    -- Never forward MasarX auth headers upstream by default (defense-in-depth).
    COALESCE(v_headers, '{}'::jsonb)
      - 'authorization'
      - 'proxy-authorization'
      - 'x-webhook-token'
      - 'x-internal-edge-token',
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
  IS 'API gateway intake RPC: resolve route (ladder), enforce per-source rate limit, log request, enqueue outbound_calls, return proxy/async directive.';

COMMIT;
