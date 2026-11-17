-- Plan: PLAN-202603-fieldops-mobile-100-hardening-v1 / Step: S95
-- pgTAP: FieldOps mobile hardening proof (attestation spoof resistance + location policy thresholds)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

CREATE OR REPLACE FUNCTION pg_temp.upsert_setting_cache_v1(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_value JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $function$
DECLARE
  v_scope_type TEXT := lower(NULLIF(btrim(COALESCE(p_scope_type, '')), ''));
  v_scope_id UUID := p_scope_id;
  v_scope_hash UUID;
  v_settings_version_id UUID;
  v_schema_version INT := 1;
  v_next_version INT := 1;
BEGIN
  IF v_scope_type IS NULL THEN
    RAISE EXCEPTION 'upsert_setting_cache_v1 requires scope_type';
  END IF;

  IF v_scope_type = 'global' THEN
    v_scope_id := NULL;
  ELSIF v_scope_id IS NULL THEN
    RAISE EXCEPTION 'upsert_setting_cache_v1 scope_id required for scope_type=%', v_scope_type;
  END IF;

  v_scope_hash := COALESCE(v_scope_id, '00000000-0000-0000-0000-000000000000'::uuid);

  SELECT sr.version
    INTO v_schema_version
    FROM public.schema_registry sr
   WHERE sr.category = p_category
     AND sr.is_active IS TRUE
   ORDER BY sr.version DESC
   LIMIT 1;

  v_schema_version := COALESCE(v_schema_version, 1);

  SELECT sv.id
    INTO v_settings_version_id
    FROM public.settings_versions sv
   WHERE sv.category = p_category
     AND sv.scope_type = v_scope_type
     AND sv.scope_hash = v_scope_hash
     AND sv.effective_until IS NULL
   ORDER BY sv.effective_from DESC NULLS LAST, sv.created_at DESC NULLS LAST
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    SELECT COALESCE(MAX(sv.version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions sv
     WHERE sv.category = p_category
       AND sv.scope_type = v_scope_type
       AND sv.scope_hash = v_scope_hash;

    INSERT INTO public.settings_versions (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    ) VALUES (
      gen_random_uuid(),
      p_category,
      v_scope_type,
      v_scope_id,
      v_scope_hash,
      v_next_version,
      COALESCE(p_value, '{}'::jsonb),
      v_schema_version,
      'pgTAP mobile hardening upsert',
      clock_timestamp(),
      clock_timestamp()
    )
    RETURNING id INTO v_settings_version_id;
  ELSE
    UPDATE public.settings_versions sv
       SET value = COALESCE(p_value, '{}'::jsonb),
           schema_version = v_schema_version,
           approved_at = COALESCE(sv.approved_at, clock_timestamp()),
           effective_from = COALESCE(sv.effective_from, clock_timestamp())
     WHERE sv.id = v_settings_version_id;
  END IF;

  UPDATE public.settings s
     SET settings_version_id = v_settings_version_id,
         cached_value = COALESCE(p_value, '{}'::jsonb),
         last_updated = clock_timestamp()
   WHERE s.category = p_category
     AND s.scope_type = v_scope_type
     AND s.scope_hash = v_scope_hash;

  IF NOT FOUND THEN
    INSERT INTO public.settings (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      gen_random_uuid(),
      p_category,
      v_scope_type,
      v_scope_id,
      v_scope_hash,
      v_settings_version_id,
      COALESCE(p_value, '{}'::jsonb),
      clock_timestamp()
    );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION pg_temp.test_fieldops_mobile_hardening_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();

  v_device RECORD;
  v_challenge RECORD;
  v_threshold_challenge RECORD;
  v_ping_valid RECORD;
  v_ping_service_background RECORD;
  v_ping_first RECORD;
  v_ping_second RECORD;
  v_ping_replay RECORD;
  v_ping_metadata JSONB := '{}'::jsonb;

  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  RETURN NEXT has_function(
    'public',
    'assert_mobile_attestation_for_ingest_v1',
    ARRAY['text', 'uuid', 'uuid', 'uuid', 'uuid', 'jsonb'],
    'assert_mobile_attestation_for_ingest_v1 exists'
  );

  RETURN NEXT has_function(
    'public',
    'tg_enforce_location_tracking_policy_thresholds_v1',
    ARRAY[]::TEXT[],
    'tg_enforce_location_tracking_policy_thresholds_v1 exists'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'FieldOps Hardening Org', 'fieldops-hardening-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'fo-h-' || left(v_branch::text, 8), 'FieldOps Hardening Branch', 'UTC', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'FieldOps Hardening Client', 'fo-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'FieldOps Hardening Sender', 'FieldOps Hardening Sender', TRUE, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, status)
  VALUES (v_user, v_org, 'fieldops-hardening-' || left(v_user::text, 8) || '@example.com', 'FieldOps Hardening User', 'driver', 'tenant', 'active');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_user);

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  PERFORM pg_temp.upsert_setting_cache_v1(
    'mobile_attestation_policy',
    'tenant',
    v_org,
    jsonb_build_object(
      'enabled', TRUE,
      'mode', 'enforce',
      'enforce_rpcs', jsonb_build_array('record_location_ping_v1'),
      'allow_background_without_attestation', TRUE,
      'allowed_providers', jsonb_build_array('android_play_integrity', 'ios_app_attest'),
      'max_age_seconds', 600,
      'challenge_ttl_seconds', 600
    )
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  SELECT *
    INTO v_device
    FROM public.register_user_device_v1(
      jsonb_build_object(
        'device_platform', 'android',
        'device_identifier_sha256', encode(digest(v_user::text, 'sha256'), 'hex'),
        'device_label', 'pgtap-fieldops-hardening'
      )
    )
    LIMIT 1;

  BEGIN
    PERFORM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'hardening-forged-app-' || left(v_user::text, 8),
        'device_id', v_device.device_id,
        'lat', 24.7136,
        'lng', 46.6753,
        'captured_at', v_now,
        'metadata', jsonb_build_object('app', 'attacker-app', 'source', 'mobile')
      )
    );
    RETURN NEXT fail('forged metadata.app must not bypass attestation enforcement');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RETURN NEXT pass('forged metadata.app is blocked in enforce mode');
  END;

  BEGIN
    PERFORM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'hardening-forged-source-' || left(v_user::text, 8),
        'device_id', v_device.device_id,
        'lat', 24.7136,
        'lng', 46.6753,
        'captured_at', v_now + interval '5 seconds',
        'metadata', jsonb_build_object('app', 'fieldops', 'source', 'mobile_background')
      )
    );
    RETURN NEXT fail('forged metadata.source=mobile_background must not bypass attestation enforcement');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RETURN NEXT pass('forged metadata.source=mobile_background is blocked without trusted bypass context');
  END;

  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('role', 'service_role', 'sub', v_user::text)::text,
    true
  );

  SELECT *
    INTO v_ping_service_background
    FROM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'hardening-trusted-service-bg-' || left(v_user::text, 8),
        'device_id', v_device.device_id,
        'lat', 24.7136,
        'lng', 46.6753,
        'accuracy_m', 9,
        'captured_at', v_now + interval '7 seconds',
        'metadata', jsonb_build_object('app', 'fieldops', 'source', 'mobile_background')
      )
    )
    LIMIT 1;

  RETURN NEXT ok(
    v_ping_service_background.created IS TRUE,
    'trusted service_role background context can bypass attestation only for record_location_ping_v1'
  );

  SELECT lp.metadata
    INTO v_ping_metadata
    FROM public.location_pings lp
   WHERE lp.id = v_ping_service_background.location_ping_id
   LIMIT 1;

  RETURN NEXT is(
    v_ping_metadata->>'source',
    'mobile_background',
    'trusted service_role background context is canonicalized server-side'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  BEGIN
    PERFORM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'hardening-missing-attestation-' || left(v_user::text, 8),
        'device_id', v_device.device_id,
        'lat', 24.7136,
        'lng', 46.6753,
        'captured_at', v_now + interval '10 seconds',
        'metadata', jsonb_build_object('app', 'fieldops', 'source', 'mobile')
      )
    );
    RETURN NEXT fail('missing attestation must be blocked in enforce mode');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RETURN NEXT pass('missing attestation is blocked in enforce mode');
  END;

  BEGIN
    PERFORM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'hardening-invalid-provider-' || left(v_user::text, 8),
        'device_id', v_device.device_id,
        'lat', 24.7136,
        'lng', 46.6753,
        'captured_at', v_now + interval '15 seconds',
        'metadata', jsonb_build_object(
          'app', 'fieldops',
          'source', 'mobile',
          'attestation', jsonb_build_object(
            'provider', 'unknown_provider',
            'challenge_id', gen_random_uuid(),
            'challenge', encode(digest('x', 'sha256'), 'hex'),
            'generated_at', (v_now + interval '15 seconds')
          )
        )
      )
    );
    RETURN NEXT fail('invalid attestation provider must be blocked in enforce mode');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RETURN NEXT pass('invalid attestation provider is blocked in enforce mode');
  END;

  SELECT *
    INTO v_challenge
    FROM public.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'record_location_ping_v1',
        'device_id', v_device.device_id
      )
    )
    LIMIT 1;

  SELECT *
    INTO v_ping_valid
    FROM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'hardening-valid-attestation-' || left(v_user::text, 8),
        'device_id', v_device.device_id,
        'lat', 24.7136,
        'lng', 46.6753,
        'accuracy_m', 10,
        'captured_at', v_now + interval '30 seconds',
        'metadata', jsonb_build_object(
          'app', 'attacker-app',
          'source', 'mobile_background',
          'attestation', jsonb_build_object(
            'provider', 'android_play_integrity',
            'challenge_id', v_challenge.challenge_id,
            'challenge', v_challenge.challenge,
            'generated_at', (v_now + interval '30 seconds'),
            'integrity_token', 'pgtap-integrity-token'
          )
        )
      )
    )
    LIMIT 1;

  RETURN NEXT ok(v_ping_valid.created IS TRUE, 'valid attestation succeeds in enforce mode');

  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT lp.metadata
    INTO v_ping_metadata
    FROM public.location_pings lp
   WHERE lp.id = v_ping_valid.location_ping_id
   LIMIT 1;

  RETURN NEXT is(v_ping_metadata->>'app', 'fieldops', 'ingest metadata.app is canonicalized server-side');
  RETURN NEXT is(v_ping_metadata->>'source', 'mobile', 'ingest metadata.source is canonicalized to trusted server source');

  PERFORM pg_temp.upsert_setting_cache_v1(
    'mobile_attestation_policy',
    'tenant',
    v_org,
    jsonb_build_object('enabled', FALSE, 'mode', 'off')
  );

  -- Keep threshold assertions focused on location_tracking_policy behavior.
  -- Some runtimes may still resolve attestation from global scope when no
  -- higher-priority scoped row is matched for this write path.
  PERFORM pg_temp.upsert_setting_cache_v1(
    'mobile_attestation_policy',
    'global',
    NULL,
    jsonb_build_object('enabled', FALSE, 'mode', 'off')
  );

  -- Prove ladder precedence: keep global permissive while tenant policy is strict.
  PERFORM pg_temp.upsert_setting_cache_v1(
    'location_tracking_policy',
    'global',
    NULL,
    jsonb_build_object('enabled', TRUE, 'min_interval_seconds', 0, 'max_accuracy_m', 1000)
  );

  PERFORM pg_temp.upsert_setting_cache_v1(
    'location_tracking_policy',
    'tenant',
    v_org,
    jsonb_build_object('enabled', TRUE, 'min_interval_seconds', 120, 'max_accuracy_m', 15)
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_threshold_challenge
    FROM public.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'record_location_ping_v1',
        'device_id', v_device.device_id
      )
    )
    LIMIT 1;

  BEGIN
    SELECT *
      INTO v_ping_first
      FROM public.record_location_ping_v1(
        jsonb_build_object(
          'idempotency_key', 'hardening-threshold-first-' || left(v_user::text, 8),
          'device_id', v_device.device_id,
          'lat', 24.7136,
          'lng', 46.6753,
          'accuracy_m', 10,
          'captured_at', v_now + interval '200 seconds',
          'metadata', jsonb_build_object(
            'attestation', jsonb_build_object(
              'provider', 'android_play_integrity',
              'challenge_id', v_threshold_challenge.challenge_id,
              'challenge', v_threshold_challenge.challenge,
              'generated_at', (v_now + interval '200 seconds'),
              'integrity_token', 'pgtap-threshold-integrity-first'
            )
          )
        )
      )
      LIMIT 1;
  EXCEPTION WHEN others THEN
    RETURN NEXT fail('location ping within threshold unexpected error: ' || SQLERRM);
    RETURN;
  END;

  RETURN NEXT ok(v_ping_first.created IS TRUE, 'location ping within threshold is accepted');

  SELECT *
    INTO v_threshold_challenge
    FROM public.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'record_location_ping_v1',
        'device_id', v_device.device_id
      )
    )
    LIMIT 1;

  BEGIN
    PERFORM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'hardening-threshold-interval-' || left(v_user::text, 8),
        'device_id', v_device.device_id,
        'lat', 24.7136,
        'lng', 46.6753,
        'accuracy_m', 8,
        'captured_at', v_now + interval '210 seconds',
        'metadata', jsonb_build_object(
          'attestation', jsonb_build_object(
            'provider', 'android_play_integrity',
            'challenge_id', v_threshold_challenge.challenge_id,
            'challenge', v_threshold_challenge.challenge,
            'generated_at', (v_now + interval '210 seconds'),
            'integrity_token', 'pgtap-threshold-integrity-interval'
          )
        )
      )
    );
    RETURN NEXT fail('min_interval_seconds violation must be blocked');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('min_interval_seconds' in SQLERRM) > 0 THEN
      RETURN NEXT pass('min_interval_seconds violation is blocked server-side');
    ELSE
      RETURN NEXT fail('expected min_interval_seconds policy block, got: ' || SQLERRM);
    END IF;
  END;

  SELECT *
    INTO v_threshold_challenge
    FROM public.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'record_location_ping_v1',
        'device_id', v_device.device_id
      )
    )
    LIMIT 1;

  BEGIN
    PERFORM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'hardening-threshold-accuracy-' || left(v_user::text, 8),
        'device_id', v_device.device_id,
        'lat', 24.7136,
        'lng', 46.6753,
        'accuracy_m', 45,
        'captured_at', v_now + interval '340 seconds',
        'metadata', jsonb_build_object(
          'attestation', jsonb_build_object(
            'provider', 'android_play_integrity',
            'challenge_id', v_threshold_challenge.challenge_id,
            'challenge', v_threshold_challenge.challenge,
            'generated_at', (v_now + interval '340 seconds'),
            'integrity_token', 'pgtap-threshold-integrity-accuracy'
          )
        )
      )
    );
    RETURN NEXT fail('max_accuracy_m violation must be blocked (tenant override should win over global)');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('max_accuracy_m' in SQLERRM) > 0 THEN
      RETURN NEXT pass('max_accuracy_m violation is blocked by tenant override policy (ladder precedence preserved)');
    ELSE
      RETURN NEXT fail('expected max_accuracy_m policy block, got: ' || SQLERRM);
    END IF;
  END;

  SELECT *
    INTO v_threshold_challenge
    FROM public.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'record_location_ping_v1',
        'device_id', v_device.device_id
      )
    )
    LIMIT 1;

  BEGIN
    SELECT *
      INTO v_ping_second
      FROM public.record_location_ping_v1(
        jsonb_build_object(
          'idempotency_key', 'hardening-threshold-second-' || left(v_user::text, 8),
          'device_id', v_device.device_id,
          'lat', 24.7136,
          'lng', 46.6753,
          'accuracy_m', 12,
          'captured_at', v_now + interval '340 seconds',
          'metadata', jsonb_build_object(
            'attestation', jsonb_build_object(
              'provider', 'android_play_integrity',
              'challenge_id', v_threshold_challenge.challenge_id,
              'challenge', v_threshold_challenge.challenge,
              'generated_at', (v_now + interval '340 seconds'),
              'integrity_token', 'pgtap-threshold-integrity-second'
            )
          )
        )
      )
      LIMIT 1;
  EXCEPTION WHEN others THEN
    RETURN NEXT fail('location ping meeting interval/accuracy unexpected error: ' || SQLERRM);
    RETURN;
  END;

  RETURN NEXT ok(v_ping_second.created IS TRUE, 'location ping meeting interval and accuracy thresholds is accepted');

  SELECT *
    INTO v_threshold_challenge
    FROM public.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'record_location_ping_v1',
        'device_id', v_device.device_id
      )
    )
    LIMIT 1;

  BEGIN
    SELECT *
      INTO v_ping_replay
      FROM public.record_location_ping_v1(
        jsonb_build_object(
          'idempotency_key', 'hardening-threshold-second-' || left(v_user::text, 8),
          'device_id', v_device.device_id,
          'lat', 24.7136,
          'lng', 46.6753,
          'accuracy_m', 12,
          'captured_at', v_now + interval '340 seconds',
          'metadata', jsonb_build_object(
            'attestation', jsonb_build_object(
              'provider', 'android_play_integrity',
              'challenge_id', v_threshold_challenge.challenge_id,
              'challenge', v_threshold_challenge.challenge,
              'generated_at', (v_now + interval '340 seconds'),
              'integrity_token', 'pgtap-threshold-integrity-replay'
            )
          )
        )
      )
      LIMIT 1;
  EXCEPTION WHEN others THEN
    RETURN NEXT fail('location ping replay unexpected error: ' || SQLERRM);
    RETURN;
  END;

  RETURN NEXT ok(
    v_ping_replay.created IS FALSE AND v_ping_replay.location_ping_id = v_ping_second.location_ping_id,
    'location ping idempotency remains intact with threshold enforcement'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_fieldops_mobile_hardening_v1();

SELECT * FROM finish();

ROLLBACK;
