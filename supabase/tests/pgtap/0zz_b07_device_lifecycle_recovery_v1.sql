-- pgTAP: B07 device lifecycle and stolen-device recovery proof

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

SELECT ok(
  has_function_privilege('authenticated', 'public.register_user_device_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.register_user_device_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.register_user_device_v1(jsonb)', 'EXECUTE'),
  'device recovery preserves the registration execute boundary'
);

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
      'pgTAP device lifecycle recovery upsert',
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

CREATE OR REPLACE FUNCTION pg_temp.mobile_attestation_metadata_v1(
  p_challenge_id UUID,
  p_challenge TEXT,
  p_action TEXT
)
RETURNS JSONB
LANGUAGE sql
AS $function$
  SELECT jsonb_build_object(
    'lifecycle_action', p_action,
    'attestation', jsonb_build_object(
      'provider', 'android_play_integrity',
      'challenge_id', p_challenge_id,
      'challenge', p_challenge,
      'generated_at', clock_timestamp(),
      'integrity_token', encode(gen_random_bytes(32), 'hex')
    )
  );
$function$;

CREATE OR REPLACE FUNCTION pg_temp.test_b07_device_lifecycle_recovery_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_owner UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_device_a RECORD;
  v_device_a_reattest RECORD;
  v_device_b RECORD;
  v_device_b_reattest RECORD;
  v_challenge_a RECORD;
  v_challenge_b RECORD;
  v_challenge_b_reattest RECORD;
  v_revoke_result JSONB;
  v_old_detail JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Device Lifecycle Recovery Org', 'device-lifecycle-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, status)
  VALUES
    (v_owner, v_org, 'device-owner-' || left(v_owner::text, 8) || '@example.com', 'Device Owner', 'driver', 'tenant', 'active'),
    (v_operator, v_org, 'device-ops-' || left(v_operator::text, 8) || '@example.com', 'Device Ops', 'ops_admin', 'tenant', 'active');

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner::text)::text, true);

  SELECT *
    INTO v_device_a
    FROM api.register_user_device_v1(
      jsonb_build_object(
        'device_platform', 'android',
        'device_identifier_sha256', 'b07-device-lifecycle-device-a',
        'device_label', 'Driver phone A',
        'push_token', 'push-token-a',
        'app_version', '1.0.0',
        'os_version', '14'
      )
    )
    LIMIT 1;

  RETURN NEXT ok(v_device_a.created IS TRUE, 'register creates the first device through api.register_user_device_v1');
  RETURN NEXT ok(v_device_a.device_id IS NOT NULL, 'register returns the first device id');
  RETURN NEXT is(
    (SELECT device_label FROM api.user_devices WHERE id = v_device_a.device_id),
    'Driver phone A',
    'api.user_devices exposes the registered device label'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM pg_temp.upsert_setting_cache_v1(
    'mobile_attestation_policy',
    'tenant',
    v_org,
    jsonb_build_object(
      'enabled', TRUE,
      'mode', 'enforce',
      'enforce_rpcs', jsonb_build_array('register_user_device_v1'),
      'allow_background_without_attestation', FALSE,
      'allowed_providers', jsonb_build_array('android_play_integrity', 'ios_app_attest'),
      'max_age_seconds', 600,
      'challenge_ttl_seconds', 600
    )
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner::text)::text, true);

  SELECT *
    INTO v_challenge_a
    FROM api.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'register_user_device_v1',
        'device_id', v_device_a.device_id,
        'metadata', jsonb_build_object('source', 'device-lifecycle-reattest')
      )
    )
    LIMIT 1;

  BEGIN
    SELECT *
      INTO v_device_a_reattest
      FROM api.register_user_device_v1(
        jsonb_build_object(
          'device_platform', 'android',
          'device_identifier_sha256', 'b07-device-lifecycle-device-a',
          'device_label', 'Driver phone A re-attested',
          'push_token', 'push-token-a-2',
          'app_version', '1.0.1',
          'os_version', '14.1',
          'metadata', pg_temp.mobile_attestation_metadata_v1(
            v_challenge_a.challenge_id,
            v_challenge_a.challenge,
            're_attest_existing_device'
          )
        )
      )
      LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'device lifecycle existing re-attestation failed: %', SQLERRM USING ERRCODE = SQLSTATE;
  END;

  RETURN NEXT ok(v_device_a_reattest.created IS FALSE, 're-attestation updates the existing device instead of duplicating it');
  RETURN NEXT is(v_device_a_reattest.device_id::text, v_device_a.device_id::text, 're-attestation keeps the canonical device id stable');
  RETURN NEXT is(
    (SELECT app_version FROM api.user_devices WHERE id = v_device_a.device_id),
    '1.0.1',
    're-attestation updates runtime version metadata through the device registry'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT consumed_by_rpc FROM public.mobile_attestation_challenges WHERE id = v_challenge_a.challenge_id),
    'register_user_device_v1',
    're-attestation consumes the register_user_device_v1 challenge'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.mobile_attestation_events
      WHERE challenge_id = v_challenge_a.challenge_id
        AND device_id = v_device_a.device_id
        AND rpc_name = 'register_user_device_v1'
        AND passed IS TRUE
    ),
    're-attestation writes a passing attestation event'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_operator::text)::text, true);

  v_revoke_result := api.ui_execute_user_device_revoke_v1(
    'user_devices.revoke',
    'user_devices',
    ARRAY[v_device_a.device_id::text],
    v_device_a.device_id::text,
    1,
    jsonb_build_object('revoked_reason', 'stolen device reported')
  );

  RETURN NEXT is(v_revoke_result->>'status', 'revoked', 'stolen-device recovery uses the dedicated UI revoke executor');
  RETURN NEXT is((v_revoke_result->>'count')::int, 1, 'UI revoke executor reports one affected device');

  v_old_detail := public.ui_get_resource_v1('user_devices', v_device_a.device_id);

  RETURN NEXT ok((v_old_detail->>'revoked_at') IS NOT NULL, 'stolen-device recovery marks the old device revoked');
  RETURN NEXT is(v_old_detail->>'revoked_reason', 'stolen device reported', 'stolen-device recovery keeps the human reason visible');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.user_devices
      WHERE id = v_device_a.device_id
        AND push_token IS NULL
    ),
    'stolen-device recovery clears push delivery for the old device'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner::text)::text, true);

  BEGIN
    PERFORM api.register_user_device_v1(
      jsonb_build_object(
        'device_platform', 'android',
        'device_identifier_sha256', 'b07-device-lifecycle-device-a',
        'push_token', 'push-token-a-reuse'
      )
    );
    RETURN NEXT fail('stolen old device cannot silently re-register');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RETURN NEXT ok(
      SQLERRM = format('register_user_device_v1 device %s is revoked', v_device_a.device_id),
      'stolen old device cannot silently re-register'
    );
  END;

  BEGIN
    INSERT INTO public.location_pings (
      organization_id,
      actor_user_id,
      device_id,
      coordinates,
      accuracy_m,
      idempotency_key,
      metadata,
      captured_at
    ) VALUES (
      v_org,
      v_owner,
      v_device_a.device_id,
      ST_SetSRID(ST_MakePoint(46.6753, 24.7136), 4326)::geography,
      8,
      'device-lifecycle-revoked-old-device',
      jsonb_build_object('source', 'device-lifecycle-pgtap'),
      clock_timestamp()
    );
    RETURN NEXT fail('revoked old device must not be accepted by mobile ingest ledgers');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RETURN NEXT pass('revoked old device is rejected by mobile ingest ledger guardrails');
  END;

  SELECT *
    INTO v_challenge_b
    FROM api.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'register_user_device_v1',
        'metadata', jsonb_build_object('source', 'device-lifecycle-replacement')
      )
    )
    LIMIT 1;

  BEGIN
    SELECT *
      INTO v_device_b
      FROM api.register_user_device_v1(
        jsonb_build_object(
          'device_platform', 'android',
          'device_identifier_sha256', 'b07-device-lifecycle-device-b',
          'device_label', 'Driver phone B replacement',
          'push_token', 'push-token-b',
          'app_version', '1.0.2',
          'os_version', '15',
          'metadata', pg_temp.mobile_attestation_metadata_v1(
            v_challenge_b.challenge_id,
            v_challenge_b.challenge,
            'replacement_device_register'
          )
        )
      )
      LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'device lifecycle replacement registration failed: %', SQLERRM USING ERRCODE = SQLSTATE;
  END;

  RETURN NEXT ok(v_device_b.created IS TRUE, 'replacement device registers after stolen-device revoke');
  RETURN NEXT isnt(v_device_b.device_id::text, v_device_a.device_id::text, 'replacement device receives a new canonical device id');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT consumed_by_rpc FROM public.mobile_attestation_challenges WHERE id = v_challenge_b.challenge_id),
    'register_user_device_v1',
    'replacement registration consumes its attestation challenge'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM api.user_devices
      WHERE id = v_device_b.device_id
        AND revoked_at IS NULL
        AND device_label = 'Driver phone B replacement'
    ),
    'api.user_devices exposes the active replacement device'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner::text)::text, true);

  SELECT *
    INTO v_challenge_b_reattest
    FROM api.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'register_user_device_v1',
        'device_id', v_device_b.device_id,
        'metadata', jsonb_build_object('source', 'device-lifecycle-replacement-reattest')
      )
    )
    LIMIT 1;

  BEGIN
    SELECT *
      INTO v_device_b_reattest
      FROM api.register_user_device_v1(
        jsonb_build_object(
          'device_platform', 'android',
          'device_identifier_sha256', 'b07-device-lifecycle-device-b',
          'device_label', 'Driver phone B re-attested',
          'push_token', 'push-token-b-2',
          'app_version', '1.0.3',
          'os_version', '15.1',
          'metadata', pg_temp.mobile_attestation_metadata_v1(
            v_challenge_b_reattest.challenge_id,
            v_challenge_b_reattest.challenge,
            'replacement_device_reattest'
          )
        )
      )
      LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'device lifecycle replacement re-attestation failed: %', SQLERRM USING ERRCODE = SQLSTATE;
  END;

  RETURN NEXT ok(v_device_b_reattest.created IS FALSE, 'replacement device re-attestation updates in place');
  RETURN NEXT is(v_device_b_reattest.device_id::text, v_device_b.device_id::text, 'replacement re-attestation keeps the device id stable');
  RETURN NEXT is(
    (SELECT app_version FROM api.user_devices WHERE id = v_device_b.device_id),
    '1.0.3',
    'replacement re-attestation refreshes app version'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.mobile_attestation_events
      WHERE challenge_id = v_challenge_b_reattest.challenge_id
        AND device_id = v_device_b.device_id
        AND passed IS TRUE
    ),
    'replacement re-attestation records a passing attestation event'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_b07_device_lifecycle_recovery_v1();

SELECT * FROM finish();

ROLLBACK;
