-- Purpose:
--   Source-token auth failures for API Gateway and webhook intake were
--   response-only: operators received 401/403, but Console V2 had no
--   backend-backed row to inspect. This adds an append-only redacted ledger
--   plus ui_read_registry aliases so rejected intake auth is visible without
--   fabricating api_gateway_requests or webhook_inbox rows.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605121015_intake_auth_rejection_ledger_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.intake_auth_rejections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,
  surface TEXT NOT NULL,
  credential_kind TEXT NOT NULL DEFAULT 'source_token',
  failure_code TEXT NOT NULL,
  failure_message TEXT,
  http_status INTEGER NOT NULL DEFAULT 401,
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
  source_id UUID NULL REFERENCES public.webhook_sources(id) ON DELETE SET NULL,
  client_id UUID NULL REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID NULL REFERENCES public.senders(id) ON DELETE SET NULL,
  provider_auth_config_id UUID NULL REFERENCES public.provider_auth_configs(id) ON DELETE SET NULL,
  correlation_id UUID NULL,
  request_id TEXT NULL,
  method TEXT NULL,
  path TEXT NULL,
  query_string TEXT NULL,
  token_fingerprint TEXT NULL,
  request_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intake_auth_rejections_service_ck
    CHECK (service IN ('api_gateway', 'webhook_receiver')),
  CONSTRAINT intake_auth_rejections_status_ck
    CHECK (http_status BETWEEN 400 AND 499),
  CONSTRAINT intake_auth_rejections_headers_object_ck
    CHECK (jsonb_typeof(request_headers) = 'object'),
  CONSTRAINT intake_auth_rejections_metadata_object_ck
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_occurred_at
  ON public.intake_auth_rejections(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_service_time
  ON public.intake_auth_rejections(service, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_org_time
  ON public.intake_auth_rejections(organization_id, occurred_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_source_time
  ON public.intake_auth_rejections(source_id, occurred_at DESC)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_correlation
  ON public.intake_auth_rejections(correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE public.intake_auth_rejections IS
  'Append-only redacted ledger for intake source-token/provider-auth failures that occur before webhook_inbox or api_gateway_requests rows can safely exist.';
COMMENT ON COLUMN public.intake_auth_rejections.token_fingerprint IS
  'SHA-256 fingerprint of the presented source token, used for correlation only. The raw token is never persisted.';

ALTER TABLE public.intake_auth_rejections ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.intake_auth_rejections FROM PUBLIC;
REVOKE ALL ON TABLE public.intake_auth_rejections FROM anon;
REVOKE ALL ON TABLE public.intake_auth_rejections FROM authenticated;
GRANT SELECT ON TABLE public.intake_auth_rejections TO authenticated;
GRANT ALL ON TABLE public.intake_auth_rejections TO service_role;

DROP POLICY IF EXISTS intake_auth_rejections_service_policy ON public.intake_auth_rejections;
CREATE POLICY intake_auth_rejections_service_policy
  ON public.intake_auth_rejections
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS intake_auth_rejections_select ON public.intake_auth_rejections;
CREATE POLICY intake_auth_rejections_select
  ON public.intake_auth_rejections
  FOR SELECT
  TO authenticated
  USING (
    (
      (
        service = 'api_gateway'
        AND COALESCE((public.user_capability_eval_v1('api_gateway.read')->>'allowed')::boolean, FALSE)
      )
      OR (
        service = 'webhook_receiver'
        AND COALESCE((public.user_capability_eval_v1('webhooks.read')->>'allowed')::boolean, FALSE)
      )
    )
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
      OR (
        public.current_user_scope_type() = 'client'
        AND client_id = public.current_user_scope_id()
      )
      OR (
        public.current_user_scope_type() = 'sender'
        AND sender_id = public.current_user_scope_id()
      )
    )
  );

CREATE OR REPLACE FUNCTION public.redact_intake_auth_secret_text(p_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN regexp_replace(
    regexp_replace(
      p_value,
      '(/api-gateway/t/)[^/?#\s]+',
      '\1[redacted]',
      'gi'
    ),
    '(^|[?&])(token|auth_token|api_key|apikey|secret|signature|hmac|x_signature|x-signature|x-hub-signature|x-hub-signature-256|key|password|credential)=([^&#\s]*)',
    '\1\2=[redacted]',
    'gi'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.redact_intake_auth_secret_text(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.redact_intake_auth_secret_json(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_result JSONB;
  v_entry RECORD;
  v_key_lower TEXT;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      v_result := '{}'::jsonb;
      FOR v_entry IN SELECT key, value FROM jsonb_each(p_value) LOOP
        v_key_lower := lower(v_entry.key);
        IF v_key_lower IN (
          'authorization',
          'proxy-authorization',
          'cookie',
          'set-cookie',
          'x-api-key',
          'api-key',
          'apikey',
          'd360-api-key',
          'x-auth-token',
          'x-internal-edge-token',
          'x-webhook-token',
          'token',
          'auth_token',
          'api_key',
          'secret',
          'signature',
          'hmac',
          'x_signature',
          'x-signature',
          'x-hub-signature',
          'x-hub-signature-256',
          'key',
          'password',
          'credential'
        ) THEN
          v_result := v_result || jsonb_build_object(v_entry.key, 'REDACTED');
        ELSE
          v_result := v_result || jsonb_build_object(
            v_entry.key,
            public.redact_intake_auth_secret_json(v_entry.value)
          );
        END IF;
      END LOOP;
      RETURN v_result;
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg(public.redact_intake_auth_secret_json(value) ORDER BY ord), '[]'::jsonb)
        INTO v_result
        FROM jsonb_array_elements(p_value) WITH ORDINALITY AS arr(value, ord);
      RETURN v_result;
    WHEN 'string' THEN
      RETURN to_jsonb(public.redact_intake_auth_secret_text(p_value #>> '{}'));
    ELSE
      RETURN p_value;
  END CASE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.redact_intake_auth_secret_json(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_intake_auth_rejection_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_service TEXT := lower(NULLIF(btrim(COALESCE(v_args->>'service', '')), ''));
  v_surface TEXT := lower(NULLIF(btrim(COALESCE(v_args->>'surface', '')), ''));
  v_credential_kind TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_args->>'credential_kind', '')), ''), 'source_token'));
  v_failure_code TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_args->>'failure_code', '')), ''), 'unauthorized'));
  v_failure_message TEXT := NULLIF(btrim(COALESCE(v_args->>'failure_message', v_args->>'message', '')), '');
  v_http_status INTEGER := COALESCE(NULLIF(v_args->>'http_status', '')::integer, 401);
  v_token TEXT := NULLIF(btrim(COALESCE(v_args->>'token', '')), '');
  v_token_fingerprint TEXT := NULL;
  v_headers JSONB := CASE WHEN jsonb_typeof(v_args->'headers') = 'object' THEN v_args->'headers' ELSE '{}'::jsonb END;
  v_metadata JSONB := CASE WHEN jsonb_typeof(v_args->'metadata') = 'object' THEN v_args->'metadata' ELSE '{}'::jsonb END;
  v_correlation_id UUID := NULL;
  v_provider_auth_config_id UUID := NULL;
  v_source_id UUID := NULL;
  v_source_org_id UUID := NULL;
  v_source_client_id UUID := NULL;
  v_source_sender_id UUID := NULL;
  v_id UUID;
  v_path TEXT := NULLIF(btrim(COALESCE(v_args->>'path', '')), '');
  v_query_string TEXT := NULLIF(btrim(COALESCE(v_args->>'query_string', '')), '');
BEGIN
  IF v_service NOT IN ('api_gateway', 'webhook_receiver') THEN
    RAISE EXCEPTION 'record_intake_auth_rejection_v1 unsupported service: %', COALESCE(v_service, '(missing)')
      USING ERRCODE = '22023';
  END IF;

  IF v_surface IS NULL THEN
    v_surface := v_service;
  END IF;

  IF v_http_status < 400 OR v_http_status > 499 THEN
    v_http_status := 401;
  END IF;

  IF NULLIF(v_args->>'correlation_id', '') IS NOT NULL THEN
    BEGIN
      v_correlation_id := (v_args->>'correlation_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_metadata := v_metadata || jsonb_build_object('invalid_correlation_id', v_args->>'correlation_id');
    END;
  END IF;

  IF NULLIF(v_args->>'provider_auth_config_id', '') IS NOT NULL THEN
    BEGIN
      v_provider_auth_config_id := (v_args->>'provider_auth_config_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_metadata := v_metadata || jsonb_build_object('invalid_provider_auth_config_id', v_args->>'provider_auth_config_id');
    END;
  END IF;

  IF v_token IS NOT NULL THEN
    v_token_fingerprint := encode(digest(v_token, 'sha256'), 'hex');
    SELECT src.id, src.organization_id, src.client_id, src.sender_id
      INTO v_source_id, v_source_org_id, v_source_client_id, v_source_sender_id
      FROM public.get_webhook_source_by_token(v_token)
      AS src(id, source_identifier, provider_type, organization_id, sender_id, client_id, enabled, mapping_config_id)
      LIMIT 1;
  END IF;

  v_path := public.redact_intake_auth_secret_text(COALESCE(v_path, ''));
  v_query_string := NULLIF(public.redact_intake_auth_secret_text(COALESCE(v_query_string, '')), '');

  INSERT INTO public.intake_auth_rejections (
    service,
    surface,
    credential_kind,
    failure_code,
    failure_message,
    http_status,
    organization_id,
    source_id,
    client_id,
    sender_id,
    provider_auth_config_id,
    correlation_id,
    request_id,
    method,
    path,
    query_string,
    token_fingerprint,
    request_headers,
    metadata
  )
  VALUES (
    v_service,
    v_surface,
    v_credential_kind,
    v_failure_code,
    v_failure_message,
    v_http_status,
    v_source_org_id,
    v_source_id,
    v_source_client_id,
    v_source_sender_id,
    v_provider_auth_config_id,
    v_correlation_id,
    NULLIF(btrim(COALESCE(v_args->>'request_id', '')), ''),
    upper(NULLIF(btrim(COALESCE(v_args->>'method', '')), '')),
    NULLIF(v_path, ''),
    v_query_string,
    v_token_fingerprint,
    public.redact_intake_auth_secret_json(public.redact_sensitive_headers(v_headers)),
    public.redact_intake_auth_secret_json(v_metadata)
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'status', 'recorded',
    'id', v_id,
    'service', v_service,
    'http_status', v_http_status,
    'organization_id', v_source_org_id,
    'source_id', v_source_id,
    'correlation_id', v_correlation_id
  );
END;
$$;

COMMENT ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) IS
  'Records redacted source-token/provider-auth intake rejection evidence. Intended for edge DB roles; never persists raw tokens.';

REVOKE ALL ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) TO service_role;

DO $grants$
BEGIN
  IF to_regrole('edge_webhook_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) TO edge_webhook_role;
  END IF;
  IF to_regrole('edge_api_gateway_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) TO edge_api_gateway_role;
  END IF;
END;
$grants$;

CREATE OR REPLACE VIEW public.v_intake_auth_rejection_directory
WITH (security_invoker = true)
AS
SELECT
  r.id,
  r.service,
  r.surface,
  r.credential_kind,
  r.failure_code,
  r.failure_message,
  r.http_status,
  r.organization_id,
  r.source_id,
  r.source_id AS webhook_source_id,
  COALESCE(ws.name, r.source_id::text) AS source_label,
  ws.source_identifier,
  ws.provider_type,
  r.client_id,
  c.name AS client_label,
  r.sender_id,
  s.name AS sender_label,
  r.provider_auth_config_id,
  r.correlation_id,
  r.request_id,
  r.method,
  r.path,
  r.query_string,
  r.token_fingerprint,
  public.redact_intake_auth_secret_json(r.request_headers) AS request_headers,
  public.redact_intake_auth_secret_json(r.metadata) AS metadata,
  r.occurred_at,
  r.created_at,
  r.source_id IS NOT NULL AS source_resolved,
  CASE
    WHEN r.http_status = 401 THEN 'unauthorized'
    WHEN r.http_status = 403 THEN 'forbidden'
    ELSE 'rejected'
  END AS rejection_class
FROM public.intake_auth_rejections r
LEFT JOIN public.webhook_sources ws ON ws.id = r.source_id
LEFT JOIN public.clients c ON c.id = r.client_id
LEFT JOIN public.senders s ON s.id = r.sender_id;

COMMENT ON VIEW public.v_intake_auth_rejection_directory IS
  'Console V2 projection for rejected API/webhook intake authentication. Backed by public.intake_auth_rejections and redacted for browser reads.';

REVOKE ALL ON public.v_intake_auth_rejection_directory FROM PUBLIC;
REVOKE ALL ON public.v_intake_auth_rejection_directory FROM anon;
GRANT SELECT ON public.v_intake_auth_rejection_directory TO authenticated;
GRANT SELECT ON public.v_intake_auth_rejection_directory TO service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.record_intake_auth_rejection_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.record_intake_auth_rejection_v1($1);
$$;

REVOKE ALL ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) FROM authenticated;
GRANT USAGE ON SCHEMA api TO service_role;
GRANT EXECUTE ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) TO service_role;

DO $api_grants$
BEGIN
  IF to_regrole('edge_webhook_role') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA api TO edge_webhook_role;
    GRANT EXECUTE ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) TO edge_webhook_role;
  END IF;
  IF to_regrole('edge_api_gateway_role') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA api TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) TO edge_api_gateway_role;
  END IF;
END;
$api_grants$;

DO $read_registry$
DECLARE
  v_scope RECORD;
  v_seen INT := 0;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_next JSONB;
  v_resource JSONB;
  v_resources_to_add JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'api_gateway_auth_rejections',
      'label', 'API gateway auth rejections',
      'relation', 'public.v_intake_auth_rejection_directory',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'api_gateway.read',
      'allow_view_relation', TRUE,
      'base_filter', jsonb_build_object('op', 'and', 'rules', jsonb_build_array(
        jsonb_build_object('key', 'service', 'op', 'eq', 'value', 'api_gateway')
      )),
      'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'service', 'column', 'service', 'op', 'eq'),
        jsonb_build_object('key', 'failure_code', 'column', 'failure_code', 'op', 'eq'),
        jsonb_build_object('key', 'http_status', 'column', 'http_status', 'op', 'eq'),
        jsonb_build_object('key', 'source_id', 'column', 'source_id', 'op', 'eq'),
        jsonb_build_object('key', 'correlation_id', 'column', 'correlation_id', 'op', 'eq'),
        jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'webhook_auth_rejections',
      'label', 'Webhook auth rejections',
      'relation', 'public.v_intake_auth_rejection_directory',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'webhooks.read',
      'allow_view_relation', TRUE,
      'base_filter', jsonb_build_object('op', 'and', 'rules', jsonb_build_array(
        jsonb_build_object('key', 'service', 'op', 'eq', 'value', 'webhook_receiver')
      )),
      'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'service', 'column', 'service', 'op', 'eq'),
        jsonb_build_object('key', 'failure_code', 'column', 'failure_code', 'op', 'eq'),
        jsonb_build_object('key', 'http_status', 'column', 'http_status', 'op', 'eq'),
        jsonb_build_object('key', 'source_id', 'column', 'source_id', 'op', 'eq'),
        jsonb_build_object('key', 'correlation_id', 'column', 'correlation_id', 'op', 'eq'),
        jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq')
      )
    )
  );
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_seen := v_seen + 1;
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    FOR v_resource IN SELECT value FROM jsonb_array_elements(v_resources_to_add) AS value LOOP
      SELECT COALESCE(jsonb_agg(resource), '[]'::jsonb)
        INTO v_filtered
        FROM jsonb_array_elements(v_resources) AS resource
       WHERE resource->>'key' <> v_resource->>'key';
      v_resources := v_filtered || jsonb_build_array(v_resource);
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_next,
           version = v_scope.version + 1,
           change_reason = 'Expose intake auth rejection readback resources for Console V2',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_next;

    UPDATE public.settings s
       SET cached_value = v_next,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_next;
  END LOOP;

  IF v_seen = 0 THEN
    RAISE EXCEPTION 'ui_read_registry settings missing';
  END IF;
END;
$read_registry$;

DELETE FROM public.settings_cache
 WHERE cache_key LIKE 'ui_read_registry:%';

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'v_intake_auth_rejection_directory'
       AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'v_intake_auth_rejection_directory must remain a security_invoker view';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'api_gateway_auth_rejections'
            AND resource->>'relation' = 'public.v_intake_auth_rejection_directory'
            AND resource->>'capability_read' = 'api_gateway.read'
       )
  ) THEN
    RAISE EXCEPTION 'api_gateway_auth_rejections missing from one or more ui_read_registry scopes';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'webhook_auth_rejections'
            AND resource->>'relation' = 'public.v_intake_auth_rejection_directory'
            AND resource->>'capability_read' = 'webhooks.read'
       )
  ) THEN
    RAISE EXCEPTION 'webhook_auth_rejections missing from one or more ui_read_registry scopes';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202605121015_intake_auth_rejection_ledger_v1'));

COMMIT;
