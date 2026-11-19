-- Purpose:
--   Rotated webhook source tokens must fail closed, but operators still need
--   tenant-scoped rejection evidence for old-token attempts. Rotation already
--   stores only bcrypt hashes, so this adds append-only retired-token lineage
--   using the previous hash, never raw token material.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605140135_webhook_source_retired_token_lineage_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.webhook_source_token_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.webhook_sources(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID NULL REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID NULL REFERENCES public.senders(id) ON DELETE SET NULL,
  retired_auth_token_hash TEXT NOT NULL,
  retired_reason TEXT NOT NULL DEFAULT 'rotated',
  retired_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_source_token_history_reason_ck
    CHECK (retired_reason IN ('rotated', 'archived', 'revoked')),
  CONSTRAINT webhook_source_token_history_metadata_object_ck
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_source_token_history_source_hash
  ON public.webhook_source_token_history(source_id, retired_auth_token_hash);
CREATE INDEX IF NOT EXISTS idx_webhook_source_token_history_org_time
  ON public.webhook_source_token_history(organization_id, retired_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_source_token_history_source_time
  ON public.webhook_source_token_history(source_id, retired_at DESC);

COMMENT ON TABLE public.webhook_source_token_history IS
  'Append-only lineage of retired webhook source bcrypt token hashes so old-token rejection attempts can be resolved to tenant/source context without storing raw tokens.';
COMMENT ON COLUMN public.webhook_source_token_history.retired_auth_token_hash IS
  'Retired bcrypt hash copied from webhook_sources.auth_token_hash before rotation/revocation. Raw tokens are never stored.';

ALTER TABLE public.webhook_source_token_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.webhook_source_token_history FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_source_token_history FROM anon;
REVOKE ALL ON TABLE public.webhook_source_token_history FROM authenticated;
GRANT ALL ON TABLE public.webhook_source_token_history TO service_role;

DROP POLICY IF EXISTS webhook_source_token_history_service_policy ON public.webhook_source_token_history;
CREATE POLICY webhook_source_token_history_service_policy
  ON public.webhook_source_token_history
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

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
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
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
  WHERE p_token IS NOT NULL
    AND h.retired_auth_token_hash IS NOT NULL
    AND extensions.crypt(p_token, h.retired_auth_token_hash) = h.retired_auth_token_hash
  ORDER BY h.retired_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) IS
  'Security-definer helper for edge rejection logging: resolves a retired webhook source token hash to tenant/source context without exposing token history to browser roles.';

REVOKE ALL ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) TO service_role;

DO $edge_grants$
BEGIN
  IF to_regrole('edge_webhook_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) TO edge_webhook_role;
  END IF;
  IF to_regrole('edge_api_gateway_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.resolve_retired_webhook_source_by_token_v1(TEXT) TO edge_api_gateway_role;
  END IF;
END;
$edge_grants$;

CREATE OR REPLACE FUNCTION public.ui_rotate_webhook_source_token_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'source_id', '')::uuid;
  v_before public.webhook_sources%ROWTYPE;
  v_client_id UUID := NULL;
  v_minted_token TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'ui_rotate_webhook_source_token_v1 requires source_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before
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

  IF v_before.sender_id IS NOT NULL THEN
    SELECT s.client_id INTO v_client_id
      FROM public.senders s
     WHERE s.id = v_before.sender_id;
  END IF;

  IF v_before.auth_token_hash IS NOT NULL THEN
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
      v_before.id,
      v_before.organization_id,
      v_client_id,
      v_before.sender_id,
      v_before.auth_token_hash,
      'rotated',
      v_user_id,
      v_correlation_id,
      jsonb_build_object('source_identifier', v_before.source_identifier)
    )
    ON CONFLICT (source_id, retired_auth_token_hash) DO UPDATE
      SET retired_at = EXCLUDED.retired_at,
          retired_by_user_id = EXCLUDED.retired_by_user_id,
          correlation_id = EXCLUDED.correlation_id,
          metadata = public.webhook_source_token_history.metadata || EXCLUDED.metadata;
  END IF;

  v_minted_token := encode(gen_random_bytes(32), 'hex');

  UPDATE public.webhook_sources
     SET auth_token = v_minted_token,
         updated_at = now()
   WHERE id = v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id,
    'webhooks.rotate_source_token', 'webhook_source', v_resource_id,
    'ui_rotate_webhook_source_token_v1', 'rotated',
    '{}'::jsonb,
    'ui_rotate_webhook_source_token_v1', v_correlation_id
  );

  IF v_before.organization_id IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_before.organization_id, 'webhook_source.token_rotated', 'webhook_source', v_resource_id,
      '{}'::jsonb, v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'webhook_source_id', v_resource_id,
    'auth_token', v_minted_token,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_rotate_webhook_source_token_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_rotate_webhook_source_token_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_rotate_webhook_source_token_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_rotate_webhook_source_token_v1(jsonb)
  IS 'Canonical write RPC: rotate webhook_sources.auth_token (returned ONCE; bcrypt hash persisted via trigger), preserving retired hash lineage for source-aware rejected-auth readback. Capability: webhooks.write.';

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
  v_retired_history_id UUID := NULL;
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

    IF v_source_id IS NULL THEN
      SELECT src.id, src.organization_id, src.client_id, src.sender_id, src.token_history_id
        INTO v_source_id, v_source_org_id, v_source_client_id, v_source_sender_id, v_retired_history_id
        FROM public.resolve_retired_webhook_source_by_token_v1(v_token)
        AS src(id, source_identifier, provider_type, organization_id, sender_id, client_id, enabled, mapping_config_id, token_history_id, retired_reason, retired_at)
        LIMIT 1;

      IF v_retired_history_id IS NOT NULL THEN
        v_metadata := v_metadata || jsonb_build_object(
          'source_resolution', 'retired_webhook_source_token',
          'retired_token_history_id', v_retired_history_id
        );
      END IF;
    END IF;
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
  'Records redacted source-token/provider-auth intake rejection evidence. Current or retired source tokens resolve to tenant/source context; raw tokens are never persisted.';

REVOKE ALL ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) TO service_role;

DO $record_grants$
BEGIN
  IF to_regrole('edge_webhook_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) TO edge_webhook_role;
  END IF;
  IF to_regrole('edge_api_gateway_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.record_intake_auth_rejection_v1(JSONB) TO edge_api_gateway_role;
  END IF;
END;
$record_grants$;

SELECT pg_advisory_unlock(hashtext('202605140135_webhook_source_retired_token_lineage_v1'));

COMMIT;
