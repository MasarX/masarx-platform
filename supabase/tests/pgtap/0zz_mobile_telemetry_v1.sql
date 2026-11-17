-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Mobile telemetry foundation v1 (user_devices + location_pings + scan_events)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(41);

CREATE OR REPLACE FUNCTION pg_temp.test_mobile_telemetry_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();

  v_user1 UUID := gen_random_uuid();
  v_user2 UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();

  v_shipment UUID := gen_random_uuid();
  v_route_run UUID := gen_random_uuid();
  v_route_stop UUID := gen_random_uuid();

  v_device1 RECORD;
  v_device2 RECORD;

  v_ping1 RECORD;
  v_ping2 RECORD;

  v_scan1 RECORD;
  v_scan2 RECORD;
  v_scan3 RECORD;
BEGIN
  RETURN NEXT has_table('public', 'user_devices', 'user_devices table exists');
  RETURN NEXT has_table('public', 'location_pings', 'location_pings table exists');
  RETURN NEXT has_table('public', 'location_ping_dedupe', 'location_ping_dedupe table exists');
  RETURN NEXT has_table('public', 'scan_events', 'scan_events table exists');
  RETURN NEXT has_table('public', 'scan_event_dedupe', 'scan_event_dedupe table exists');

  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_devices'), 'RLS enabled on user_devices');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'location_pings'), 'RLS enabled on location_pings');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'location_ping_dedupe'), 'RLS enabled on location_ping_dedupe');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'scan_events'), 'RLS enabled on scan_events');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'scan_event_dedupe'), 'RLS enabled on scan_event_dedupe');

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'user_devices'),
    'user_devices registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'location_pings'),
    'location_pings registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'location_ping_dedupe'),
    'location_ping_dedupe registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'scan_events'),
    'scan_events registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'scan_event_dedupe'),
    'scan_event_dedupe registered in table_contracts'
  );

  RETURN NEXT has_function('public', 'register_user_device_v1', ARRAY['jsonb'], 'register_user_device_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'record_location_ping_v1', ARRAY['jsonb'], 'record_location_ping_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'record_scan_event_v1', ARRAY['jsonb'], 'record_scan_event_v1(jsonb) exists');

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Telemetry Org', 'telemetry-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'tel-br-' || left(v_branch::text, 8), 'Telemetry Branch', 'UTC', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Telemetry Client', 'tel-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Telemetry Sender', 'Telemetry Sender', TRUE, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_user1, v_org, 'tel-u1-' || left(v_user1::text, 8) || '@example.com', 'Telemetry User 1', 'tenant'),
    (v_user2, v_org, 'tel-u2-' || left(v_user2::text, 8) || '@example.com', 'Telemetry User 2', 'tenant');

  -- RBAC: mobile ingest and ops session RPCs are permission-gated; grant driver role to the telemetry actor.
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_user1);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user1, r.id, v_user1, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type, access_scope_id)
  VALUES
    (v_user_client, v_org, 'tel-client-u-' || left(v_user_client::text, 8) || '@example.com', 'Telemetry Client User', 'client', v_client);

  -- Client-scoped users must not be able to use internal device/telemetry RPCs.
  PERFORM set_config('request.jwt.claim.sub', v_user_client::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    $$ SELECT * FROM public.register_user_device_v1(jsonb_build_object('device_platform','android','device_identifier_sha256','pgtap-client-device-1')) $$,
    '42501',
    'register_user_device_v1 requires tenant scope'
  );
  RETURN NEXT throws_ok(
    $$ SELECT * FROM public.record_location_ping_v1(jsonb_build_object('idempotency_key','pgtap-client-loc-1','lat',1,'lng',1)) $$,
    '42501',
    'record_location_ping_v1 requires tenant scope'
  );
  RETURN NEXT throws_ok(
    $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object('idempotency_key','pgtap-client-scan-1','scan_type','pickup','barcode','x')) $$,
    '42501',
    'record_scan_event_v1 requires tenant scope'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', 'pgtap-tel-' || left(v_shipment::text, 8), 'created');

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, vehicle_id, status)
  VALUES (v_route_run, v_org, v_branch, v_user1, v_vehicle, 'planned');

  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
  VALUES (v_route_stop, v_org, v_route_run, v_client, v_shipment, 'delivery', 1);

  -- Simulate user1 authenticated context for device + telemetry ingest RPCs.
  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_device1
    FROM public.register_user_device_v1(
      jsonb_build_object(
        'device_platform', 'android',
        'device_identifier_sha256', 'pgtap-device-1',
        'push_token', 'pgtap-push-1'
      )
    )
    LIMIT 1;

  SELECT *
    INTO v_device2
    FROM public.register_user_device_v1(
      jsonb_build_object(
        'device_platform', 'android',
        'device_identifier_sha256', 'pgtap-device-1',
        'push_token', 'pgtap-push-2'
      )
    )
    LIMIT 1;

  RETURN NEXT ok(v_device1.created IS TRUE, 'register_user_device_v1 first call created=true');
  RETURN NEXT ok(v_device2.created IS FALSE, 'register_user_device_v1 second call created=false (idempotent)');
  RETURN NEXT is(v_device1.device_id::text, v_device2.device_id::text, 'register_user_device_v1 returns same device_id on replay');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.user_devices WHERE organization_id = v_org AND user_id = v_user1 AND id = v_device1.device_id),
    1,
    'authenticated user can read own user_devices row'
  );

  SELECT *
    INTO v_ping1
    FROM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'pgtap-loc-1',
        'device_id', v_device1.device_id,
        'route_run_id', v_route_run,
        'route_stop_id', v_route_stop,
        'lat', 24.7136,
        'lng', 46.6753,
        'captured_at', now()
      )
    )
    LIMIT 1;

  SELECT *
    INTO v_ping2
    FROM public.record_location_ping_v1(
      jsonb_build_object(
        'idempotency_key', 'pgtap-loc-1',
        'device_id', v_device1.device_id,
        'route_run_id', v_route_run,
        'route_stop_id', v_route_stop,
        'lat', 24.7136,
        'lng', 46.6753,
        'captured_at', now()
      )
    )
    LIMIT 1;

  RETURN NEXT ok(v_ping1.created IS TRUE, 'record_location_ping_v1 first call created=true');
  RETURN NEXT ok(v_ping2.created IS FALSE, 'record_location_ping_v1 second call created=false (idempotent)');
  RETURN NEXT is(v_ping1.location_ping_id::text, v_ping2.location_ping_id::text, 'record_location_ping_v1 returns same location_ping_id on replay');

  SELECT *
    INTO v_scan1
    FROM public.record_scan_event_v1(
      jsonb_build_object(
        'idempotency_key', 'pgtap-scan-1',
        'device_id', v_device1.device_id,
        'route_stop_id', v_route_stop,
        'scan_type', 'pickup',
        'barcode', 'pgtap-barcode-1',
        'captured_at', now()
      )
    )
    LIMIT 1;

  SELECT *
    INTO v_scan2
    FROM public.record_scan_event_v1(
      jsonb_build_object(
        'idempotency_key', 'pgtap-scan-1',
        'device_id', v_device1.device_id,
        'route_stop_id', v_route_stop,
        'scan_type', 'pickup',
        'barcode', 'pgtap-barcode-1',
        'captured_at', now()
      )
    )
    LIMIT 1;

  RETURN NEXT ok(v_scan1.created IS TRUE, 'record_scan_event_v1 first call created=true');
  RETURN NEXT ok(v_scan2.created IS FALSE, 'record_scan_event_v1 second call created=false (idempotent)');
  RETURN NEXT is(v_scan1.scan_event_id::text, v_scan2.scan_event_id::text, 'record_scan_event_v1 returns same scan_event_id on replay');

  -- Warehouse scan UX: barcode-only scans can auto-link to a shipment when possible (no client hardcoding).
  SELECT *
    INTO v_scan3
    FROM public.record_scan_event_v1(
      jsonb_build_object(
        'idempotency_key', 'pgtap-scan-barcode-1',
        'device_id', v_device1.device_id,
        'scan_type', 'sort',
        'barcode', ('pgtap-tel-' || left(v_shipment::text, 8) || ':1'),
        'captured_at', now()
      )
    )
    LIMIT 1;

  RETURN NEXT ok(v_scan3.created IS TRUE, 'record_scan_event_v1 barcode-only call created=true');

  -- Telemetry ledgers are service-only tables (no direct SELECT for authenticated); writes happen via RPCs.
  RETURN NEXT ok(
    NOT has_table_privilege('authenticated', 'public.location_pings', 'select'),
    'authenticated has no SELECT privilege on location_pings'
  );
  RETURN NEXT ok(
    NOT has_table_privilege('authenticated', 'public.scan_events', 'select'),
    'authenticated has no SELECT privilege on scan_events'
  );
  RETURN NEXT throws_ok(
    'SELECT COUNT(*) FROM public.location_pings',
    '42501',
    'permission denied for table location_pings'
  );
  RETURN NEXT throws_ok(
    'SELECT COUNT(*) FROM public.scan_events',
    '42501',
    'permission denied for table scan_events'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  -- Verify inserts landed (postgres bypass).
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.location_pings WHERE organization_id = v_org AND id = v_ping1.location_ping_id AND actor_user_id = v_user1),
    1,
    'location_pings row inserted via record_location_ping_v1'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.scan_events WHERE organization_id = v_org AND id = v_scan1.scan_event_id AND actor_user_id = v_user1),
    1,
    'scan_events row inserted via record_scan_event_v1'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::int
      FROM public.scan_events
      WHERE organization_id = v_org
        AND id = v_scan3.scan_event_id
        AND client_id = v_client
        AND shipment_id = v_shipment
    ),
    1,
    'barcode-only scan auto-links to shipment/client when tracking matches'
  );

  RETURN NEXT ok(
    NOT has_table_privilege('authenticated', 'public.location_ping_dedupe', 'select'),
    'authenticated has no SELECT privilege on location_ping_dedupe'
  );
  RETURN NEXT ok(
    NOT has_table_privilege('authenticated', 'public.scan_event_dedupe', 'select'),
    'authenticated has no SELECT privilege on scan_event_dedupe'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_mobile_telemetry_v1();

SELECT * FROM finish();

ROLLBACK;
