BEGIN;
SET search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(34);

CREATE FUNCTION pg_temp.test_driver_route_load_manifest_v1()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  v_org UUID := gen_random_uuid(); v_branch UUID := gen_random_uuid(); v_client UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid(); v_other UUID := gen_random_uuid(); v_route UUID;
  v_other_org UUID := gen_random_uuid(); v_outside UUID := gen_random_uuid(); v_policy_before JSONB;
  v_shipments UUID[]; v_boxes UUID[]; v_stops UUID[]; v_input JSONB; v_result JSONB; v_before JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  INSERT INTO public.organizations (id, name, slug) VALUES (v_org, 'SG52 Route Loading', 'sg52-' || v_org);
  INSERT INTO public.organizations (id, name, slug) VALUES (v_other_org, 'SG52 Outside', 'sg52-' || v_other_org);
  INSERT INTO public.branches (id, organization_id, code, name, timezone)
    VALUES (v_branch, v_org, 'sg52', 'Route Loading', 'Asia/Riyadh');
  INSERT INTO public.clients (id, organization_id, name, slug, status)
    VALUES (v_client, v_org, 'SG52', 'sg52-' || v_client, 'active');
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type) VALUES
    (v_driver, v_org, 'sg52-' || v_driver || '@example.com', 'Driver', 'driver', 'active', 'tenant'),
    (v_other, v_org, 'sg52-' || v_other || '@example.com', 'Other driver', 'driver', 'active', 'tenant'),
    (v_outside, v_other_org, 'sg52-' || v_outside || '@example.com', 'Outside driver', 'driver', 'active', 'tenant');
  INSERT INTO public.shipments (organization_id, client_id, tracking_number, service_type, status)
    SELECT v_org, v_client, 'SG52' || upper(left(v_org::text, 8)) || n, 'delivery', 'pending' FROM generate_series(1, 3) n;
  SELECT array_agg(id ORDER BY tracking_number) INTO v_shipments FROM public.shipments WHERE organization_id = v_org;
  INSERT INTO public.shipment_boxes (organization_id, client_id, shipment_id, box_number, barcode, weight_kg, cold_chain)
    SELECT v_org, v_client, id, 1, tracking_number || ':1', 1.2, CASE WHEN id = v_shipments[1] THEN TRUE ELSE NULL END
    FROM public.shipments WHERE organization_id = v_org;
  SELECT array_agg(sb.id ORDER BY s.tracking_number) INTO v_boxes
    FROM public.shipment_boxes sb JOIN public.shipments s ON s.id = sb.shipment_id AND s.client_id = sb.client_id WHERE sb.organization_id = v_org;
  SELECT route_run_id INTO v_route FROM public.create_route_run_v1(jsonb_build_object(
    'organization_id', v_org, 'branch_id', v_branch, 'driver_user_id', v_driver,
    'stops', (SELECT jsonb_agg(jsonb_build_object('shipment_id', id, 'client_id', v_client, 'stop_kind', 'delivery', 'sequence_order', n))
      FROM unnest(v_shipments) WITH ORDINALITY t(id, n))
  ));
  UPDATE public.route_runs SET driver_user_id = v_driver WHERE id = v_route;
  SELECT array_agg(id ORDER BY sequence_order) INTO v_stops FROM public.route_stops WHERE route_run_id = v_route;
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_route_run_execution_manifest_v1(v_route);
  v_before := v_result->'scan_out';
  RETURN NEXT is(jsonb_array_length(v_result#>'{load_manifest,parcels}'), 3, 'canonical route readback contains three real parcels');
  RETURN NEXT ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result#>'{load_manifest,parcels}') p WHERE p->>'status' <> 'pending'), 'unscanned parcels default to pending, not driver-declared missing');
  RETURN NEXT is(v_result#>>'{scan_out,missing_stop_count}', '3', 'legacy unscanned stop aggregate is preserved');
  RETURN NEXT is((SELECT p->'cold_chain' FROM jsonb_array_elements(v_result#>'{load_manifest,parcels}') p WHERE p->>'shipment_box_id' = v_boxes[2]::text), 'null'::jsonb, 'unrecorded cold-chain stays unknown');
  RETURN NEXT ok((v_result#>>'{load_manifest,can_record_actions}')::boolean, 'assigned driver can request route loading actions');
  v_input := jsonb_build_object('route_run_id', v_route, 'organization_id', v_org, 'actor_user_id', v_driver,
    'route_stop_id', v_stops[1], 'shipment_box_id', v_boxes[1], 'action', 'mark_missing', 'idempotency_key', 'missing-1', 'note', 'Not in vehicle');
  v_result := api.ui_record_route_load_action_v1(v_input);
  RETURN NEXT is((SELECT p->>'status' FROM jsonb_array_elements(v_result#>'{load_manifest,parcels}') p WHERE p->>'shipment_box_id' = v_boxes[1]::text), 'missing', 'server readback confirms declared missing');
  RETURN NEXT is((SELECT p->>'reason' FROM jsonb_array_elements(v_result#>'{load_manifest,parcels}') p WHERE p->>'shipment_box_id' = v_boxes[1]::text), 'Not in vehicle', 'server readback preserves optional reason');
  RETURN NEXT is(api.ui_route_run_execution_manifest_v1(v_route)->'scan_out', v_before, 'declaring missing does not relax legacy departure/scan-out contract');
  RETURN NEXT is(api.ui_route_run_execution_manifest_v1(v_route)->>'manifest_hash',
    (SELECT route_execution_manifest->>'manifest_hash' FROM api.route_runs WHERE id = v_route), 'legacy manifest hash stays equal across existing route read surfaces');
  RETURN NEXT is(api.ui_record_route_load_action_v1(v_input)->>'event_id', v_result->>'event_id', 'same offline intent replays idempotently');
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || '{"note":"different"}'::jsonb), '23514', 'route_load_idempotency_conflict', 'changed payload cannot reuse an intent key');
  v_result := api.ui_record_route_load_action_v1(v_input || '{"action":"undo_missing","idempotency_key":"undo-1","note":null}'::jsonb);
  RETURN NEXT is((SELECT p->>'status' FROM jsonb_array_elements(v_result#>'{load_manifest,parcels}') p WHERE p->>'shipment_box_id' = v_boxes[1]::text), 'pending', 'undo restores pending, not scanned');
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || '{"action":"report_discrepancy","route_stop_id":null,"shipment_box_id":null,"note":null,"idempotency_key":"bad-report"}'::jsonb), '22023', 'route_load_discrepancy_note_required', 'discrepancy requires a note');
  v_result := api.ui_record_route_load_action_v1(v_input || '{"action":"report_discrepancy","route_stop_id":null,"shipment_box_id":null,"note":"Wrong cage","idempotency_key":"report-1"}'::jsonb);
  RETURN NEXT is(v_result#>>'{load_manifest,last_discrepancy}', 'Wrong cage', 'discrepancy is recorded by the server');
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || jsonb_build_object('route_stop_id', gen_random_uuid(), 'idempotency_key', 'outside')), '42501', 'route_load_parcel_outside_route', 'foreign or nonexistent stop cannot target a parcel');
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || jsonb_build_object('actor_user_id', v_other)), '42501', 'route_load_actor_mismatch', 'old offline actor identity cannot execute as the new actor');
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || jsonb_build_object('organization_id', gen_random_uuid())), '42501', 'route_load_scope_denied', 'client-supplied foreign organization is rejected');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT count(*)::int FROM public.route_load_manifest_actions WHERE route_run_id = v_route), 3, 'only mark, undo and report were written; replay did not append');
  RETURN NEXT ok(EXISTS (SELECT 1 FROM public.audit_table_changes WHERE table_name = 'route_load_manifest_actions' AND organization_id = v_org AND op = 'INSERT'), 'canonical audit trigger records loading actions');
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT ok(NOT has_table_privilege('service_role', 'public.route_load_manifest_actions', 'UPDATE,DELETE,TRUNCATE'), 'service role cannot rewrite or erase the action ledger despite default grants');
  RETURN NEXT throws_ok('UPDATE public.route_load_manifest_actions SET note = note WHERE FALSE', '42501', 'permission denied for table route_load_manifest_actions', 'service role update is actually denied');
  RETURN NEXT throws_ok('DELETE FROM public.route_load_manifest_actions WHERE FALSE', '42501', 'permission denied for table route_load_manifest_actions', 'service role delete is actually denied');
  RETURN NEXT throws_ok('TRUNCATE public.route_load_manifest_actions', '42501', 'permission denied for table route_load_manifest_actions', 'service role truncate is actually denied');
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.scan_events (organization_id, route_run_id, route_stop_id, shipment_id, client_id, scan_type, barcode, captured_at)
    SELECT v_org, v_route, v_stops[2], sb.shipment_id, v_client, 'load', sb.barcode, now() FROM public.shipment_boxes sb WHERE id = v_boxes[2];
  INSERT INTO public.scan_events (organization_id, route_run_id, scan_type, barcode, captured_at)
    VALUES (v_org, v_route, 'load', 'SG52EXTRA:1', now());
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.ui_route_run_execution_manifest_v1(v_route);
  RETURN NEXT is((SELECT p->>'status' FROM jsonb_array_elements(v_result#>'{load_manifest,parcels}') p WHERE p->>'shipment_box_id' = v_boxes[2]::text), 'scanned', 'exact parcel load scan confirms scanned state');
  RETURN NEXT ok(EXISTS (SELECT 1 FROM jsonb_array_elements(v_result#>'{load_manifest,parcels}') p WHERE p->>'status' = 'extra' AND p->>'barcode' = 'SG52EXTRA:1'), 'unexpected route barcode is rendered as extra without foreign parcel data');
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || jsonb_build_object('route_stop_id', v_stops[2], 'shipment_box_id', v_boxes[2], 'idempotency_key', 'scanned-missing')), '23514', 'route_load_parcel_already_scanned', 'scanned parcel cannot be marked missing');
  RETURN NEXT ok(NOT has_table_privilege('authenticated', 'public.route_load_manifest_actions', 'INSERT,UPDATE,DELETE'), 'authenticated users cannot write around the guarded RPC');
  RETURN NEXT ok(NOT has_function_privilege('anon', 'api.ui_record_route_load_action_v1(jsonb)', 'EXECUTE'), 'anonymous action calls are denied');
  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || jsonb_build_object('actor_user_id', v_other)), '42501', format('route_run %s is not visible to the current actor', v_route), 'another driver cannot change the route');
  PERFORM set_config('request.jwt.claim.sub', v_outside::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_outside, 'role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(format('SELECT api.ui_route_run_execution_manifest_v1(%L::uuid)', v_route), '42501', format('route_run %s is outside the current organization', v_route), 'foreign organization cannot read parcel data');
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || jsonb_build_object('actor_user_id', v_outside, 'organization_id', v_other_org)), '42501', format('route_run %s is outside the current organization', v_route), 'foreign organization cannot append loading actions');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SELECT policy INTO v_policy_before FROM public.resolve_access_control_policy_v1('tenant', v_org, FALSE) LIMIT 1;
  PERFORM 1 FROM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org,
    v_policy_before || jsonb_build_object('denies', jsonb_build_array(jsonb_build_object('capability_key', 'tasks.complete', 'scope_type', 'tenant', 'scope_id', v_org))), 1, 'SG52 deny test');
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'access_control_policy:%';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(NOT (api.ui_route_run_execution_manifest_v1(v_route)#>>'{load_manifest,can_record_actions}')::boolean, 'readback disables actions after capability revocation');
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || '{"idempotency_key":"denied-new"}'::jsonb), '42501', 'Capability denied: tasks.complete', 'queued intent is reauthorized against current capability policy');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM 1 FROM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org, v_policy_before, 1, 'SG52 restore fixture policy');
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'access_control_policy:%';
  UPDATE public.route_runs SET status = 'completed' WHERE id = v_route;
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.ui_record_route_load_action_v1(%L::jsonb)', v_input || '{"idempotency_key":"terminal-new"}'::jsonb), '23514', 'route_load_terminal', 'terminal route cannot receive new loading mutations');
END;
$test$;
SELECT * FROM pg_temp.test_driver_route_load_manifest_v1();
SELECT * FROM finish();
ROLLBACK;
