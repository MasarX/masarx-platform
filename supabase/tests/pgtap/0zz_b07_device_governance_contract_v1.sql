-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- pgTAP: B07 device governance contract foundation v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(18);

CREATE OR REPLACE FUNCTION pg_temp.test_b07_device_governance_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_device RECORD;
  v_device_id UUID;
  v_revoke_rows RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_column('public', 'user_devices', 'revoked_at', 'user_devices has revoked_at');
  RETURN NEXT has_column('public', 'user_devices', 'revoked_by_user_id', 'user_devices has revoked_by_user_id');
  RETURN NEXT has_column('public', 'user_devices', 'revoked_reason', 'user_devices has revoked_reason');
  RETURN NEXT has_view('api', 'user_devices', 'api.user_devices view exists');
  RETURN NEXT has_function('public', 'revoke_user_device_v1', ARRAY['jsonb'], 'public.revoke_user_device_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'revoke_user_device_v1', ARRAY['jsonb'], 'api.revoke_user_device_v1(jsonb) exists');
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.revoke_user_device_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute api.revoke_user_device_v1'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'public.revoke_user_device_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute public.revoke_user_device_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'location_pings'
        AND t.tgname = 'trg_block_revoked_user_devices_v1'
        AND NOT t.tgisinternal
    ),
    'location_pings revoked-device trigger exists'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'scan_events'
        AND t.tgname = 'trg_block_revoked_user_scan_events_v1'
        AND NOT t.tgisinternal
    ),
    'scan_events revoked-device trigger exists'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'ops_sessions'
        AND t.tgname = 'trg_block_revoked_user_ops_sessions_v1'
        AND NOT t.tgisinternal
    ),
    'ops_sessions revoked-device trigger exists'
  );

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Device Governance Org', 'device-governance-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client,
    v_org,
    'Device Governance Client',
    'device-governance-client-' || left(v_client::text, 8),
    'active'
  );

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Device Governance Sender', 'active');

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:device-governance-fixture-bootstrap');

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'device-governance-' || left(v_user::text, 8) || '@example.com', 'Device Governance User', 'tenant');

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_device
    FROM public.register_user_device_v1(
      jsonb_build_object(
        'device_platform', 'android',
        'device_identifier_sha256', 'b07-device-governance-device-1',
        'device_label', 'B07 device governance',
        'push_token', 'push-token-1'
      )
    )
    LIMIT 1;

  v_device_id := v_device.device_id;

  RETURN NEXT ok(v_device.created IS TRUE, 'register_user_device_v1 creates the device');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.user_devices WHERE id = v_device_id),
    1,
    'api.user_devices exposes the registered device to the owner'
  );

  SELECT *
    INTO v_revoke_rows
    FROM public.revoke_user_device_v1(
      jsonb_build_object(
        'device_id', v_device_id,
        'revoked_reason', 'lost device'
      )
    )
    LIMIT 1;

  RETURN NEXT is(v_revoke_rows.device_id::text, v_device_id::text, 'revoke_user_device_v1 returns the same device_id');
  RETURN NEXT ok(v_revoke_rows.revoked IS TRUE, 'revoke_user_device_v1 marks the device revoked');
  RETURN NEXT ok(v_revoke_rows.revoked_at IS NOT NULL, 'revoke_user_device_v1 returns revoked_at');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM api.user_devices
      WHERE id = v_device_id
        AND revoked_at IS NOT NULL
        AND revoked_reason = 'lost device'
    ),
    'api.user_devices exposes revoked state'
  );

  RETURN NEXT throws_ok(
    $$ SELECT * FROM public.register_user_device_v1(jsonb_build_object('device_platform','android','device_identifier_sha256','b07-device-governance-device-1','push_token','push-token-2')) $$,
    '42501',
    format('register_user_device_v1 device %s is revoked', v_device_id)
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_b07_device_governance_contract_v1();

SELECT * FROM finish();

ROLLBACK;
