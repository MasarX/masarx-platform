-- Plan: PLAN-202602-fieldops-mobile-store-ga-v2 / Step: S04
-- Migration: Mobile attestation policy + server-side ingest enforcement foundation v1
-- Date: 2026-02-06
--
-- Goal:
--   - Add a row-driven mobile_attestation_policy category + resolver.
--   - Add server-issued, one-time attestation challenges.
--   - Enforce attestation policy server-side on mobile ingest ledgers via triggers.
--   - Keep defaults safe (disabled/off) to avoid rollout regressions.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602061130_mobile_attestation_policy_and_ingest_enforcement_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings category registry
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'mobile_attestation_policy',
  'Mobile app attestation policy for Field Ops ingest. Server-side, ladder-resolved, branch-aware via resource scope.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Schema registry (v1)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'mobile_attestation_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Mobile Attestation Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'mode', jsonb_build_object(
        'type', 'string',
        'enum', jsonb_build_array('off', 'monitor', 'enforce')
      ),
      'enforce_rpcs', jsonb_build_object(
        'type', jsonb_build_array('array', 'null'),
        'items', jsonb_build_object('type', 'string')
      ),
      'allowed_providers', jsonb_build_object(
        'type', jsonb_build_array('array', 'null'),
        'items', jsonb_build_object(
          'type', 'string',
          'enum', jsonb_build_array('android_play_integrity', 'ios_app_attest')
        )
      ),
      'max_age_seconds', jsonb_build_object('type', jsonb_build_array('integer', 'null'), 'minimum', 0),
      'challenge_ttl_seconds', jsonb_build_object('type', jsonb_build_array('integer', 'null'), 'minimum', 30),
      'allow_background_without_attestation', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
      'android_cloud_project_number', jsonb_build_object('type', jsonb_build_array('string', 'null'))
    )
  ),
  'Field Ops mobile attestation policy. Defaults to off; supports monitor/enforce rollout with challenge freshness controls.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', FALSE,
      'mode', 'off',
      'enforce_rpcs', jsonb_build_array(
        'register_user_device_v1',
        'record_location_ping_v1',
        'record_scan_event_v1',
        'open_ops_session_v1'
      ),
      'allowed_providers', jsonb_build_array('android_play_integrity', 'ios_app_attest'),
      'max_age_seconds', 300,
      'challenge_ttl_seconds', 120,
      'allow_background_without_attestation', TRUE,
      'android_cloud_project_number', NULL
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active,
  updated_at = now();

-------------------------------------------------------------------------------
-- 3) Safe global default
-------------------------------------------------------------------------------

WITH defaults AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'mode', 'off',
    'enforce_rpcs', jsonb_build_array(
      'register_user_device_v1',
      'record_location_ping_v1',
      'record_scan_event_v1',
      'open_ops_session_v1'
    ),
    'allowed_providers', jsonb_build_array('android_play_integrity', 'ios_app_attest'),
    'max_age_seconds', 300,
    'challenge_ttl_seconds', 120,
    'allow_background_without_attestation', TRUE,
    'android_cloud_project_number', NULL
  ) AS body
),
inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'mobile_attestation_policy', 'global', NULL, 1, defaults.body, 1, now()
  FROM defaults
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT i.category, i.scope_type, i.scope_id, i.id, i.value, now()
FROM inserted i
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = i.category
    AND s.scope_type = i.scope_type
    AND s.scope_id IS NULL
);

-------------------------------------------------------------------------------
-- 4) Category-specific resolver helper
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_mobile_attestation_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('mobile_attestation_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_mobile_attestation_policy(JSONB)
  IS 'Resolve mobile_attestation_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';

REVOKE ALL ON FUNCTION public.resolve_mobile_attestation_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_attestation_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_attestation_policy(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) Attestation challenge + evidence tables (RLS-enabled)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mobile_attestation_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL,
  device_id UUID NULL,
  resource_id UUID NULL,
  rpc_name TEXT NULL,
  challenge_hash TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  consumed_by_rpc TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mobile_attestation_challenges_hash_nonempty CHECK (btrim(challenge_hash) <> ''),
  CONSTRAINT mobile_attestation_challenges_expiry_valid CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS idx_mobile_attestation_challenges_org_user_exp
  ON public.mobile_attestation_challenges (organization_id, user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_attestation_challenges_device
  ON public.mobile_attestation_challenges (device_id);
CREATE INDEX IF NOT EXISTS idx_mobile_attestation_challenges_pending
  ON public.mobile_attestation_challenges (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.mobile_attestation_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mobile_attestation_challenges FROM PUBLIC;
REVOKE ALL ON TABLE public.mobile_attestation_challenges FROM anon;
REVOKE ALL ON TABLE public.mobile_attestation_challenges FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_attestation_challenges TO service_role;

DROP POLICY IF EXISTS mobile_attestation_challenges_service_policy
  ON public.mobile_attestation_challenges;
CREATE POLICY mobile_attestation_challenges_service_policy
  ON public.mobile_attestation_challenges
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS public.mobile_attestation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL,
  device_id UUID NULL,
  resource_id UUID NULL,
  rpc_name TEXT NOT NULL,
  policy_settings_id UUID NULL,
  policy_scope_type TEXT NULL,
  policy_scope_id UUID NULL,
  policy_mode TEXT NOT NULL,
  provider TEXT NULL,
  passed BOOLEAN NOT NULL,
  failure_reason TEXT NULL,
  event_source TEXT NULL,
  challenge_id UUID NULL,
  generated_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mobile_attestation_events_org_created
  ON public.mobile_attestation_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_attestation_events_org_user
  ON public.mobile_attestation_events (organization_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_attestation_events_rpc
  ON public.mobile_attestation_events (rpc_name, created_at DESC);

ALTER TABLE public.mobile_attestation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mobile_attestation_events FROM PUBLIC;
REVOKE ALL ON TABLE public.mobile_attestation_events FROM anon;
REVOKE ALL ON TABLE public.mobile_attestation_events FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_attestation_events TO service_role;

DROP POLICY IF EXISTS mobile_attestation_events_service_policy
  ON public.mobile_attestation_events;
CREATE POLICY mobile_attestation_events_service_policy
  ON public.mobile_attestation_events
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.mobile_attestation_challenges
  IS 'Server-issued one-time attestation challenges for mobile ingest.';
COMMENT ON TABLE public.mobile_attestation_events
  IS 'Server-side attestation verification outcomes for mobile ingest events.';

-------------------------------------------------------------------------------
-- 6) Public challenge issuance RPC (authenticated + service role)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.issue_mobile_attestation_challenge_v1(
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  challenge_id UUID,
  challenge TEXT,
  expires_at TIMESTAMPTZ,
  policy_mode TEXT,
  policy_scope_type TEXT,
  policy_scope_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_input, '{}'::jsonb);

  v_rpc_name TEXT := NULL;
  v_device_id UUID := NULL;
  v_resource_id UUID := NULL;
  v_metadata JSONB := '{}'::jsonb;

  v_policy RECORD;
  v_policy_value JSONB := '{}'::jsonb;
  v_enabled BOOLEAN := FALSE;
  v_mode TEXT := 'off';
  v_ttl_seconds INT := 120;

  v_challenge TEXT := NULL;
  v_challenge_id UUID := gen_random_uuid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'issue_mobile_attestation_challenge_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'issue_mobile_attestation_challenge_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'issue_mobile_attestation_challenge_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) <> 'object' THEN
    v_in := '{}'::jsonb;
  END IF;

  v_rpc_name := lower(NULLIF(btrim(COALESCE(v_in->>'rpc_name', '')), ''));
  BEGIN
    v_device_id := NULLIF(btrim(COALESCE(v_in->>'device_id', '')), '')::UUID;
  EXCEPTION WHEN others THEN
    v_device_id := NULL;
  END;
  BEGIN
    v_resource_id := NULLIF(btrim(COALESCE(v_in->>'resource_id', '')), '')::UUID;
  EXCEPTION WHEN others THEN
    v_resource_id := NULL;
  END;
  v_metadata := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  SELECT *
    INTO v_policy
    FROM public.resolve_mobile_attestation_policy(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org,
        'user_id', v_user,
        'resource_id', v_resource_id
      ))
    )
    LIMIT 1;

  IF FOUND AND v_policy.value IS NOT NULL THEN
    v_policy_value := COALESCE(v_policy.value, '{}'::jsonb);
    BEGIN
      v_enabled := COALESCE((v_policy_value->>'enabled')::BOOLEAN, FALSE);
    EXCEPTION WHEN others THEN
      v_enabled := FALSE;
    END;
    v_mode := lower(NULLIF(btrim(COALESCE(v_policy_value->>'mode', '')), ''));
    IF v_mode NOT IN ('off', 'monitor', 'enforce') THEN
      v_mode := CASE WHEN v_enabled THEN 'monitor' ELSE 'off' END;
    END IF;
    BEGIN
      v_ttl_seconds := COALESCE(NULLIF(v_policy_value->>'challenge_ttl_seconds', '')::INT, 120);
    EXCEPTION WHEN others THEN
      v_ttl_seconds := 120;
    END;
  ELSE
    v_mode := 'off';
    v_ttl_seconds := 120;
  END IF;

  v_ttl_seconds := GREATEST(30, LEAST(v_ttl_seconds, 900));
  v_challenge := encode(gen_random_bytes(32), 'hex');

  INSERT INTO public.mobile_attestation_challenges (
    id,
    organization_id,
    user_id,
    device_id,
    resource_id,
    rpc_name,
    challenge_hash,
    issued_at,
    expires_at,
    metadata,
    created_at
  )
  VALUES (
    v_challenge_id,
    v_org,
    v_user,
    v_device_id,
    v_resource_id,
    v_rpc_name,
    encode(digest(v_challenge, 'sha256'), 'hex'),
    now(),
    now() + make_interval(secs => v_ttl_seconds),
    v_metadata,
    now()
  );

  challenge_id := v_challenge_id;
  challenge := v_challenge;
  expires_at := now() + make_interval(secs => v_ttl_seconds);
  policy_mode := v_mode;
  policy_scope_type := COALESCE(v_policy.scope_type, 'global');
  policy_scope_id := v_policy.scope_id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.issue_mobile_attestation_challenge_v1(JSONB)
  IS 'Issue a one-time server challenge for mobile attestation. Challenge is hashed at rest and consumed once.';

REVOKE ALL ON FUNCTION public.issue_mobile_attestation_challenge_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_mobile_attestation_challenge_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.issue_mobile_attestation_challenge_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 7) Internal attestation assertion helper (trigger-callable)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_mobile_attestation_for_ingest_v1(
  p_rpc_name TEXT,
  p_organization_id UUID,
  p_user_id UUID,
  p_device_id UUID,
  p_resource_id UUID,
  p_metadata JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_rpc TEXT := lower(NULLIF(btrim(COALESCE(p_rpc_name, '')), ''));
  v_metadata JSONB := COALESCE(p_metadata, '{}'::jsonb);
  v_event_source TEXT := NULL;
  v_attestation JSONB := '{}'::jsonb;

  v_policy RECORD;
  v_policy_value JSONB := '{}'::jsonb;
  v_policy_settings_id UUID := NULL;
  v_policy_scope_type TEXT := NULL;
  v_policy_scope_id UUID := NULL;
  v_enabled BOOLEAN := FALSE;
  v_mode TEXT := 'off';
  v_allow_background_without_attestation BOOLEAN := TRUE;
  v_max_age_seconds INT := 300;
  v_enforce_rpcs TEXT[] := ARRAY[]::TEXT[];
  v_allowed_providers TEXT[] := ARRAY['android_play_integrity', 'ios_app_attest'];

  v_provider TEXT := NULL;
  v_generated_at TIMESTAMPTZ := NULL;
  v_challenge_id UUID := NULL;
  v_challenge TEXT := NULL;

  v_has_integrity_token BOOLEAN := FALSE;
  v_has_key_id BOOLEAN := FALSE;
  v_has_assertion BOOLEAN := FALSE;
  v_has_attestation BOOLEAN := FALSE;

  v_passed BOOLEAN := TRUE;
  v_failure_reason TEXT := NULL;
  v_should_apply BOOLEAN := FALSE;
  v_challenge_consumed UUID := NULL;
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;
  IF v_rpc IS NULL THEN
    RETURN;
  END IF;

  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  IF lower(NULLIF(btrim(COALESCE(v_metadata->>'app', '')), '')) <> 'fieldops' THEN
    RETURN;
  END IF;

  v_event_source := lower(NULLIF(btrim(COALESCE(v_metadata->>'source', '')), ''));

  SELECT *
    INTO v_policy
    FROM public.resolve_mobile_attestation_policy(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', p_organization_id,
        'user_id', p_user_id,
        'resource_id', p_resource_id
      ))
    )
    LIMIT 1;

  IF NOT FOUND OR v_policy.value IS NULL THEN
    RETURN;
  END IF;

  v_policy_settings_id := v_policy.settings_id;
  v_policy_scope_type := v_policy.scope_type;
  v_policy_scope_id := v_policy.scope_id;
  v_policy_value := COALESCE(v_policy.value, '{}'::jsonb);

  BEGIN
    v_enabled := COALESCE((v_policy_value->>'enabled')::BOOLEAN, FALSE);
  EXCEPTION WHEN others THEN
    v_enabled := FALSE;
  END;
  IF v_enabled IS DISTINCT FROM TRUE THEN
    RETURN;
  END IF;

  v_mode := lower(NULLIF(btrim(COALESCE(v_policy_value->>'mode', '')), ''));
  IF v_mode NOT IN ('off', 'monitor', 'enforce') THEN
    v_mode := 'monitor';
  END IF;
  IF v_mode = 'off' THEN
    RETURN;
  END IF;

  BEGIN
    v_allow_background_without_attestation := COALESCE(
      (v_policy_value->>'allow_background_without_attestation')::BOOLEAN,
      TRUE
    );
  EXCEPTION WHEN others THEN
    v_allow_background_without_attestation := TRUE;
  END;

  IF v_event_source = 'mobile_background' AND v_allow_background_without_attestation IS TRUE THEN
    RETURN;
  END IF;

  IF jsonb_typeof(v_policy_value->'enforce_rpcs') = 'array' THEN
    SELECT COALESCE(array_agg(lower(v.value)), ARRAY[]::TEXT[])
      INTO v_enforce_rpcs
      FROM (
        SELECT NULLIF(btrim(value), '') AS value
        FROM jsonb_array_elements_text(v_policy_value->'enforce_rpcs')
      ) AS v
      WHERE v.value IS NOT NULL;
  END IF;

  IF COALESCE(array_length(v_enforce_rpcs, 1), 0) > 0
     AND array_position(v_enforce_rpcs, v_rpc) IS NULL
  THEN
    RETURN;
  END IF;

  v_should_apply := TRUE;

  BEGIN
    v_max_age_seconds := COALESCE(NULLIF(v_policy_value->>'max_age_seconds', '')::INT, 300);
  EXCEPTION WHEN others THEN
    v_max_age_seconds := 300;
  END;
  v_max_age_seconds := GREATEST(30, LEAST(v_max_age_seconds, 86400));

  IF jsonb_typeof(v_policy_value->'allowed_providers') = 'array' THEN
    SELECT COALESCE(array_agg(lower(v.value)), ARRAY[]::TEXT[])
      INTO v_allowed_providers
      FROM (
        SELECT NULLIF(btrim(value), '') AS value
        FROM jsonb_array_elements_text(v_policy_value->'allowed_providers')
      ) AS v
      WHERE v.value IS NOT NULL;
    IF COALESCE(array_length(v_allowed_providers, 1), 0) = 0 THEN
      v_allowed_providers := ARRAY['android_play_integrity', 'ios_app_attest'];
    END IF;
  END IF;

  v_attestation := COALESCE(v_metadata->'attestation', '{}'::jsonb);
  IF jsonb_typeof(v_attestation) <> 'object' THEN
    v_attestation := '{}'::jsonb;
  END IF;

  IF v_should_apply THEN
    v_provider := lower(NULLIF(btrim(COALESCE(v_attestation->>'provider', '')), ''));
    IF v_provider IS NULL THEN
      v_passed := FALSE;
      v_failure_reason := 'missing_provider';
    END IF;
  END IF;

  IF v_passed IS TRUE AND array_position(v_allowed_providers, v_provider) IS NULL THEN
    v_passed := FALSE;
    v_failure_reason := 'provider_not_allowed';
  END IF;

  IF v_passed IS TRUE THEN
    BEGIN
      v_generated_at := NULLIF(btrim(COALESCE(v_attestation->>'generated_at', '')), '')::TIMESTAMPTZ;
    EXCEPTION WHEN others THEN
      v_generated_at := NULL;
    END;
    IF v_generated_at IS NULL THEN
      v_passed := FALSE;
      v_failure_reason := 'missing_generated_at';
    ELSIF (now() - v_generated_at) > make_interval(secs => v_max_age_seconds) THEN
      v_passed := FALSE;
      v_failure_reason := 'attestation_expired';
    END IF;
  END IF;

  IF v_passed IS TRUE THEN
    BEGIN
      v_challenge_id := NULLIF(btrim(COALESCE(v_attestation->>'challenge_id', '')), '')::UUID;
    EXCEPTION WHEN others THEN
      v_challenge_id := NULL;
    END;
    v_challenge := NULLIF(btrim(COALESCE(v_attestation->>'challenge', '')), '');
    IF v_challenge_id IS NULL OR v_challenge IS NULL THEN
      v_passed := FALSE;
      v_failure_reason := 'missing_challenge';
    END IF;
  END IF;

  IF v_passed IS TRUE AND v_provider = 'android_play_integrity' THEN
    v_has_integrity_token := NULLIF(btrim(COALESCE(v_attestation->>'integrity_token', '')), '') IS NOT NULL;
    IF v_has_integrity_token IS FALSE THEN
      v_passed := FALSE;
      v_failure_reason := 'missing_integrity_token';
    END IF;
  END IF;

  IF v_passed IS TRUE AND v_provider = 'ios_app_attest' THEN
    v_has_key_id := NULLIF(btrim(COALESCE(v_attestation->>'key_id', '')), '') IS NOT NULL;
    v_has_assertion := NULLIF(btrim(COALESCE(v_attestation->>'assertion', '')), '') IS NOT NULL;
    v_has_attestation := NULLIF(btrim(COALESCE(v_attestation->>'attestation', '')), '') IS NOT NULL;

    IF v_has_key_id IS FALSE THEN
      v_passed := FALSE;
      v_failure_reason := 'missing_key_id';
    ELSIF v_has_assertion IS FALSE AND v_has_attestation IS FALSE THEN
      v_passed := FALSE;
      v_failure_reason := 'missing_assertion';
    END IF;
  END IF;

  IF v_passed IS TRUE THEN
    UPDATE public.mobile_attestation_challenges c
       SET consumed_at = now(),
           consumed_by_rpc = v_rpc
     WHERE c.id = v_challenge_id
       AND c.organization_id = p_organization_id
       AND c.user_id = p_user_id
       AND (c.device_id IS NULL OR c.device_id = p_device_id)
       AND (c.rpc_name IS NULL OR c.rpc_name = v_rpc)
       AND c.consumed_at IS NULL
       AND c.expires_at >= now()
       AND c.challenge_hash = encode(digest(v_challenge, 'sha256'), 'hex')
     RETURNING c.id INTO v_challenge_consumed;

    IF v_challenge_consumed IS NULL THEN
      v_passed := FALSE;
      v_failure_reason := 'challenge_invalid_or_replayed';
    END IF;
  END IF;

  INSERT INTO public.mobile_attestation_events (
    organization_id,
    user_id,
    device_id,
    resource_id,
    rpc_name,
    policy_settings_id,
    policy_scope_type,
    policy_scope_id,
    policy_mode,
    provider,
    passed,
    failure_reason,
    event_source,
    challenge_id,
    generated_at,
    metadata,
    created_at
  )
  VALUES (
    p_organization_id,
    p_user_id,
    p_device_id,
    p_resource_id,
    v_rpc,
    v_policy_settings_id,
    v_policy_scope_type,
    v_policy_scope_id,
    v_mode,
    v_provider,
    v_passed,
    v_failure_reason,
    v_event_source,
    v_challenge_id,
    v_generated_at,
    jsonb_strip_nulls(jsonb_build_object(
      'provider', v_provider,
      'challenge_id', v_challenge_id,
      'generated_at', v_generated_at,
      'has_integrity_token', v_has_integrity_token,
      'has_key_id', v_has_key_id,
      'has_assertion', v_has_assertion,
      'has_attestation', v_has_attestation
    )),
    now()
  );

  IF v_mode = 'enforce' AND v_passed IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'mobile attestation blocked by policy (rpc %, reason %)', v_rpc, COALESCE(v_failure_reason, 'unknown')
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.assert_mobile_attestation_for_ingest_v1(TEXT, UUID, UUID, UUID, UUID, JSONB)
  IS 'Internal helper used by ingest triggers to enforce/monitor mobile attestation according to mobile_attestation_policy.';

REVOKE ALL ON FUNCTION public.assert_mobile_attestation_for_ingest_v1(TEXT, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_mobile_attestation_for_ingest_v1(TEXT, UUID, UUID, UUID, UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assert_mobile_attestation_for_ingest_v1(TEXT, UUID, UUID, UUID, UUID, JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 8) Generic trigger function + per-table triggers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_user_col TEXT := COALESCE(TG_ARGV[0], '');
  v_device_col TEXT := COALESCE(TG_ARGV[1], '');
  v_resource_col TEXT := COALESCE(TG_ARGV[2], '');
  v_rpc_name TEXT := COALESCE(TG_ARGV[3], TG_TABLE_NAME);

  v_org UUID := NULL;
  v_user UUID := NULL;
  v_device UUID := NULL;
  v_resource UUID := NULL;
  v_metadata JSONB := '{}'::jsonb;
BEGIN
  BEGIN
    v_org := NULLIF(v_row->>'organization_id', '')::UUID;
  EXCEPTION WHEN others THEN
    v_org := NULL;
  END;

  IF v_user_col <> '' THEN
    BEGIN
      v_user := NULLIF(v_row->>v_user_col, '')::UUID;
    EXCEPTION WHEN others THEN
      v_user := NULL;
    END;
  END IF;

  IF v_device_col <> '' THEN
    BEGIN
      v_device := NULLIF(v_row->>v_device_col, '')::UUID;
    EXCEPTION WHEN others THEN
      v_device := NULL;
    END;
  END IF;

  IF v_resource_col <> '' THEN
    BEGIN
      v_resource := NULLIF(v_row->>v_resource_col, '')::UUID;
    EXCEPTION WHEN others THEN
      v_resource := NULL;
    END;
  END IF;

  IF jsonb_typeof(v_row->'metadata') = 'object' THEN
    v_metadata := v_row->'metadata';
  END IF;

  PERFORM public.assert_mobile_attestation_for_ingest_v1(
    v_rpc_name,
    v_org,
    v_user,
    v_device,
    v_resource,
    v_metadata
  );

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tg_enforce_mobile_attestation_ingest_v1()
  IS 'Trigger function that enforces/monitors mobile attestation policy for ingest ledgers.';

DROP TRIGGER IF EXISTS trg_mobile_attestation_user_devices_v1 ON public.user_devices;
CREATE TRIGGER trg_mobile_attestation_user_devices_v1
BEFORE INSERT OR UPDATE ON public.user_devices
FOR EACH ROW
EXECUTE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1(
  'user_id',
  'id',
  '',
  'register_user_device_v1'
);

DROP TRIGGER IF EXISTS trg_mobile_attestation_location_pings_v1 ON public.location_pings;
CREATE TRIGGER trg_mobile_attestation_location_pings_v1
BEFORE INSERT ON public.location_pings
FOR EACH ROW
EXECUTE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1(
  'actor_user_id',
  'device_id',
  'branch_id',
  'record_location_ping_v1'
);

DROP TRIGGER IF EXISTS trg_mobile_attestation_scan_events_v1 ON public.scan_events;
CREATE TRIGGER trg_mobile_attestation_scan_events_v1
BEFORE INSERT ON public.scan_events
FOR EACH ROW
EXECUTE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1(
  'actor_user_id',
  'device_id',
  'branch_id',
  'record_scan_event_v1'
);

DROP TRIGGER IF EXISTS trg_mobile_attestation_ops_sessions_v1 ON public.ops_sessions;
CREATE TRIGGER trg_mobile_attestation_ops_sessions_v1
BEFORE INSERT ON public.ops_sessions
FOR EACH ROW
EXECUTE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1(
  'actor_user_id',
  'device_id',
  'branch_id',
  'open_ops_session_v1'
);

SELECT pg_advisory_unlock(hashtext('202602061130_mobile_attestation_policy_and_ingest_enforcement_v1'));
COMMIT;
