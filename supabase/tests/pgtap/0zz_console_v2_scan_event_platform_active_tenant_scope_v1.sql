-- pgTAP: Console V2 scanner writes route-load scans in the active tenant lens.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_scan_event_platform_active_tenant_scope_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_platform_home_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_platform_user UUID := gen_random_uuid();
  v_tenant_user UUID := gen_random_uuid();
  v_shipment_id UUID := gen_random_uuid();
  v_tracking TEXT := 'Scan-Mixed-' || upper(left(gen_random_uuid()::text, 8));
  v_box_barcode TEXT;
  v_box_scan RECORD;
  v_route RECORD;
  v_stop_id UUID;
  v_scan RECORD;
  v_unexpected_scan RECORD;
  v_revoked_device_id UUID;
  v_reissued_device_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'api',
    'record_scan_event_v1',
    ARRAY['jsonb'],
    'api.record_scan_event_v1 exists'
  );

  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.record_scan_event_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute api.record_scan_event_v1'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Console Scanner Tenant', 'console-scanner-tenant-' || left(v_org::text, 8)),
    (v_other_org, 'Console Scanner Other Tenant', 'console-scanner-other-' || left(v_other_org::text, 8)),
    (v_platform_home_org, 'Console Scanner Platform Home', 'console-scanner-platform-' || left(v_platform_home_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (
      v_platform_user,
      v_platform_home_org,
      'scanner-platform-' || left(v_platform_user::text, 8) || '@example.com',
      'Scanner Platform Operator',
      'super_admin',
      'active',
      'platform',
      NULL
    ),
    (
      v_tenant_user,
      v_org,
      'scanner-tenant-' || left(v_tenant_user::text, 8) || '@example.com',
      'Scanner Tenant Operator',
      'ops_admin',
      'active',
      'tenant',
      NULL
    );

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'scan-' || lower(left(v_org::text, 6)), 'Scanner Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Scanner Client', 'scanner-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
  VALUES (v_shipment_id, v_org, v_client, v_tracking, 'delivery', 'pending');

  PERFORM public.ensure_shipment_boxes(v_shipment_id, 1);
  SELECT barcode INTO STRICT v_box_barcode
  FROM public.shipment_boxes
  WHERE shipment_id = v_shipment_id AND box_number = 1;

  SELECT *
    INTO v_route
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'idempotency_key', 'pgtap-scanner-route-' || left(v_org::text, 8),
        'stops', jsonb_build_array(
          jsonb_build_object(
            'client_id', v_client,
            'shipment_id', v_shipment_id,
            'stop_kind', 'delivery',
            'sequence_order', 1
          )
        )
      )
    )
   LIMIT 1;
  v_stop_id := v_route.stop_ids[1];

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_scan
    FROM api.record_scan_event_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'scan_type', 'load',
        'route_run_id', v_route.route_run_id,
        'route_stop_id', v_stop_id,
        'branch_id', v_branch,
        'client_id', v_client,
        'shipment_id', v_shipment_id,
        'barcode', v_tracking,
        'idempotency_key', 'pgtap-scanner-platform-active-tenant',
        'metadata', jsonb_build_object('source', 'console_v2_dispatch')
      )
    )
   LIMIT 1;

  RETURN NEXT ok(COALESCE(v_scan.created, FALSE), 'platform active-tenant route-load scan is created');

  -- Omitting shipment, client and stop IDs exercises canonical barcode lookup.
  SELECT *
    INTO v_box_scan
    FROM api.record_scan_event_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'scan_type', 'load',
        'route_run_id', v_route.route_run_id,
        'branch_id', v_branch,
        'barcode', v_box_barcode,
        'idempotency_key', 'pgtap-scanner-mixed-case-box',
        'metadata', jsonb_build_object('source', 'console_v2_dispatch')
      )
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT shipment_id FROM public.scan_events WHERE id = v_box_scan.scan_event_id),
    v_shipment_id,
    'mixed-case box barcode resolves to the shipment through scan intake'
  );
  RETURN NEXT is(
    (SELECT organization_id::text FROM public.scan_events WHERE id = v_scan.scan_event_id),
    v_org::text,
    'scan event stores active tenant organization_id'
  );
  RETURN NEXT is(
    (SELECT actor_user_id::text FROM public.scan_events WHERE id = v_scan.scan_event_id),
    v_platform_user::text,
    'scan event stores the authenticated platform actor'
  );
  RETURN NEXT ok(
    (SELECT device_id IS NOT NULL FROM public.scan_events WHERE id = v_scan.scan_event_id),
    'scan event stores a managed Console V2 scanner device'
  );
  SELECT device_id
    INTO v_revoked_device_id
    FROM public.scan_events
   WHERE id = v_scan.scan_event_id;

  RETURN NEXT is(
    (SELECT route_stop_id::text FROM public.scan_events WHERE id = v_scan.scan_event_id),
    v_stop_id::text,
    'scan event keeps the route stop linkage'
  );

  UPDATE public.user_devices
     SET revoked_at = now(),
         revoked_by_user_id = v_platform_user,
         revoked_reason = 'pgtap console scanner reissue proof',
         metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('attestation', jsonb_build_object('status', 'revoked'))
   WHERE id = v_revoked_device_id;

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_unexpected_scan
    FROM api.record_scan_event_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'scan_type', 'load',
        'route_run_id', v_route.route_run_id,
        'branch_id', v_branch,
        'barcode', 'UNEXPECTED-' || left(v_route.route_run_id::text, 8),
        'idempotency_key', 'pgtap-scanner-platform-unexpected-route-load',
        'metadata', jsonb_build_object('source', 'console_v2_dispatch', 'classification', 'unexpected')
      )
    )
   LIMIT 1;

  RETURN NEXT ok(COALESCE(v_unexpected_scan.created, FALSE), 'platform can record an unexpected route-load scan without route_stop linkage');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT route_run_id::text FROM public.scan_events WHERE id = v_unexpected_scan.scan_event_id),
    v_route.route_run_id::text,
    'unexpected scan keeps route_run lineage'
  );
  SELECT device_id
    INTO v_reissued_device_id
    FROM public.scan_events
   WHERE id = v_unexpected_scan.scan_event_id;

  RETURN NEXT isnt(
    v_reissued_device_id::text,
    v_revoked_device_id::text,
    'managed Console V2 scanner reissues a new device after revocation'
  );
  RETURN NEXT ok(
    (SELECT revoked_at IS NOT NULL FROM public.user_devices WHERE id = v_revoked_device_id),
    'managed Console V2 scanner reissue leaves revoked device terminal'
  );
  RETURN NEXT ok(
    (
      SELECT revoked_at IS NULL
        AND COALESCE(NULLIF(metadata->>'console_scanner_generation', '')::integer, 0) > 1
      FROM public.user_devices
      WHERE id = v_reissued_device_id
    ),
    'managed Console V2 scanner reissue stores active generation lineage'
  );

  BEGIN
    PERFORM api.record_scan_event_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'device_id', v_revoked_device_id,
        'scan_type', 'load',
        'route_run_id', v_route.route_run_id,
        'branch_id', v_branch,
        'barcode', 'EXPLICIT-REVOKED-' || left(v_route.route_run_id::text, 8),
        'idempotency_key', 'pgtap-scanner-explicit-revoked-device',
        'metadata', jsonb_build_object('source', 'console_v2_dispatch', 'classification', 'explicit_revoked_device')
      )
    );
    RETURN NEXT fail('explicit revoked device_id remains blocked for Console scans');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('explicit revoked device_id remains blocked for Console scans');
  END;

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_platform_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    PERFORM api.record_scan_event_v1(
      jsonb_build_object(
        'scan_type', 'load',
        'route_run_id', v_route.route_run_id,
        'route_stop_id', v_stop_id,
        'branch_id', v_branch,
        'client_id', v_client,
        'shipment_id', v_shipment_id,
        'barcode', v_tracking,
        'idempotency_key', 'pgtap-scanner-platform-missing-active-tenant',
        'metadata', jsonb_build_object('source', 'console_v2_dispatch')
      )
    );
    RETURN NEXT fail('platform cross-tenant route-load scan without organization_id fails closed');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('platform cross-tenant route-load scan without organization_id fails closed');
  END;

  BEGIN
    PERFORM api.record_scan_event_v1(
      jsonb_build_object(
        'organization_id', v_other_org,
        'scan_type', 'load',
        'route_run_id', v_route.route_run_id,
        'route_stop_id', v_stop_id,
        'branch_id', v_branch,
        'client_id', v_client,
        'shipment_id', v_shipment_id,
        'barcode', v_tracking,
        'idempotency_key', 'pgtap-scanner-platform-mismatched-active-tenant',
        'metadata', jsonb_build_object('source', 'console_v2_dispatch')
      )
    );
    RETURN NEXT fail('platform route-load scan with mismatched organization_id fails closed');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('platform route-load scan with mismatched organization_id fails closed');
  END;

  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_tenant_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    PERFORM api.record_scan_event_v1(
      jsonb_build_object(
        'organization_id', v_other_org,
        'scan_type', 'load',
        'route_run_id', v_route.route_run_id,
        'route_stop_id', v_stop_id,
        'branch_id', v_branch,
        'client_id', v_client,
        'shipment_id', v_shipment_id,
        'barcode', v_tracking,
        'idempotency_key', 'pgtap-scanner-tenant-cross-org',
        'metadata', jsonb_build_object('source', 'console_v2_dispatch')
      )
    );
    RETURN NEXT fail('tenant caller cannot scan outside its organization_id');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('tenant caller cannot scan outside its organization_id');
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_scan_event_platform_active_tenant_scope_v1();

SELECT * FROM finish();

ROLLBACK;
