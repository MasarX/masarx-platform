-- pgTAP: B07 mobile attestation + ingest DB contract proof

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(27);

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
      'pgTAP B07 mobile attestation ingest contract upsert',
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
  p_generated_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE sql
AS $function$
  SELECT jsonb_build_object(
    'source', 'mobile',
    'attestation', jsonb_build_object(
      'provider', 'android_play_integrity',
      'challenge_id', p_challenge_id,
      'challenge', p_challenge,
      'generated_at', p_generated_at,
      'integrity_token', encode(gen_random_bytes(32), 'hex')
    )
  );
$function$;

CREATE OR REPLACE FUNCTION pg_temp.test_b07_mobile_attestation_ingest_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_client_user UUID := gen_random_uuid();

  v_device RECORD;
  v_challenge RECORD;
  v_scan RECORD;
  v_scan_replay RECORD;
  v_ingest_policy RECORD;
  v_attestation_policy RECORD;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  RETURN NEXT has_function('api', 'register_user_device_v1', ARRAY['jsonb'], 'api.register_user_device_v1 wrapper exists');
  RETURN NEXT has_function('api', 'issue_mobile_attestation_challenge_v1', ARRAY['jsonb'], 'api.issue_mobile_attestation_challenge_v1 wrapper exists');
  RETURN NEXT has_function('api', 'record_scan_event_v1', ARRAY['jsonb'], 'api.record_scan_event_v1 wrapper exists');
  RETURN NEXT has_function('api', 'record_location_ping_v1', ARRAY['jsonb'], 'api.record_location_ping_v1 wrapper exists');

  RETURN NEXT ok(has_function_privilege('authenticated', 'api.register_user_device_v1(jsonb)', 'EXECUTE'), 'authenticated can execute api.register_user_device_v1');
  RETURN NEXT ok(has_function_privilege('authenticated', 'api.issue_mobile_attestation_challenge_v1(jsonb)', 'EXECUTE'), 'authenticated can execute api.issue_mobile_attestation_challenge_v1');
  RETURN NEXT ok(has_function_privilege('authenticated', 'api.record_scan_event_v1(jsonb)', 'EXECUTE'), 'authenticated can execute api.record_scan_event_v1');
  RETURN NEXT ok(has_function_privilege('authenticated', 'api.record_location_ping_v1(jsonb)', 'EXECUTE'), 'authenticated can execute api.record_location_ping_v1');

  RETURN NEXT ok(NOT has_function_privilege('anon', 'api.register_user_device_v1(jsonb)', 'EXECUTE'), 'anon cannot execute api.register_user_device_v1');
  RETURN NEXT ok(NOT has_function_privilege('anon', 'api.issue_mobile_attestation_challenge_v1(jsonb)', 'EXECUTE'), 'anon cannot execute api.issue_mobile_attestation_challenge_v1');
  RETURN NEXT ok(NOT has_function_privilege('anon', 'api.record_scan_event_v1(jsonb)', 'EXECUTE'), 'anon cannot execute api.record_scan_event_v1');
  RETURN NEXT ok(NOT has_function_privilege('anon', 'api.record_location_ping_v1(jsonb)', 'EXECUTE'), 'anon cannot execute api.record_location_ping_v1');

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B07 Mobile Contract Org', 'b07-mobile-contract-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'b07-mob-' || left(v_branch::text, 8), 'B07 Mobile Contract Branch', 'UTC', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B07 Mobile Contract Client', 'b07-mobile-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'B07 Mobile Contract Sender', 'B07 Mobile Contract Sender', TRUE, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, status)
  VALUES (
    v_driver,
    v_org,
    'b07-mobile-driver-' || left(v_driver::text, 8) || '@example.com',
    'B07 Mobile Driver',
    'driver',
    'tenant',
    'active'
  );

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type, access_scope_id, status)
  VALUES (
    v_client_user,
    v_org,
    'b07-mobile-client-' || left(v_client_user::text, 8) || '@example.com',
    'B07 Mobile Client User',
    'client',
    v_client,
    'active'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_client_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_client_user::text)::text, true);

  BEGIN
    PERFORM api.register_user_device_v1(
      jsonb_build_object(
        'device_platform', 'android',
        'device_identifier_sha256', 'b07-mobile-client-device'
      )
    );
    RETURN NEXT fail('client-scoped user cannot register mobile devices');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('requires tenant scope' in SQLERRM) > 0 THEN
      RETURN NEXT pass('client-scoped user cannot register mobile devices');
    ELSE
      RETURN NEXT fail('expected tenant-scope register block, got: ' || SQLERRM);
    END IF;
  END;

  BEGIN
    PERFORM api.issue_mobile_attestation_challenge_v1(
      jsonb_build_object('rpc_name', 'record_scan_event_v1')
    );
    RETURN NEXT fail('client-scoped user cannot issue mobile attestation challenges');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('requires tenant scope' in SQLERRM) > 0 THEN
      RETURN NEXT pass('client-scoped user cannot issue mobile attestation challenges');
    ELSE
      RETURN NEXT fail('expected tenant-scope challenge block, got: ' || SQLERRM);
    END IF;
  END;

  BEGIN
    PERFORM api.record_scan_event_v1(
      jsonb_build_object(
        'idempotency_key', 'b07-client-scope-scan-' || left(v_client_user::text, 8),
        'scan_type', 'pickup',
        'barcode', 'B07-CLIENT-SCOPE'
      )
    );
    RETURN NEXT fail('client-scoped user cannot use protected scan ingest');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('requires tenant scope' in SQLERRM) > 0 THEN
      RETURN NEXT pass('client-scoped user cannot use protected scan ingest');
    ELSE
      RETURN NEXT fail('expected tenant-scope scan block, got: ' || SQLERRM);
    END IF;
  END;

  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM pg_temp.upsert_setting_cache_v1(
    'mobile_ingest_policy',
    'global',
    NULL,
    jsonb_build_object(
      'enabled', FALSE,
      'require_device', TRUE,
      'accepted_event_types', jsonb_build_array('location_ping')
    )
  );

  PERFORM pg_temp.upsert_setting_cache_v1(
    'mobile_ingest_policy',
    'tenant',
    v_org,
    jsonb_build_object(
      'enabled', TRUE,
      'require_device', TRUE,
      'accepted_event_types', jsonb_build_array('scan_event')
    )
  );

  PERFORM pg_temp.upsert_setting_cache_v1(
    'mobile_attestation_policy',
    'global',
    NULL,
    jsonb_build_object(
      'enabled', FALSE,
      'mode', 'off',
      'enforce_rpcs', jsonb_build_array('record_scan_event_v1')
    )
  );

  PERFORM pg_temp.upsert_setting_cache_v1(
    'mobile_attestation_policy',
    'tenant',
    v_org,
    jsonb_build_object(
      'enabled', TRUE,
      'mode', 'enforce',
      'enforce_rpcs', jsonb_build_array('record_scan_event_v1'),
      'allow_background_without_attestation', FALSE,
      'allowed_providers', jsonb_build_array('android_play_integrity', 'ios_app_attest'),
      'max_age_seconds', 600,
      'challenge_ttl_seconds', 600
    )
  );

  SELECT *
    INTO v_ingest_policy
    FROM public.resolve_mobile_ingest_policy(jsonb_build_object('organization_id', v_org))
    LIMIT 1;

  RETURN NEXT is(v_ingest_policy.scope_type, 'tenant', 'mobile_ingest_policy resolves tenant override over global');

  SELECT *
    INTO v_attestation_policy
    FROM public.resolve_mobile_attestation_policy(jsonb_build_object('organization_id', v_org, 'user_id', v_driver))
    LIMIT 1;

  RETURN NEXT ok(
    v_attestation_policy.scope_type = 'tenant'
      AND v_attestation_policy.value->>'mode' = 'enforce',
    'mobile_attestation_policy resolves tenant enforce override over global off'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_driver::text)::text, true);

  SELECT *
    INTO v_device
    FROM api.register_user_device_v1(
      jsonb_build_object(
        'device_platform', 'android',
        'device_identifier_sha256', 'b07-mobile-contract-device',
        'device_label', 'B07 Mobile Contract Device',
        'push_token', 'b07-mobile-contract-push',
        'app_version', '1.0.0',
        'os_version', '14'
      )
    )
    LIMIT 1;

  RETURN NEXT ok(v_device.created IS TRUE AND v_device.device_id IS NOT NULL, 'api.register_user_device_v1 creates a driver device before scan ingest');

  BEGIN
    PERFORM api.record_scan_event_v1(
      jsonb_build_object(
        'idempotency_key', 'b07-scan-missing-device-' || left(v_driver::text, 8),
        'scan_type', 'pickup',
        'barcode', 'B07-MISSING-DEVICE'
      )
    );
    RETURN NEXT fail('scan ingest without device_id is rejected when mobile_ingest_policy requires device');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('requires device_id by policy' in SQLERRM) > 0 THEN
      RETURN NEXT pass('scan ingest without device_id is rejected when mobile_ingest_policy requires device');
    ELSE
      RETURN NEXT fail('expected mobile_ingest_policy device block, got: ' || SQLERRM);
    END IF;
  END;

  BEGIN
    PERFORM api.record_scan_event_v1(
      jsonb_build_object(
        'idempotency_key', 'b07-scan-missing-attestation-' || left(v_driver::text, 8),
        'device_id', v_device.device_id,
        'scan_type', 'pickup',
        'barcode', 'B07-MISSING-ATTESTATION',
        'captured_at', v_now
      )
    );
    RETURN NEXT fail('scan ingest without attestation is rejected when mobile_attestation_policy enforces it');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('mobile attestation blocked by policy' in SQLERRM) > 0 THEN
      RETURN NEXT pass('scan ingest without attestation is rejected when mobile_attestation_policy enforces it');
    ELSE
      RETURN NEXT fail('expected mobile attestation policy block, got: ' || SQLERRM);
    END IF;
  END;

  SELECT *
    INTO v_challenge
    FROM api.issue_mobile_attestation_challenge_v1(
      jsonb_build_object(
        'rpc_name', 'record_scan_event_v1',
        'device_id', v_device.device_id,
        'metadata', jsonb_build_object('source', 'b07-mobile-contract')
      )
    )
    LIMIT 1;

  RETURN NEXT ok(
    v_challenge.policy_mode = 'enforce'
      AND v_challenge.policy_scope_type = 'tenant',
    'api.issue_mobile_attestation_challenge_v1 returns row-driven enforce policy context'
  );

  SELECT *
    INTO v_scan
    FROM api.record_scan_event_v1(
      jsonb_build_object(
        'idempotency_key', 'b07-valid-scan-' || left(v_driver::text, 8),
        'device_id', v_device.device_id,
        'scan_type', 'pickup',
        'barcode', 'B07-VALID-ATTESTED-SCAN',
        'captured_at', v_now + interval '5 seconds',
        'metadata', pg_temp.mobile_attestation_metadata_v1(
          v_challenge.challenge_id,
          v_challenge.challenge,
          v_now + interval '5 seconds'
        )
      )
    )
    LIMIT 1;

  RETURN NEXT ok(v_scan.created IS TRUE AND v_scan.scan_event_id IS NOT NULL, 'attested scan ingest succeeds in enforce mode');

  SELECT *
    INTO v_scan_replay
    FROM api.record_scan_event_v1(
      jsonb_build_object(
        'idempotency_key', 'b07-valid-scan-' || left(v_driver::text, 8),
        'device_id', v_device.device_id,
        'scan_type', 'pickup',
        'barcode', 'B07-VALID-ATTESTED-SCAN',
        'captured_at', v_now + interval '5 seconds'
      )
    )
    LIMIT 1;

  RETURN NEXT ok(
    v_scan_replay.created IS FALSE
      AND v_scan_replay.scan_event_id = v_scan.scan_event_id,
    'scan ingest replay is idempotent and returns the original scan_event_id'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT consumed_by_rpc FROM public.mobile_attestation_challenges WHERE id = v_challenge.challenge_id),
    'record_scan_event_v1',
    'attested scan consumes the one-time mobile attestation challenge'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.mobile_attestation_events
      WHERE organization_id = v_org
        AND user_id = v_driver
        AND device_id = v_device.device_id
        AND rpc_name = 'record_scan_event_v1'
        AND challenge_id = v_challenge.challenge_id
        AND passed IS TRUE
    ),
    'attested scan writes a passing mobile_attestation_events row'
  );

  PERFORM pg_temp.upsert_setting_cache_v1(
    'mobile_ingest_policy',
    'resource',
    v_branch,
    jsonb_build_object(
      'enabled', FALSE,
      'require_device', TRUE,
      'accepted_event_types', jsonb_build_array('scan_event')
    )
  );

  SELECT *
    INTO v_ingest_policy
    FROM public.resolve_mobile_ingest_policy(
      jsonb_build_object('organization_id', v_org, 'resource_id', v_branch)
    )
    LIMIT 1;

  RETURN NEXT is(v_ingest_policy.scope_type, 'resource', 'mobile_ingest_policy resolves branch resource override before tenant');

  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    PERFORM api.record_scan_event_v1(
      jsonb_build_object(
        'idempotency_key', 'b07-resource-disabled-scan-' || left(v_driver::text, 8),
        'device_id', v_device.device_id,
        'branch_id', v_branch,
        'scan_type', 'pickup',
        'barcode', 'B07-RESOURCE-DISABLED'
      )
    );
    RETURN NEXT fail('resource mobile_ingest_policy.enabled=false blocks branch scan ingest');
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('mobile_ingest_policy.enabled=false' in SQLERRM) > 0 THEN
      RETURN NEXT pass('resource mobile_ingest_policy.enabled=false blocks branch scan ingest');
    ELSE
      RETURN NEXT fail('expected resource mobile_ingest_policy block, got: ' || SQLERRM);
    END IF;
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_b07_mobile_attestation_ingest_contract_v1();

SELECT * FROM finish();

ROLLBACK;
