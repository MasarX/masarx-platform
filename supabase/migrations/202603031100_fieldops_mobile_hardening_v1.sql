-- Plan: PLAN-202603-fieldops-mobile-100-hardening-v1 / Step: S01
-- Migration: FieldOps mobile attestation + location threshold hardening
-- Date: 2026-03-03
--
-- Goals:
--   - Keep mobile attestation enforcement fail-closed against spoofed metadata.
--   - Canonicalize ingest metadata app/source server-side before attestation checks.
--   - Enforce location_tracking_policy thresholds (min_interval_seconds, max_accuracy_m) at write time.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603031100_fieldops_mobile_hardening_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Fail-closed global default for background attestation bypass
-------------------------------------------------------------------------------

UPDATE public.settings_versions
SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object('allow_background_without_attestation', FALSE)
WHERE category = 'mobile_attestation_policy'
  AND scope_type = 'global'
  AND scope_id IS NULL
  AND effective_until IS NULL;

UPDATE public.settings
SET cached_value = COALESCE(cached_value, '{}'::jsonb) || jsonb_build_object('allow_background_without_attestation', FALSE),
    last_updated = now()
WHERE category = 'mobile_attestation_policy'
  AND scope_type = 'global'
  AND scope_id IS NULL;

-------------------------------------------------------------------------------
-- 2) Harden attestation helper against spoofed metadata fields
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
  v_event_source TEXT := 'mobile';
  v_client_source TEXT := NULL;
  v_attestation JSONB := '{}'::jsonb;

  v_policy RECORD;
  v_policy_value JSONB := '{}'::jsonb;
  v_policy_settings_id UUID := NULL;
  v_policy_scope_type TEXT := NULL;
  v_policy_scope_id UUID := NULL;
  v_enabled BOOLEAN := FALSE;
  v_mode TEXT := 'off';
  v_allow_background_without_attestation BOOLEAN := FALSE;
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

  -- "source" is treated as trusted only when canonicalized by trigger metadata rewrite.
  v_event_source := lower(NULLIF(btrim(COALESCE(v_metadata->>'__attestation_source', '')), ''));
  IF v_event_source NOT IN ('mobile', 'mobile_background') THEN
    v_event_source := 'mobile';
  END IF;

  v_client_source := lower(NULLIF(btrim(COALESCE(v_metadata->>'source', '')), ''));

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
      FALSE
    );
  EXCEPTION WHEN others THEN
    v_allow_background_without_attestation := FALSE;
  END;

  IF v_event_source = 'mobile_background'
     AND v_rpc = 'record_location_ping_v1'
     AND v_allow_background_without_attestation IS TRUE
  THEN
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
      'has_attestation', v_has_attestation,
      'trusted_source', v_event_source,
      'client_source', v_client_source
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
-- 3) Canonicalize metadata app/source in attestation trigger path (fail-closed)
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
  v_trusted_source TEXT := lower(NULLIF(btrim(COALESCE(TG_ARGV[4], '')), ''));
  v_session_role TEXT := lower(NULLIF(btrim(session_user), ''));
  v_client_source TEXT := NULL;

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

  IF v_trusted_source NOT IN ('mobile', 'mobile_background') THEN
    v_trusted_source := 'mobile';
  END IF;

  IF jsonb_typeof(v_row->'metadata') = 'object' THEN
    v_metadata := v_row->'metadata';
  END IF;

  v_client_source := lower(NULLIF(btrim(COALESCE(v_metadata->>'source', '')), ''));
  IF v_rpc_name = 'record_location_ping_v1'
     AND v_session_role = 'service_role'
     AND v_client_source = 'mobile_background'
  THEN
    -- Trusted background classification is allowed only for service_role writes
    -- on record_location_ping_v1. Client metadata alone is never trusted.
    v_trusted_source := 'mobile_background';
  END IF;

  v_metadata :=
    (v_metadata - 'app' - 'source' - '__attestation_source')
    || jsonb_build_object(
      'app', 'fieldops',
      'source', v_trusted_source,
      '__attestation_source', v_trusted_source
    );

  NEW.metadata := v_metadata;

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
  'register_user_device_v1',
  'mobile'
);

DROP TRIGGER IF EXISTS trg_mobile_attestation_location_pings_v1 ON public.location_pings;
CREATE TRIGGER trg_mobile_attestation_location_pings_v1
BEFORE INSERT ON public.location_pings
FOR EACH ROW
EXECUTE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1(
  'actor_user_id',
  'device_id',
  'branch_id',
  'record_location_ping_v1',
  'mobile'
);

DROP TRIGGER IF EXISTS trg_mobile_attestation_scan_events_v1 ON public.scan_events;
CREATE TRIGGER trg_mobile_attestation_scan_events_v1
BEFORE INSERT ON public.scan_events
FOR EACH ROW
EXECUTE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1(
  'actor_user_id',
  'device_id',
  'branch_id',
  'record_scan_event_v1',
  'mobile'
);

DROP TRIGGER IF EXISTS trg_mobile_attestation_ops_sessions_v1 ON public.ops_sessions;
CREATE TRIGGER trg_mobile_attestation_ops_sessions_v1
BEFORE INSERT ON public.ops_sessions
FOR EACH ROW
EXECUTE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1(
  'actor_user_id',
  'device_id',
  'branch_id',
  'open_ops_session_v1',
  'mobile'
);

-------------------------------------------------------------------------------
-- 4) Enforce location_tracking_policy thresholds at write time
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_enforce_location_tracking_policy_thresholds_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy RECORD;
  v_policy_value JSONB := '{}'::jsonb;
  v_enabled BOOLEAN := TRUE;
  v_min_interval_seconds INT := 0;
  v_max_accuracy_m INT := NULL;
  v_prev_captured_at TIMESTAMPTZ := NULL;
BEGIN
  IF NEW.organization_id IS NULL OR NEW.actor_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.captured_at IS NULL THEN
    NEW.captured_at := now();
  END IF;

  SELECT *
    INTO v_policy
    FROM public.resolve_location_tracking_policy(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', NEW.organization_id,
        'user_id', NEW.actor_user_id,
        'resource_id', NEW.branch_id,
        'event_type', 'location_ping'
      ))
    )
    LIMIT 1;

  IF FOUND AND v_policy.value IS NOT NULL THEN
    v_policy_value := COALESCE(v_policy.value, '{}'::jsonb);

    BEGIN
      v_enabled := COALESCE((v_policy_value->>'enabled')::BOOLEAN, TRUE);
    EXCEPTION WHEN others THEN
      v_enabled := TRUE;
    END;
    IF v_enabled IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_location_ping_v1 blocked by location_tracking_policy.enabled=false'
        USING ERRCODE = '42501';
    END IF;

    BEGIN
      v_min_interval_seconds := COALESCE(NULLIF(v_policy_value->>'min_interval_seconds', '')::INT, 0);
    EXCEPTION WHEN others THEN
      v_min_interval_seconds := 0;
    END;
    v_min_interval_seconds := GREATEST(v_min_interval_seconds, 0);

    BEGIN
      v_max_accuracy_m := NULLIF(v_policy_value->>'max_accuracy_m', '')::INT;
    EXCEPTION WHEN others THEN
      v_max_accuracy_m := NULL;
    END;
    IF v_max_accuracy_m IS NOT NULL THEN
      v_max_accuracy_m := GREATEST(v_max_accuracy_m, 0);
    END IF;
  END IF;

  IF v_max_accuracy_m IS NOT NULL
     AND NEW.accuracy_m IS NOT NULL
     AND NEW.accuracy_m > v_max_accuracy_m
  THEN
    RAISE EXCEPTION 'record_location_ping_v1 blocked by location_tracking_policy.max_accuracy_m'
      USING ERRCODE = '42501';
  END IF;

  IF v_min_interval_seconds > 0 THEN
    SELECT lp.captured_at
      INTO v_prev_captured_at
      FROM public.location_pings lp
     WHERE lp.organization_id = NEW.organization_id
       AND lp.actor_user_id = NEW.actor_user_id
       AND (NEW.device_id IS NULL OR lp.device_id = NEW.device_id)
     ORDER BY lp.captured_at DESC, lp.created_at DESC
     LIMIT 1;

    IF v_prev_captured_at IS NOT NULL
       AND NEW.captured_at < (v_prev_captured_at + make_interval(secs => v_min_interval_seconds))
    THEN
      RAISE EXCEPTION 'record_location_ping_v1 blocked by location_tracking_policy.min_interval_seconds'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tg_enforce_location_tracking_policy_thresholds_v1()
  IS 'Trigger function that enforces max_accuracy_m and min_interval_seconds for location_pings via resolved location_tracking_policy.';

DROP TRIGGER IF EXISTS trg_location_pings_policy_thresholds_v1 ON public.location_pings;
CREATE TRIGGER trg_location_pings_policy_thresholds_v1
BEFORE INSERT ON public.location_pings
FOR EACH ROW
EXECUTE FUNCTION public.tg_enforce_location_tracking_policy_thresholds_v1();

SELECT pg_advisory_unlock(hashtext('202603031100_fieldops_mobile_hardening_v1'));

COMMIT;
