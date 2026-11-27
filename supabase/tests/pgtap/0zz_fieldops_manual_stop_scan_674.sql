-- Exercise the browser-facing RPCs with the real database roles and a synthetic route.
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(39);

SELECT ok(
  NOT has_function_privilege('anon', 'api.record_scan_event_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.resolve_fieldops_stop_detail_v1(uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.record_scan_event_v1(jsonb)', 'EXECUTE'),
  'anonymous callers cannot access the stop parcel RPCs');

SELECT ok(
  has_function_privilege('authenticated', 'api.record_scan_event_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'api.resolve_fieldops_stop_detail_v1(uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.enforce_scan_input_mode_policy_v1()', 'EXECUTE'),
  'authenticated callers have RPC access and cannot call the ledger trigger');

SELECT ok(
  has_function_privilege('service_role', 'api.record_scan_event_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'api.resolve_fieldops_stop_detail_v1(uuid,text,jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.enforce_scan_input_mode_policy_v1()', 'EXECUTE'),
  'service role retains the scan and readback function grants');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.scan_events'::regclass)
  AND NOT has_table_privilege('anon', 'public.scan_events', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'public.scan_events', 'INSERT,UPDATE,DELETE'),
  'scan ledger RLS and direct write restrictions remain in effect');

CREATE FUNCTION pg_temp.test_fieldops_manual_stop_scan_674()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  org_id uuid := gen_random_uuid();
  foreign_org uuid := gen_random_uuid();
  driver_id uuid := gen_random_uuid();
  other_driver uuid := gen_random_uuid();
  foreign_driver uuid := gen_random_uuid();
  operator_id uuid := gen_random_uuid();
  client_id uuid := gen_random_uuid();
  fixture_branch uuid := gen_random_uuid();
  shipment_id uuid := gen_random_uuid();
  run_id uuid := gen_random_uuid();
  other_run uuid := gen_random_uuid();
  stop_id uuid := gen_random_uuid();
  other_stop uuid := gen_random_uuid();
  boxless_shipment uuid := gen_random_uuid();
  boxless_stop uuid := gen_random_uuid();
  tracking text := 'PGTS' || upper(left(shipment_id::text, 8));
  barcode text := tracking || ':1';
  boxless_tracking text := 'PGTS' || upper(left(boxless_shipment::text, 8));
  fixture_capture_time timestamptz := now();
  expired_reason text := 'pgt_expired_' || left(org_id::text, 8);
  reason_codes jsonb := jsonb_build_array('scanner_unavailable', expired_reason);
  payload jsonb;
  policy jsonb;
  scan record;
  replay record;
  stop_detail jsonb;
  entry record;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (org_id, 'Stop Scan Fixture', 'pgt-stop-scan-' || left(org_id::text, 8)),
         (foreign_org, 'Other Tenant Fixture', 'pgt-stop-scan-' || left(foreign_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  SELECT actor.id, actor.org_id, 'pgt-stop-scan-' || actor.id::text || '@example.com', 'Scan Fixture',
    actor.user_type, 'active', 'tenant'
  FROM (VALUES (driver_id, org_id, 'driver'), (other_driver, org_id, 'driver'),
               (foreign_driver, foreign_org, 'driver'), (operator_id, org_id, 'ops_admin')
  ) AS actor(id, org_id, user_type);

  PERFORM public.provision_rbac_roles_from_templates_v1(org_id, ARRAY['driver', 'ops_admin'], driver_id);
  PERFORM public.provision_rbac_roles_from_templates_v1(foreign_org, ARRAY['driver'], foreign_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT r.organization_id, actor.id, r.id, actor.id, '{"source":"pgtap"}'::jsonb
  FROM (VALUES (driver_id, org_id, 'driver'), (other_driver, org_id, 'driver'),
               (foreign_driver, foreign_org, 'driver'), (operator_id, org_id, 'ops_admin')
  ) AS actor(id, org_id, role_key)
  JOIN public.rbac_roles r ON r.organization_id = actor.org_id AND r.key = actor.role_key
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (client_id, org_id, 'Scan Fixture Client', 'pgt-stop-scan-' || left(client_id::text, 8), 'active');
  INSERT INTO public.branches (id, organization_id, name, code, timezone)
  VALUES (fixture_branch, org_id, 'Scan Fixture Branch', 'pgt-' || left(fixture_branch::text, 8), 'UTC');
  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status, box_count)
  VALUES (shipment_id, org_id, client_id, tracking, 'delivery', 'out_for_delivery', 2),
         (boxless_shipment, org_id, client_id, boxless_tracking, 'delivery', 'out_for_delivery', 1);
  PERFORM public.ensure_shipment_boxes(shipment_id, 2);

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, planned_start_at)
  VALUES (run_id, org_id, fixture_branch, driver_id, 'in_progress', fixture_capture_time::date, fixture_capture_time),
         (other_run, org_id, fixture_branch, driver_id, 'planned', fixture_capture_time::date + 1,
          fixture_capture_time + interval '1 day');
  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
  VALUES (stop_id, org_id, run_id, client_id, shipment_id, 'delivery', 1),
         (other_stop, org_id, other_run, client_id, shipment_id, 'delivery', 1),
         (boxless_stop, org_id, run_id, client_id, boxless_shipment, 'delivery', 2);

  INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, effective_from, effective_until)
  VALUES ((SELECT id FROM public.lookup_definitions WHERE category = 'stop_scan_manual_entry_reason'),
    expired_reason, 'Expired fixture reason', 'active',
    fixture_capture_time - interval '2 days', fixture_capture_time - interval '1 day');

  -- Client onboarding seeds a policy that takes precedence over the tenant default.
  SELECT s.cached_value INTO STRICT policy
  FROM public.settings s
  WHERE s.category = 'scan_policy' AND s.scope_type = 'client' AND s.scope_id = client_id;
  policy := policy || jsonb_build_object(
    'version', 3,
    'accepted_scan_types', (policy->'accepted_scan_types') || '["stop_parcel"]'::jsonb,
    'manual_entry', jsonb_build_object('enabled', FALSE, 'reason_codes', reason_codes));
  PERFORM 1 FROM public.upsert_settings_value_v1('scan_policy', 'client', client_id, policy, 3, 'pgTAP stop scan disabled');

  PERFORM set_config('request.jwt.claim.sub', driver_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', driver_id, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  payload := jsonb_build_object(
    'idempotency_key', gen_random_uuid(), 'scan_type', 'stop_parcel', 'barcode', barcode,
    'route_stop_id', stop_id, 'captured_at', fixture_capture_time, 'device_id', (
      SELECT d.device_id FROM api.register_user_device_v1(jsonb_build_object(
        'device_platform', 'android', 'device_identifier_sha256', encode(digest(driver_id::text, 'sha256'), 'hex')
      )) d),
    'metadata', jsonb_build_object('scan_input_mode', 'manual_entry', 'scan_reason_code', 'scanner_unavailable',
                                   'scan_reason_note', 'Handheld jammed'));
  RETURN NEXT is(api.resolve_fieldops_stop_detail_v1(stop_id)#>>'{parcels,0,status}', 'pending',
    'assigned driver reads the parcel as pending before a stop scan');

  RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)', payload), '42501',
    'Manual entry is unavailable for this scan under the resolved scan policy', 'disabled policy rejects manual entry');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM 1 FROM public.upsert_settings_value_v1('scan_policy', 'client', client_id,
    jsonb_set(policy, '{manual_entry,enabled}', 'true'::jsonb), 3, 'pgTAP stop scan enabled');
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT p.value#>'{manual_entry,reason_codes}'
    FROM api.resolve_scan_policy(jsonb_build_object(
      'organization_id', org_id, 'user_id', driver_id, 'resource_id', fixture_branch,
      'client_id', client_id, 'event_type', 'scan_event')) p),
    reason_codes, 'assigned driver reads scope-specific reason choices from the policy');

  FOR entry IN SELECT * FROM (VALUES
    ('missing reason', payload #- '{metadata,scan_reason_code}',
      'Select an active manual-entry reason for the stop parcel scan'),
    ('unknown reason', jsonb_set(payload, '{metadata,scan_reason_code}', '"unknown_code"'),
      'Select an active manual-entry reason for the stop parcel scan'),
    ('reason outside the resolved policy', jsonb_set(payload, '{metadata,scan_reason_code}', '"barcode_unreadable"'),
      'Select an active manual-entry reason for the stop parcel scan'),
    ('expired reason listed in policy', jsonb_set(payload, '{metadata,scan_reason_code}', to_jsonb(expired_reason)),
      'Select an active manual-entry reason for the stop parcel scan'),
    ('non-string reason', jsonb_set(payload, '{metadata,scan_reason_code}', '42'),
      'Select an active manual-entry reason for the stop parcel scan'),
    ('non-text note', jsonb_set(payload, '{metadata,scan_reason_note}', '{}'),
      'Manual-entry note must be text when provided'),
    ('unmatched barcode', jsonb_set(payload, '{barcode}', to_jsonb(tracking || ':999')),
      'Barcode does not match a parcel at this stop')
  ) AS cases(label, input, message)
  LOOP
    RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)', entry.input),
      '23514', entry.message, entry.label || ' is rejected');
  END LOOP;

  RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)',
    jsonb_set(payload, '{branch_id}', to_jsonb(gen_random_uuid()))), '42501',
    'Stop parcel scan requires a matching route stop and branch', 'caller cannot select a different branch policy');

  RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)',
    jsonb_set(payload, '{scan_type}', '"pickup"')), '42501',
    'Manual entry is unavailable for this scan under the resolved scan policy', 'manual entry is restricted to the stop parcel type');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    NOT EXISTS (SELECT 1 FROM public.scan_event_dedupe d
      WHERE d.organization_id = org_id AND d.idempotency_key = payload->>'idempotency_key')
    AND NOT EXISTS (SELECT 1 FROM public.scan_events se WHERE se.organization_id = org_id),
    'denied writes leave both the scan ledger and its dedupe ledger empty');
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT * INTO STRICT scan FROM api.record_scan_event_v1(payload);
  RETURN NEXT ok(scan.created AND scan.scan_event_id IS NOT NULL, 'assigned driver records the manual-entry parcel scan');
  SELECT * INTO STRICT replay FROM api.record_scan_event_v1(payload);
  RETURN NEXT ok(replay.created IS FALSE AND replay.scan_event_id = scan.scan_event_id,
    'same manual-entry payload replays the saved event');

  RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)',
    jsonb_set(payload, '{metadata,scan_reason_code}', '"barcode_unreadable"')), '42501',
    'Stop parcel scan retry does not match the recorded scan', 'replay key cannot replace the saved reason');

  stop_detail := api.resolve_fieldops_stop_detail_v1(stop_id);
  RETURN NEXT is(
    (SELECT p->>'status' FROM jsonb_array_elements(stop_detail->'parcels') p WHERE p->>'code' = barcode),
    'scanned', 'stop readback confirms the exact parcel after the write');
  RETURN NEXT is(
    (SELECT p->>'status' FROM jsonb_array_elements(stop_detail->'parcels') p WHERE p->>'code' = tracking || ':2'),
    'pending', 'sibling parcel does not inherit confirmation');
  RETURN NEXT is(
    (SELECT p->>'status' FROM jsonb_array_elements(stop_detail->'proofChecklist') p WHERE p->>'key' = 'scan'),
    'pending', 'scan confirmation does not submit proof of delivery');
  RETURN NEXT is(api.resolve_fieldops_stop_detail_v1(other_stop)#>>'{parcels,0,status}', 'pending',
    'a different stop for the same shipment does not inherit confirmation');

  FOR entry IN SELECT * FROM (VALUES ('camera'), ('scanner')) AS modes(name)
  LOOP
    RETURN NEXT ok((SELECT s.created FROM api.record_scan_event_v1(
      payload || jsonb_build_object('idempotency_key', gen_random_uuid(), 'scan_type', 'pickup',
        'metadata', jsonb_build_object('scan_input_mode', entry.name))) s),
      entry.name || ' retains existing scan policy behavior');
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok((SELECT se.metadata @> jsonb_build_object(
      'scan_input_mode', 'manual_entry', 'scan_reason_code', 'scanner_unavailable', 'scan_reason_note', 'Handheld jammed')
    AND se.metadata ? 'scan_reason_lookup_value_id'
    AND se.metadata ? 'scan_policy_settings_version_id'
    AND se.actor_user_id = driver_id AND se.captured_at = fixture_capture_time
    AND se.route_stop_id = stop_id AND se.branch_id = fixture_branch
    FROM public.scan_events se
    WHERE se.organization_id = org_id AND se.id = scan.scan_event_id),
    'ledger stores the reason, optional note, policy version, actor, capture time and stop branch');
  RETURN NEXT is((SELECT count(*) FROM public.scan_events se
    WHERE se.organization_id = org_id AND se.scan_type = 'stop_parcel'), 1::bigint,
    'only one stop parcel event is persisted after replay');
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT ok((SELECT s.created FROM api.record_scan_event_v1(
    (payload #- '{metadata,scan_reason_note}') || jsonb_build_object(
      'idempotency_key', gen_random_uuid(), 'route_stop_id', boxless_stop, 'barcode', boxless_tracking)) s),
    'assigned driver can scan a shipment-level parcel without entering a note');
  RETURN NEXT is(api.resolve_fieldops_stop_detail_v1(boxless_stop)#>>'{parcels,0,status}', 'scanned',
    'stop readback confirms the shipment-level parcel');

  PERFORM set_config('request.jwt.claim.sub', other_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', other_driver, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)', payload), '42501',
    'Stop parcel scan retry does not match the recorded scan', 'same-tenant unassigned driver cannot replay a saved scan');
  RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)', payload ||
    jsonb_build_object('idempotency_key', gen_random_uuid(), 'device_id', (
      SELECT d.device_id FROM api.register_user_device_v1(jsonb_build_object(
        'device_platform', 'android', 'device_identifier_sha256', encode(digest(other_driver::text, 'sha256'), 'hex')
      )) d))), '42501', 'Stop parcel scan requires access to the assigned stop',
    'same-tenant unassigned driver cannot write a new stop parcel scan');
  RETURN NEXT is(api.resolve_fieldops_stop_detail_v1(stop_id, 'supervisor')#>>'{parcels,0,status}', 'pending',
    'an unassigned driver cannot use the requested role to read ledger confirmation');

  PERFORM set_config('request.jwt.claim.sub', operator_id::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', operator_id, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)', payload ||
    jsonb_build_object('idempotency_key', gen_random_uuid(), 'device_id', (
      SELECT d.device_id FROM api.register_user_device_v1(jsonb_build_object(
        'device_platform', 'android', 'device_identifier_sha256', encode(digest(operator_id::text, 'sha256'), 'hex')
      )) d))), '42501', 'Stop parcel scan requires access to the assigned stop',
    'tenant route operator cannot record a manual-entry scan for the assigned driver');
  RETURN NEXT is(api.resolve_fieldops_stop_detail_v1(stop_id, 'dispatcher')#>>'{parcels,0,status}', 'scanned',
    'tenant route operator can read confirmation in authorized route scope');

  PERFORM set_config('request.jwt.claim.sub', foreign_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', foreign_driver, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(format('SELECT api.resolve_fieldops_stop_detail_v1(%L)', stop_id), '42501', NULL,
    'cross-tenant driver cannot read the stop parcel state');
  RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)', payload), '23514', NULL,
    'cross-tenant driver cannot write a stop parcel scan');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok(format('SELECT * FROM api.record_scan_event_v1(%L)', payload), '42501', NULL,
    'service role without an actor cannot write through the mobile scan RPC');
  RETURN NEXT throws_ok(format('SELECT api.resolve_fieldops_stop_detail_v1(%L)', stop_id), '42501', NULL,
    'service role without an actor cannot read through the mobile stop RPC');

  EXECUTE 'SET LOCAL ROLE postgres';
END;
$test$;

SELECT * FROM pg_temp.test_fieldops_manual_stop_scan_674();
SELECT * FROM finish();
ROLLBACK;
