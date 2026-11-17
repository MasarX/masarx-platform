-- Canonical append-only rejection evidence for public API/webhook ingress.
--
-- Rejected source credentials must remain observable without creating synthetic
-- api_gateway_requests, webhook_inbox, outbound_calls, workflow runs, or
-- shipments. HMAC failures are mirrored only after a real webhook inbox row has
-- produced a terminal response decision.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607151310_intake_auth_rejection_credential_lineage_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- Append-only ledgers
-- ---------------------------------------------------------------------------

CREATE TABLE public.intake_auth_rejections (
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
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT intake_auth_rejections_service_ck
    CHECK (service IN ('api_gateway', 'webhook_receiver')),
  CONSTRAINT intake_auth_rejections_status_ck
    CHECK (http_status BETWEEN 400 AND 499),
  CONSTRAINT intake_auth_rejections_headers_object_ck
    CHECK (jsonb_typeof(request_headers) = 'object'),
  CONSTRAINT intake_auth_rejections_metadata_object_ck
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_intake_auth_rejections_occurred_at
  ON public.intake_auth_rejections(occurred_at DESC);
CREATE INDEX idx_intake_auth_rejections_service_time
  ON public.intake_auth_rejections(service, occurred_at DESC);
CREATE INDEX idx_intake_auth_rejections_org_time
  ON public.intake_auth_rejections(organization_id, occurred_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX idx_intake_auth_rejections_source_time
  ON public.intake_auth_rejections(source_id, occurred_at DESC)
  WHERE source_id IS NOT NULL;
CREATE INDEX idx_intake_auth_rejections_correlation
  ON public.intake_auth_rejections(correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE public.intake_auth_rejections IS
  'Immutable append-only redacted evidence for public API/webhook credential failures. Rejection evidence never substitutes for an operational request, inbox, workflow, outbound call, or shipment row.';
COMMENT ON COLUMN public.intake_auth_rejections.token_fingerprint IS
  'SHA-256 correlation fingerprint of a presented source token. Raw token material is never persisted.';

-- objectives:allow POLICY_MISSING Justification: credential history is service-role-only; PUBLIC, anon, and authenticated are explicitly revoked below, so no client RLS policy exists by design.
CREATE TABLE public.webhook_source_token_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.webhook_sources(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID NULL REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID NULL REFERENCES public.senders(id) ON DELETE SET NULL,
  retired_auth_token_hash TEXT NOT NULL,
  retired_reason TEXT NOT NULL,
  retired_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webhook_source_token_history_reason_ck
    CHECK (retired_reason IN ('rotated', 'archived', 'revoked')),
  CONSTRAINT webhook_source_token_history_metadata_object_ck
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_webhook_source_token_history_source_hash
  ON public.webhook_source_token_history(source_id, retired_auth_token_hash);
CREATE INDEX idx_webhook_source_token_history_org_time
  ON public.webhook_source_token_history(organization_id, retired_at DESC);
CREATE INDEX idx_webhook_source_token_history_source_time
  ON public.webhook_source_token_history(source_id, retired_at DESC);

COMMENT ON TABLE public.webhook_source_token_history IS
  'Immutable append-only lifecycle events for retired webhook-source bcrypt hashes. Raw tokens are never stored.';
COMMENT ON COLUMN public.webhook_source_token_history.retired_auth_token_hash IS
  'Prior bcrypt hash captured after rotation, archive, or revocation; never raw credential material.';

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES
  (
    'public',
    'intake_auth_rejections',
    TRUE,
    FALSE,
    FALSE,
    'Immutable append-only auth-rejection evidence; no updated_at and no mutable audit shadow.'
  ),
  (
    'public',
    'webhook_source_token_history',
    TRUE,
    FALSE,
    FALSE,
    'Immutable append-only webhook credential lineage; no updated_at and no mutable audit shadow.'
  )
ON CONFLICT (table_schema, table_name) DO UPDATE
SET created_at_required = EXCLUDED.created_at_required,
    updated_at_required = EXCLUDED.updated_at_required,
    audit_enabled = EXCLUDED.audit_enabled,
    notes = EXCLUDED.notes,
    updated_at = clock_timestamp();

CREATE OR REPLACE FUNCTION public.intake_auth_append_only_immutable_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only and immutable', TG_TABLE_NAME
    USING ERRCODE = '2F003';
END;
$function$;

REVOKE ALL ON FUNCTION public.intake_auth_append_only_immutable_v1() FROM PUBLIC;

CREATE TRIGGER intake_auth_rejections_immutable_trg
BEFORE UPDATE OR DELETE ON public.intake_auth_rejections
FOR EACH ROW
EXECUTE FUNCTION public.intake_auth_append_only_immutable_v1();

CREATE TRIGGER webhook_source_token_history_immutable_trg
BEFORE UPDATE OR DELETE ON public.webhook_source_token_history
FOR EACH ROW
EXECUTE FUNCTION public.intake_auth_append_only_immutable_v1();

-- ---------------------------------------------------------------------------
-- Scope and privileges
-- ---------------------------------------------------------------------------

ALTER TABLE public.intake_auth_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_source_token_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.intake_auth_rejections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.webhook_source_token_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.intake_auth_rejections TO authenticated, service_role;
GRANT SELECT ON TABLE public.webhook_source_token_history TO service_role;

CREATE POLICY intake_auth_rejections_select
  ON public.intake_auth_rejections
  FOR SELECT
  TO authenticated
  USING (
    (
      (
        service = 'api_gateway'
        AND COALESCE((public.user_capability_eval_v1('api_gateway.read')->>'allowed')::BOOLEAN, FALSE)
      )
      OR (
        service = 'webhook_receiver'
        AND COALESCE((public.user_capability_eval_v1('webhooks.read')->>'allowed')::BOOLEAN, FALSE)
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

-- ---------------------------------------------------------------------------
-- Redaction and credential lineage
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.redact_intake_auth_secret_text(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    ELSE regexp_replace(
      regexp_replace(
        regexp_replace(
          p_value,
          '(/api-gateway/t/)[^/?#\s]+',
          '\1[redacted]',
          'gi'
        ),
        '(/api-gateway/)(?!t(?:/|$))[^/?#\s]+',
        '\1[redacted]',
        'gi'
      ),
      '(^|[?&])(token|auth_token|api_key|apikey|secret|signature|hmac|x_signature|x-signature|x-hub-signature|x-hub-signature-256|key|password|credential)=([^&#\s]*)',
      '\1\2=[redacted]',
      'gi'
    )
  END;
$function$;

CREATE OR REPLACE FUNCTION public.redact_intake_auth_secret_json(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
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
          'credential',
          'retired_token_history_id',
          'token_history_id'
        ) OR v_key_lower LIKE '%token_history_id' THEN
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
      SELECT COALESCE(
               jsonb_agg(public.redact_intake_auth_secret_json(value) ORDER BY ord),
               '[]'::jsonb
             )
        INTO v_result
        FROM jsonb_array_elements(p_value) WITH ORDINALITY AS arr(value, ord);
      RETURN v_result;
    WHEN 'string' THEN
      RETURN to_jsonb(public.redact_intake_auth_secret_text(p_value #>> '{}'));
    ELSE
      RETURN p_value;
  END CASE;
END;
$function$;

REVOKE ALL ON FUNCTION public.redact_intake_auth_secret_text(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redact_intake_auth_secret_json(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redact_intake_auth_secret_text(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redact_intake_auth_secret_json(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.capture_webhook_source_token_lineage_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_reason TEXT;
  v_client_id UUID;
  v_correlation_id UUID;
  v_correlation_text TEXT := NULLIF(current_setting('request.correlation_id', TRUE), '');
BEGIN
  IF OLD.auth_token_hash IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.enabled IS TRUE AND NEW.enabled IS FALSE THEN
    v_reason := CASE
      WHEN lower(COALESCE(NEW.managed_metadata->>'lifecycle', '')) = 'archived' THEN 'archived'
      ELSE 'revoked'
    END;
  ELSIF OLD.auth_token_hash IS DISTINCT FROM NEW.auth_token_hash THEN
    v_reason := 'rotated';
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.sender_id IS NOT NULL THEN
    SELECT s.client_id
      INTO v_client_id
      FROM public.senders s
     WHERE s.id = NEW.sender_id
     LIMIT 1;
  END IF;

  IF v_correlation_text IS NOT NULL THEN
    BEGIN
      v_correlation_id := v_correlation_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_correlation_id := NULL;
    END;
  END IF;

  INSERT INTO public.webhook_source_token_history (
    source_id,
    organization_id,
    client_id,
    sender_id,
    retired_auth_token_hash,
    retired_reason,
    retired_by_user_id,
    correlation_id,
    metadata
  )
  VALUES (
    NEW.id,
    NEW.organization_id,
    v_client_id,
    NEW.sender_id,
    OLD.auth_token_hash,
    v_reason,
    auth.uid(),
    v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'source_identifier', NEW.source_identifier,
      'previous_enabled', OLD.enabled,
      'next_enabled', NEW.enabled,
      'next_lifecycle', NULLIF(NEW.managed_metadata->>'lifecycle', '')
    ))
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_webhook_source_token_lineage_v1() FROM PUBLIC;

CREATE TRIGGER webhook_sources_capture_token_lineage_trg
AFTER UPDATE OF auth_token_hash, enabled, managed_metadata ON public.webhook_sources
FOR EACH ROW
EXECUTE FUNCTION public.capture_webhook_source_token_lineage_v1();

CREATE OR REPLACE FUNCTION public.resolve_retired_webhook_source_by_token_v1(p_token TEXT)
RETURNS TABLE (
  id UUID,
  source_identifier TEXT,
  provider_type TEXT,
  organization_id UUID,
  sender_id UUID,
  client_id UUID,
  enabled BOOLEAN,
  mapping_config_id UUID,
  token_history_id UUID,
  retired_reason TEXT,
  retired_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT
    ws.id,
    ws.source_identifier,
    ws.provider_type,
    h.organization_id,
    h.sender_id,
    COALESCE(h.client_id, s.client_id),
    ws.enabled,
    ws.mapping_config_id,
    h.id,
    h.retired_reason,
    h.retired_at
  FROM public.webhook_source_token_history h
  JOIN public.webhook_sources ws ON ws.id = h.source_id
  LEFT JOIN public.senders s ON s.id = h.sender_id
  WHERE NULLIF(btrim(COALESCE(p_token, '')), '') IS NOT NULL
    AND extensions.crypt(p_token, h.retired_auth_token_hash) = h.retired_auth_token_hash
  ORDER BY h.retired_at DESC, h.created_at DESC
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) IS
  'Internal source-lineage resolver for rotated/revoked webhook tokens. Exposes no raw or hashed credential to browser roles.';

REVOKE ALL ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- Canonical recorder and one-time token rotation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_intake_auth_rejection_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_service TEXT := lower(NULLIF(btrim(COALESCE(v_args->>'service', '')), ''));
  v_surface TEXT := lower(NULLIF(btrim(COALESCE(v_args->>'surface', '')), ''));
  v_credential_kind TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_args->>'credential_kind', '')), ''), 'source_token'));
  v_failure_code TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_args->>'failure_code', '')), ''), 'unauthorized'));
  v_failure_message TEXT := NULLIF(btrim(COALESCE(v_args->>'failure_message', v_args->>'message', '')), '');
  v_http_status INTEGER := 401;
  v_token TEXT := NULLIF(btrim(COALESCE(v_args->>'token', '')), '');
  v_token_fingerprint TEXT;
  v_headers JSONB := CASE WHEN jsonb_typeof(v_args->'headers') = 'object' THEN v_args->'headers' ELSE '{}'::jsonb END;
  v_metadata JSONB := CASE WHEN jsonb_typeof(v_args->'metadata') = 'object' THEN v_args->'metadata' ELSE '{}'::jsonb END;
  v_correlation_id UUID;
  v_provider_auth_config_id UUID;
  v_provider_auth_exists BOOLEAN := FALSE;
  v_provider_auth_expires_at TIMESTAMPTZ;
  v_source_id UUID;
  v_source_org_id UUID;
  v_source_client_id UUID;
  v_source_sender_id UUID;
  v_source_enabled BOOLEAN;
  v_source_lifecycle TEXT;
  v_retired_history_id UUID;
  v_retired_reason TEXT;
  v_id UUID;
  v_path TEXT := NULLIF(btrim(COALESCE(v_args->>'path', '')), '');
  v_query_string TEXT := NULLIF(btrim(COALESCE(v_args->>'query_string', '')), '');
BEGIN
  IF v_service NOT IN ('api_gateway', 'webhook_receiver') THEN
    RAISE EXCEPTION 'record_intake_auth_rejection_v1 unsupported service: %', COALESCE(v_service, '(missing)')
      USING ERRCODE = '22023';
  END IF;

  v_surface := COALESCE(v_surface, v_service);

  BEGIN
    v_http_status := COALESCE(NULLIF(v_args->>'http_status', '')::INTEGER, 401);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    v_http_status := 401;
  END;
  IF v_http_status < 400 OR v_http_status > 499 THEN
    v_http_status := 401;
  END IF;

  IF NULLIF(v_args->>'correlation_id', '') IS NOT NULL THEN
    BEGIN
      v_correlation_id := (v_args->>'correlation_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_metadata := v_metadata || jsonb_build_object('invalid_correlation_id', v_args->>'correlation_id');
    END;
  END IF;

  IF NULLIF(v_args->>'provider_auth_config_id', '') IS NOT NULL THEN
    BEGIN
      v_provider_auth_config_id := (v_args->>'provider_auth_config_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_metadata := v_metadata || jsonb_build_object('invalid_provider_auth_config_id', v_args->>'provider_auth_config_id');
    END;
  END IF;

  IF v_provider_auth_config_id IS NOT NULL THEN
    SELECT TRUE, pac.expires_at
      INTO v_provider_auth_exists, v_provider_auth_expires_at
      FROM public.provider_auth_configs pac
     WHERE pac.id = v_provider_auth_config_id
     LIMIT 1;

    v_metadata := v_metadata || jsonb_build_object(
      'provider_credential_state',
      CASE
        WHEN v_failure_code = 'hmac_auth_config_missing'
          OR COALESCE(v_provider_auth_exists, FALSE) IS FALSE THEN 'missing'
        WHEN v_failure_code = 'hmac_credential_expired'
          OR (v_provider_auth_expires_at IS NOT NULL AND v_provider_auth_expires_at <= clock_timestamp()) THEN 'expired'
        WHEN v_failure_code = 'hmac_credential_unavailable' THEN 'unavailable'
        ELSE 'available'
      END
    );
  ELSIF v_credential_kind = 'hmac_signature' THEN
    v_metadata := v_metadata || jsonb_build_object('provider_credential_state', 'missing_reference');
  END IF;

  IF v_token IS NOT NULL THEN
    v_token_fingerprint := encode(digest(v_token, 'sha256'), 'hex');
  END IF;

  IF NULLIF(v_args->>'source_id', '') IS NOT NULL THEN
    BEGIN
      v_source_id := (v_args->>'source_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_source_id := NULL;
      v_metadata := v_metadata || jsonb_build_object('invalid_source_id', v_args->>'source_id');
    END;
  END IF;

  IF v_source_id IS NOT NULL THEN
    SELECT ws.organization_id,
           s.client_id,
           ws.sender_id,
           ws.enabled,
           NULLIF(ws.managed_metadata->>'lifecycle', '')
      INTO v_source_org_id,
           v_source_client_id,
           v_source_sender_id,
           v_source_enabled,
           v_source_lifecycle
      FROM public.webhook_sources ws
      LEFT JOIN public.senders s ON s.id = ws.sender_id
     WHERE ws.id = v_source_id
     LIMIT 1;

    IF v_source_org_id IS NULL THEN
      v_source_id := NULL;
      v_metadata := v_metadata || jsonb_build_object('source_resolution', 'unresolved_source_id');
    END IF;
  ELSIF v_token IS NOT NULL THEN
    SELECT src.id,
           src.organization_id,
           src.client_id,
           src.sender_id,
           src.enabled,
           NULLIF(ws.managed_metadata->>'lifecycle', '')
      INTO v_source_id,
           v_source_org_id,
           v_source_client_id,
           v_source_sender_id,
           v_source_enabled,
           v_source_lifecycle
      FROM public.get_webhook_source_by_token(v_token)
      AS src(id, source_identifier, provider_type, organization_id, sender_id, client_id, enabled, mapping_config_id)
      JOIN public.webhook_sources ws ON ws.id = src.id
      LIMIT 1;

    IF v_source_id IS NULL THEN
      SELECT src.id,
             src.organization_id,
             src.client_id,
             src.sender_id,
             src.enabled,
             src.token_history_id,
             src.retired_reason
        INTO v_source_id,
             v_source_org_id,
             v_source_client_id,
             v_source_sender_id,
             v_source_enabled,
             v_retired_history_id,
             v_retired_reason
        FROM public.resolve_retired_webhook_source_by_token_v1(v_token)
        AS src(id, source_identifier, provider_type, organization_id, sender_id, client_id, enabled, mapping_config_id, token_history_id, retired_reason, retired_at)
        LIMIT 1;

      IF v_source_id IS NOT NULL THEN
        v_metadata := v_metadata || jsonb_build_object(
          'source_resolution', 'retired_webhook_source_token',
          'retired_reason', v_retired_reason,
          'retired_token_history_id', v_retired_history_id
        );
      ELSE
        v_metadata := v_metadata || jsonb_build_object('source_resolution', 'unresolved_source_token');
      END IF;
    END IF;
  ELSE
    v_metadata := v_metadata || jsonb_build_object('source_resolution', 'missing_source_token');
  END IF;

  IF v_source_id IS NOT NULL AND NOT (v_metadata ? 'source_resolution') THEN
    v_metadata := v_metadata || jsonb_build_object(
      'source_resolution',
      CASE
        WHEN COALESCE(v_source_enabled, FALSE) IS TRUE THEN 'active_webhook_source_token'
        WHEN lower(COALESCE(v_source_lifecycle, '')) = 'archived' THEN 'archived_webhook_source_token'
        ELSE 'revoked_webhook_source_token'
      END
    );
  END IF;

  v_path := NULLIF(public.redact_intake_auth_secret_text(COALESCE(v_path, '')), '');
  v_query_string := NULLIF(public.redact_intake_auth_secret_text(COALESCE(v_query_string, '')), '');
  v_failure_message := NULLIF(public.redact_intake_auth_secret_text(COALESCE(v_failure_message, '')), '');

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
    v_path,
    v_query_string,
    v_token_fingerprint,
    public.redact_intake_auth_secret_json(public.redact_sensitive_headers(v_headers)),
    public.redact_intake_auth_secret_json(v_metadata)
  )
  RETURNING id INTO v_id;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', 'recorded',
    'id', v_id,
    'service', v_service,
    'http_status', v_http_status,
    'organization_id', v_source_org_id,
    'source_id', v_source_id,
    'correlation_id', v_correlation_id
  ));
END;
$function$;

COMMENT ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) IS
  'Writes one redacted append-only rejection event. Resolves active, revoked, archived, and retired source lineage without creating operational request/inbox/workflow/shipment state.';

REVOKE ALL ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.ui_rotate_webhook_source_token_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID;
  v_before public.webhook_sources%ROWTYPE;
  v_minted_token TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  BEGIN
    v_resource_id := NULLIF(p_args->>'source_id', '')::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    v_resource_id := NULL;
  END;

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 requires source_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT *
    INTO v_before
    FROM public.webhook_sources
   WHERE id = v_resource_id
   FOR UPDATE;

  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 webhook_source % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 webhook_source % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('request.correlation_id', v_correlation_id::TEXT, TRUE);
  v_minted_token := encode(gen_random_bytes(32), 'hex');

  UPDATE public.webhook_sources
     SET auth_token = v_minted_token,
         updated_at = clock_timestamp()
   WHERE id = v_resource_id;

  INSERT INTO public.decision_log (
    id,
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    performed_by_system,
    correlation_id
  )
  VALUES (
    v_decision_id,
    v_before.organization_id,
    'webhooks.rotate_source_token',
    'webhook_source',
    v_resource_id,
    'ui_rotate_webhook_source_token_v1',
    'rotated',
    '{}'::jsonb,
    'ui_rotate_webhook_source_token_v1',
    v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id,
    event_type,
    resource_type,
    resource_id,
    payload,
    correlation_id,
    status
  )
  VALUES (
    v_before.organization_id,
    'webhook_source.token_rotated',
    'webhook_source',
    v_resource_id,
    '{}'::jsonb,
    v_correlation_id,
    'pending'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'webhook_source_id', v_resource_id,
    'auth_token', v_minted_token,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_rotate_webhook_source_token_v1(JSONB) IS
  'Canonical one-time webhook token rotation. The shared webhook_sources lineage trigger records the prior bcrypt hash exactly once as a new immutable event.';

REVOKE ALL ON FUNCTION public.ui_rotate_webhook_source_token_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_rotate_webhook_source_token_v1(JSONB) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- HMAC failures: mirror only real terminal webhook response decisions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mirror_webhook_hmac_auth_rejection_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_validation JSONB := COALESCE(NEW.decision_inputs#>'{validation_results,hmac}', '{}'::jsonb);
  v_message TEXT := NULLIF(v_validation->>'message', '');
  v_failure_code TEXT;
  v_http_status INTEGER := 401;
  v_inbox public.webhook_inbox%ROWTYPE;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_hmac JSONB := '{}'::jsonb;
  v_auth_config_id UUID;
  v_auth_exists BOOLEAN := FALSE;
  v_auth_expires_at TIMESTAMPTZ;
BEGIN
  IF NEW.resource_type IS DISTINCT FROM 'webhook_inbox'
     OR NEW.decision_category IS DISTINCT FROM 'http_response_emitted'
     OR v_validation->>'status' IS DISTINCT FROM 'failed' THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_inbox
    FROM public.webhook_inbox wi
   WHERE wi.id = NEW.resource_id
   LIMIT 1;

  IF v_inbox.id IS NULL THEN
    RAISE EXCEPTION 'HMAC rejection decision % has no canonical webhook inbox row', NEW.id
      USING ERRCODE = '23503';
  END IF;

  -- The core may replay an older acknowledgement before re-running validation.
  -- Only the decision that shares the canonical inbox correlation represents
  -- the original HMAC validation event; replayed validation payloads are stale.
  IF NEW.correlation_id IS DISTINCT FROM v_inbox.correlation_id THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_inbox.webhook_source_id)
   LIMIT 1;
  v_policy := COALESCE(v_policy_row.policy, '{}'::jsonb);
  v_hmac := COALESCE(v_policy#>'{validation,hmac}', '{}'::jsonb);

  IF NULLIF(v_hmac->>'auth_config_id', '') IS NOT NULL THEN
    BEGIN
      v_auth_config_id := (v_hmac->>'auth_config_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_auth_config_id := NULL;
    END;
  END IF;

  IF v_auth_config_id IS NOT NULL THEN
    SELECT TRUE, pac.expires_at
      INTO v_auth_exists, v_auth_expires_at
      FROM public.provider_auth_configs pac
     WHERE pac.id = v_auth_config_id
     LIMIT 1;
  END IF;

  v_failure_code := CASE
    WHEN v_message ILIKE 'Missing signature header %' THEN 'hmac_signature_missing'
    WHEN v_message = 'Missing auth_config reference for HMAC validation' THEN 'hmac_auth_config_missing'
    WHEN v_message = 'Signing secret missing' OR v_message ILIKE 'Signing secret missing in %' THEN
      CASE
        WHEN v_auth_config_id IS NULL OR COALESCE(v_auth_exists, FALSE) IS FALSE THEN 'hmac_auth_config_missing'
        WHEN v_auth_expires_at IS NOT NULL AND v_auth_expires_at <= clock_timestamp() THEN 'hmac_credential_expired'
        ELSE 'hmac_credential_unavailable'
      END
    WHEN v_message = 'HMAC signature mismatch' THEN 'hmac_signature_mismatch'
    ELSE 'hmac_validation_failed'
  END;

  BEGIN
    v_http_status := COALESCE(NULLIF(NEW.decision_inputs->>'status', '')::INTEGER, 401);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    v_http_status := 401;
  END;
  IF v_http_status < 400 OR v_http_status > 499 THEN
    v_http_status := 401;
  END IF;

  PERFORM public.record_intake_auth_rejection_v1(
    jsonb_strip_nulls(jsonb_build_object(
      'service', 'webhook_receiver',
      'surface', 'webhook_receiver',
      'credential_kind', 'hmac_signature',
      'source_id', v_inbox.webhook_source_id,
      'http_status', v_http_status,
      'failure_code', v_failure_code,
      'failure_message', COALESCE(v_message, 'HMAC validation failed'),
      'method', 'POST',
      'headers', COALESCE(v_inbox.headers, '{}'::jsonb),
      'correlation_id', COALESCE(v_inbox.correlation_id, NEW.correlation_id),
      'request_id', COALESCE(v_inbox.idempotency_key, v_inbox.correlation_id::TEXT),
      'provider_auth_config_id', v_auth_config_id,
      'metadata', jsonb_strip_nulls(jsonb_build_object(
        'edge_stage', 'workflow_intake_webhook_core_v1',
        'auth_surface', 'hmac_signature',
        'webhook_inbox_id', v_inbox.id,
        'hmac_header', NULLIF(v_hmac->>'header', ''),
        'hmac_algorithm', NULLIF(v_hmac->>'algorithm', ''),
        'hmac_signature_encoding', NULLIF(v_hmac->>'signature_encoding', ''),
        'provided_signature_present', COALESCE(v_inbox.headers, '{}'::jsonb) ? lower(COALESCE(NULLIF(v_hmac->>'header', ''), 'x-signature')),
        'validation_results', v_validation
      ))
    ))
  );

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.mirror_webhook_hmac_auth_rejection_v1() IS
  'Mirrors a real non-replayed terminal webhook HMAC response decision into redacted rejection evidence. It never creates request, inbox, workflow, outbound-call, or shipment truth.';

REVOKE ALL ON FUNCTION public.mirror_webhook_hmac_auth_rejection_v1() FROM PUBLIC;

CREATE TRIGGER decision_log_mirror_webhook_hmac_auth_rejection_trg
AFTER INSERT ON public.decision_log
FOR EACH ROW
WHEN (
  NEW.resource_type = 'webhook_inbox'
  AND NEW.decision_category = 'http_response_emitted'
)
EXECUTE FUNCTION public.mirror_webhook_hmac_auth_rejection_v1();

-- ---------------------------------------------------------------------------
-- Safe read projection, API wrappers, and row-driven UI registry
-- ---------------------------------------------------------------------------

CREATE VIEW public.v_intake_auth_rejection_directory
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
  COALESCE(ws.name, r.source_id::TEXT) AS source_label,
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
  r.metadata->>'source_resolution' AS source_resolution,
  r.metadata->>'retired_reason' AS retired_reason,
  r.metadata->>'provider_credential_state' AS provider_credential_state,
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
  'Security-invoker operator projection for scoped, redacted API/webhook authentication failures.';

REVOKE ALL ON public.v_intake_auth_rejection_directory FROM PUBLIC, anon;
GRANT SELECT ON public.v_intake_auth_rejection_directory TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.record_intake_auth_rejection_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.record_intake_auth_rejection_v1(p_args);
$function$;

CREATE OR REPLACE FUNCTION api.ui_rotate_webhook_source_token_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_rotate_webhook_source_token_v1(p_args);
$function$;

REVOKE ALL ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.ui_rotate_webhook_source_token_v1(JSONB) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION api.ui_rotate_webhook_source_token_v1(JSONB) TO authenticated, service_role;

DO $edge_grants$
BEGIN
  IF to_regrole('edge_webhook_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) TO edge_webhook_role;
    GRANT EXECUTE ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) TO edge_webhook_role;
    GRANT USAGE ON SCHEMA api TO edge_webhook_role;
    GRANT EXECUTE ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) TO edge_webhook_role;
  END IF;
  IF to_regrole('edge_api_gateway_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) TO edge_api_gateway_role;
    GRANT USAGE ON SCHEMA api TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.record_intake_auth_rejection_v1(JSONB) TO edge_api_gateway_role;
  END IF;
END;
$edge_grants$;

DO $read_registry$
DECLARE
  v_scope RECORD;
  v_seen INTEGER := 0;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB;
  v_resource_to_add JSONB;
  v_resources_to_add JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'api_gateway_auth_rejections',
      'label', 'API gateway auth rejections',
      'relation', 'public.v_intake_auth_rejection_directory',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id', 'sender', 'sender_id'),
      'capability_read', 'api_gateway.read',
      'allow_view_relation', TRUE,
      'base_filter', jsonb_build_object('op', 'and', 'rules', jsonb_build_array(
        jsonb_build_object('key', 'service', 'op', 'eq', 'value', 'api_gateway')
      )),
      'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
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
      'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id', 'sender', 'sender_id'),
      'capability_read', 'webhooks.read',
      'allow_view_relation', TRUE,
      'base_filter', jsonb_build_object('op', 'and', 'rules', jsonb_build_array(
        jsonb_build_object('key', 'service', 'op', 'eq', 'value', 'webhook_receiver')
      )),
      'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
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
    SELECT s.scope_type,
           s.scope_id,
           COALESCE(sv.schema_version, 1) AS schema_version,
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

    FOR v_resource_to_add IN
      SELECT value FROM jsonb_array_elements(v_resources_to_add)
    LOOP
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        INTO v_filtered
        FROM jsonb_array_elements(v_resources)
       WHERE value->>'key' <> v_resource_to_add->>'key';
      v_resources := v_filtered || jsonb_build_array(v_resource_to_add);
    END LOOP;

    v_resource := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    PERFORM 1
      FROM public.upsert_settings_value_v1(
        'ui_read_registry',
        v_scope.scope_type,
        v_scope.scope_id,
        v_resource,
        v_scope.schema_version,
        'Expose scoped append-only public ingress auth rejection evidence'
      );
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
       AND COALESCE(c.reloptions, ARRAY[]::TEXT[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'v_intake_auth_rejection_directory must remain security_invoker';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.intake_auth_rejections'::regclass
       AND tgname = 'intake_auth_rejections_immutable_trg'
       AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.webhook_source_token_history'::regclass
       AND tgname = 'webhook_source_token_history_immutable_trg'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'append-only immutability triggers are required';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND (
         NOT COALESCE(sv.value->'resources', '[]'::jsonb) @> '[{"key":"api_gateway_auth_rejections"}]'::jsonb
         OR NOT COALESCE(sv.value->'resources', '[]'::jsonb) @> '[{"key":"webhook_auth_rejections"}]'::jsonb
       )
  ) THEN
    RAISE EXCEPTION 'auth rejection resources missing from one or more ui_read_registry scopes';
  END IF;

  IF has_table_privilege('authenticated', 'public.webhook_source_token_history', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not read internal webhook token hash lineage';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202607151310_intake_auth_rejection_credential_lineage_v1'));

COMMIT;
