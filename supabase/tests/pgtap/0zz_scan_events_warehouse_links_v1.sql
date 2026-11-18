-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Scan events warehouse links v1 (handling_units + warehouse_transfers)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(57);

CREATE OR REPLACE FUNCTION pg_temp.test_scan_events_warehouse_links_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch_from UUID := gen_random_uuid();
  v_branch_to UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();

  v_user UUID := gen_random_uuid();
  v_device RECORD;

  v_shipment UUID := gen_random_uuid();
  v_tracking TEXT := ('pgtap-wh-' || left(v_shipment::text, 8));

  v_handling_unit UUID := gen_random_uuid();
  v_hu_code TEXT := ('HU-' || left(v_handling_unit::text, 8));
  v_transfer_handling_unit UUID := gen_random_uuid();
  v_transfer_hu_code TEXT := ('HU-TR-' || left(v_transfer_handling_unit::text, 8));
  v_bulk_handling_unit UUID := gen_random_uuid();
  v_bulk_hu_code TEXT := ('HU-BULK-' || left(v_bulk_handling_unit::text, 8));

  v_transfer UUID := gen_random_uuid();
  v_transfer_code TEXT := ('TR-' || left(v_transfer::text, 8));
  v_bulk_transfer UUID := gen_random_uuid();
  v_bulk_transfer_code TEXT := ('TR-BULK-' || left(v_bulk_transfer::text, 8));

  v_ops_session RECORD;

  v_scan RECORD;
  v_scan2 RECORD;
  v_scan3 RECORD;
  v_scan_next RECORD;
  v_scan_arrival RECORD;
  v_scan_policy RECORD;
  v_scan_policy_value JSONB := NULL;
  v_policy_ctx JSONB := '{}'::jsonb;
  v_approval_task RECORD;
  v_correction RECORD;
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_catalog JSONB := NULL;
  v_bulk_max_items INT := NULL;
  v_wrong_approval_task RECORD;

  v_other_org UUID := gen_random_uuid();
  v_other_branch UUID := gen_random_uuid();
  v_other_branch2 UUID := gen_random_uuid();
  v_other_handling_unit UUID := gen_random_uuid();
  v_other_transfer UUID := gen_random_uuid();
BEGIN
  RETURN NEXT has_table('public', 'scan_events', 'scan_events table exists');
  RETURN NEXT has_column('public', 'scan_events', 'handling_unit_id', 'scan_events.handling_unit_id exists');
  RETURN NEXT has_column('public', 'scan_events', 'warehouse_transfer_id', 'scan_events.warehouse_transfer_id exists');
  RETURN NEXT has_column('public', 'scan_events', 'ops_session_id', 'scan_events.ops_session_id exists');
  RETURN NEXT has_column('public', 'scan_events', 'checkpoint_key', 'scan_events.checkpoint_key exists');
  RETURN NEXT has_column('public', 'scan_events', 'checkpoint_sequence', 'scan_events.checkpoint_sequence exists');
  RETURN NEXT has_column('public', 'scan_events', 'correction_of_scan_event_id', 'scan_events.correction_of_scan_event_id exists');
  RETURN NEXT has_column('public', 'scan_events', 'correction_reason', 'scan_events.correction_reason exists');
  RETURN NEXT has_column('public', 'scan_events', 'correction_approval_task_id', 'scan_events.correction_approval_task_id exists');
  RETURN NEXT has_function('public', 'record_scan_event_v1', ARRAY['jsonb'], 'record_scan_event_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'record_scan_events_batch_v1', ARRAY['jsonb'], 'record_scan_events_batch_v1(jsonb) exists');

  SELECT cached_value
    INTO v_catalog
    FROM public.settings
   WHERE category = 'scan_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
   LIMIT 1;
  RETURN NEXT ok(v_catalog IS NOT NULL, 'scan_policy global settings present');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(v_catalog->'accepted_scan_types', '[]'::jsonb)) AS scan_type(value)
      WHERE scan_type.value = 'warehouse_checkpoint'
    ),
    'scan_policy accepted_scan_types includes warehouse_checkpoint'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(v_catalog->'accepted_scan_types', '[]'::jsonb)) AS scan_type(value)
      WHERE scan_type.value = 'correction'
    ),
    'scan_policy accepted_scan_types includes correction'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(v_catalog->'warehouse_checkpoint'->'sequence', '[]'::jsonb)) AS seq(value)
      WHERE seq.value = 'inbound'
    ),
    'scan_policy warehouse checkpoint sequence includes inbound'
  );
  RETURN NEXT ok(
    COALESCE((v_catalog->'correction'->>'require_supervisor_approval')::boolean, FALSE) IS TRUE,
    'scan_policy correction requires supervisor approval'
  );
  BEGIN v_bulk_max_items := NULLIF(v_catalog->'bulk'->>'max_items', '')::int; EXCEPTION WHEN others THEN v_bulk_max_items := NULL; END;
  IF v_bulk_max_items IS NULL OR v_bulk_max_items < 1 THEN
    RAISE EXCEPTION 'scan_policy bulk.max_items missing for scan_events_warehouse_links_v1 pgTAP';
  END IF;

  SELECT cached_value
    INTO v_catalog
    FROM public.settings
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
   LIMIT 1;
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_catalog->'task_types', '[]'::jsonb)) AS tt(value)
      WHERE tt.value->>'key' = 'warehouse_scan_supervisor_approval'
    ),
    'task_type_catalog includes warehouse_scan_supervisor_approval'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'WH Scan Org', 'wh-scan-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_branch_from, v_org, 'wh-from-' || left(v_branch_from::text, 8), 'WH From', 'UTC', TRUE),
    (v_branch_to, v_org, 'wh-to-' || left(v_branch_to::text, 8), 'WH To', 'UTC', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'WH Client', 'wh-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'WH Sender', 'WH Sender', TRUE, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'wh-u-' || left(v_user::text, 8) || '@example.com', 'WH User', 'tenant');

  -- RBAC: device/telemetry/session RPCs are permission-gated; grant warehouse_operator to the actor.
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['warehouse_operator'], v_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'warehouse_operator'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.handling_units (id, organization_id, branch_id, unit_type, status, code)
  VALUES
    (v_handling_unit, v_org, v_branch_from, 'bag', 'open', v_hu_code),
    (v_transfer_handling_unit, v_org, v_branch_from, 'bag', 'open', v_transfer_hu_code),
    (v_bulk_handling_unit, v_org, v_branch_from, 'bag', 'open', v_bulk_hu_code);

  INSERT INTO public.warehouse_transfers (id, organization_id, from_branch_id, to_branch_id, status, transfer_code, vehicle_id)
  VALUES
    (v_transfer, v_org, v_branch_from, v_branch_to, 'draft', v_transfer_code, v_vehicle),
    (v_bulk_transfer, v_org, v_branch_from, v_branch_to, 'draft', v_bulk_transfer_code, v_vehicle);

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', v_tracking, 'created');

  -- Secondary org with foreign ids to validate org-safety errors.
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_other_org, 'Other Org', 'other-' || left(v_other_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_other_branch, v_other_org, 'other-br-' || left(v_other_branch::text, 8), 'Other Branch', 'UTC', TRUE);

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_other_branch2, v_other_org, 'other-br2-' || left(v_other_branch2::text, 8), 'Other Branch 2', 'UTC', TRUE);

  INSERT INTO public.handling_units (id, organization_id, branch_id, unit_type, status, code)
  VALUES (v_other_handling_unit, v_other_org, v_other_branch, 'bag', 'open', 'OTHER-HU');

  INSERT INTO public.warehouse_transfers (id, organization_id, from_branch_id, to_branch_id, status, transfer_code)
  VALUES (v_other_transfer, v_other_org, v_other_branch, v_other_branch2, 'draft', 'OTHER-TR');

  -- Simulate tenant authenticated context for device + scan ingest RPCs.
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT * INTO v_device
  FROM public.register_user_device_v1(
    jsonb_build_object(
      'device_platform', 'android',
      'device_identifier_sha256', 'pgtap-wh-device-1'
    )
  )
  LIMIT 1;

  SELECT * INTO v_ops_session
  FROM public.open_ops_session_v1(
    jsonb_build_object(
      'session_type', 'warehouse_scan',
      'branch_id', v_branch_from,
      'device_id', v_device.device_id,
      'idempotency_key', 'pgtap-wh-session-1',
      'opened_at', now()
    )
  )
  LIMIT 1;

  RETURN NEXT ok(v_ops_session.created IS TRUE, 'open_ops_session_v1 created=true');

  -- Warehouse transfer checkpoint scan with explicit handling unit + transfer context follows
  -- the transfer-specific linehaul sequence: load -> unload.
  SELECT * INTO v_scan
  FROM public.record_scan_event_v1(
    jsonb_build_object(
      'idempotency_key', 'pgtap-wh-scan-1',
      'device_id', v_device.device_id,
       'scan_type', 'warehouse_checkpoint',
       'barcode', (v_tracking || ':1'),
       'handling_unit_code', v_transfer_hu_code,
       'warehouse_transfer_code', v_transfer_code,
       'checkpoint_key', 'load',
       'captured_at', now()
     )
   )
   LIMIT 1;

  RETURN NEXT ok(v_scan.created IS TRUE, 'record_scan_event_v1 created=true');

  -- Session-linked scan (no other context): should persist ops_session_id and default branch_id from session.
  SELECT * INTO v_scan3
  FROM public.record_scan_event_v1(
    jsonb_build_object(
      'idempotency_key', 'pgtap-wh-scan-session-1',
      'device_id', v_device.device_id,
      'scan_type', 'sort',
      'barcode', 'SESSIONONLY-1',
      'ops_session_id', v_ops_session.ops_session_id,
      'captured_at', now()
    )
  )
  LIMIT 1;

  RETURN NEXT ok(v_scan3.created IS TRUE, 'record_scan_event_v1 session-linked created=true');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT se.handling_unit_id::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan.scan_event_id LIMIT 1),
    v_transfer_handling_unit::text,
    'scan_events.handling_unit_id persisted from handling_unit_code'
  );
  RETURN NEXT is(
    (SELECT se.warehouse_transfer_id::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan.scan_event_id LIMIT 1),
    v_transfer::text,
    'scan_events.warehouse_transfer_id persisted from warehouse_transfer_code'
  );
  RETURN NEXT is(
    (SELECT se.scan_type::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan.scan_event_id LIMIT 1),
    'warehouse_checkpoint',
    'scan_events.scan_type persisted as warehouse_checkpoint'
  );
  RETURN NEXT is(
    (SELECT se.checkpoint_key::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan.scan_event_id LIMIT 1),
    'load',
    'scan_events.checkpoint_key persisted from metadata'
  );
  RETURN NEXT is(
    (SELECT se.ops_session_id::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan3.scan_event_id LIMIT 1),
    v_ops_session.ops_session_id::text,
    'scan_events.ops_session_id persisted from ops_session_id'
  );
  RETURN NEXT is(
    (SELECT se.branch_id::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan3.scan_event_id LIMIT 1),
    v_branch_from::text,
    'scan_events.branch_id defaults from ops session when missing'
  );

  -- Barcode-only warehouse checkpoint scan: if the scanned barcode matches a handling unit code, it should auto-link.
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT * INTO v_scan2
  FROM public.record_scan_event_v1(
    jsonb_build_object(
       'idempotency_key', 'pgtap-wh-scan-hu-1',
       'device_id', v_device.device_id,
       'scan_type', 'warehouse_checkpoint',
       'barcode', v_hu_code,
       'checkpoint_key', 'inbound',
       'captured_at', now()
     )
   )
   LIMIT 1;

  RETURN NEXT ok(v_scan2.created IS TRUE, 'record_scan_event_v1 barcode-only created=true');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT se.handling_unit_id::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan2.scan_event_id LIMIT 1),
    v_handling_unit::text,
    'barcode-only scan auto-links to handling unit when barcode matches code'
  );
  RETURN NEXT is(
    (SELECT se.scan_type::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan2.scan_event_id LIMIT 1),
    'warehouse_checkpoint',
    'barcode-only warehouse checkpoint scan_type persisted'
  );

  RETURN NEXT is(
    (SELECT se.checkpoint_sequence::int FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan.scan_event_id LIMIT 1),
    1,
    'warehouse transfer checkpoint load starts transfer-specific sequence at 1'
  );
  RETURN NEXT is(
    (SELECT se.warehouse_transfer_id::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan.scan_event_id LIMIT 1),
    v_transfer::text,
    'warehouse checkpoint load persists warehouse_transfer_id'
  );
  RETURN NEXT is(
    (SELECT se.metadata->>'checkpoint_scope' FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan.scan_event_id LIMIT 1),
    'handling_unit',
    'warehouse checkpoint load scope stays handling_unit when a handling unit is present'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT * INTO v_scan_arrival
  FROM public.record_scan_event_v1(
    jsonb_build_object(
      'idempotency_key', 'pgtap-wh-scan-arrival-1',
      'device_id', v_device.device_id,
      'scan_type', 'warehouse_checkpoint',
      'barcode', v_transfer_code,
      'warehouse_transfer_id', v_transfer,
      'checkpoint_key', 'unload',
      'captured_at', now()
    )
  )
  LIMIT 1;

  RETURN NEXT ok(v_scan_arrival.created IS TRUE, 'record_scan_event_v1 unload created=true');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT se.warehouse_transfer_id::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan_arrival.scan_event_id LIMIT 1),
    v_transfer::text,
    'warehouse checkpoint unload persists warehouse_transfer_id'
  );
  RETURN NEXT is(
    (SELECT se.checkpoint_sequence::int FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan_arrival.scan_event_id LIMIT 1),
    2,
    'warehouse transfer checkpoint unload increments transfer-specific sequence to 2'
  );
  RETURN NEXT is(
    (SELECT se.metadata->>'checkpoint_scope' FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_scan_arrival.scan_event_id LIMIT 1),
    'warehouse_transfer',
    'warehouse checkpoint unload scope is warehouse_transfer'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object('idempotency_key','pgtap-wh-scan-first-step-invalid-1','device_id','%s','scan_type','warehouse_checkpoint','barcode','FIRST-STEP-INVALID','checkpoint_key','sort')) $$,
      v_device.device_id::text
    ),
    '23514',
    'record_scan_event_v1 invalid warehouse checkpoint transition: expected inbound first'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object('idempotency_key','pgtap-wh-scan-backward-1','device_id','%s','scan_type','warehouse_checkpoint','barcode','%s','handling_unit_code','%s','warehouse_transfer_code','%s','checkpoint_key','inbound')) $$,
      v_device.device_id::text,
      v_transfer_hu_code,
      v_transfer_hu_code,
      v_transfer_code
    ),
    '23514',
    'record_scan_event_v1 invalid checkpoint_key for warehouse_checkpoint sequence: inbound'
  );

  SELECT * INTO v_approval_task
  FROM public.create_task_system_v1(
    jsonb_build_object(
      'task_type_key', 'warehouse_scan_supervisor_approval',
      'context', jsonb_build_object('organization_id', v_org),
      'resource_type', 'scan_event',
      'resource_id', v_scan.scan_event_id,
      'idempotency_key', 'pgtap-wh-scan-approval-1'
    )
  )
  LIMIT 1;

  RETURN NEXT ok(v_approval_task.task_id IS NOT NULL, 'warehouse_scan_supervisor_approval task created');

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object(
           'idempotency_key','pgtap-wh-scan-correction-missing-approval-1',
           'device_id','%s',
           'scan_type','correction',
           'barcode','pgtap-wh-scan-corrected-missing-approval',
           'correction_of_scan_event_id','%s',
           'correction_reason','approval omitted',
           'captured_at', now()
         )) $$,
      v_device.device_id::text,
      v_scan.scan_event_id::text
    ),
    '23514',
    'record_scan_event_v1 requires correction_approval_task_id for correction scans'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object(
           'idempotency_key','pgtap-wh-scan-correction-pending-approval-1',
           'device_id','%s',
           'scan_type','correction',
           'barcode','pgtap-wh-scan-corrected-pending-approval',
           'correction_of_scan_event_id','%s',
           'correction_reason','approval pending',
           'correction_approval_task_id','%s',
           'captured_at', now()
         )) $$,
      v_device.device_id::text,
      v_scan.scan_event_id::text,
      v_approval_task.task_id::text
    ),
    '23514',
    'record_scan_event_v1 correction approval task must be completed'
  );

  SELECT * INTO v_wrong_approval_task
  FROM public.create_task_system_v1(
    jsonb_build_object(
      'task_type_key', 'warehouse_supervisor_approval',
      'context', jsonb_build_object('organization_id', v_org),
      'resource_type', 'scan_event',
      'resource_id', v_scan.scan_event_id,
      'idempotency_key', 'pgtap-wh-scan-approval-wrong-type-1'
    )
  )
  LIMIT 1;

  PERFORM public.transition_task_v1(
    v_wrong_approval_task.task_id,
    'completed',
    NULL,
    '{}'::jsonb,
    'pgtap-wh-scan-approval-wrong-type-complete-1'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object(
           'idempotency_key','pgtap-wh-scan-correction-wrong-type-1',
           'device_id','%s',
           'scan_type','correction',
           'barcode','pgtap-wh-scan-corrected-wrong-type',
           'correction_of_scan_event_id','%s',
           'correction_reason','wrong approval type',
           'correction_approval_task_id','%s',
           'captured_at', now()
         )) $$,
      v_device.device_id::text,
      v_scan.scan_event_id::text,
      v_wrong_approval_task.task_id::text
    ),
    '23514',
    'record_scan_event_v1 correction approval task type mismatch'
  );

  SELECT * INTO v_wrong_approval_task
  FROM public.create_task_system_v1(
    jsonb_build_object(
      'task_type_key', 'warehouse_scan_supervisor_approval',
      'context', jsonb_build_object('organization_id', v_org),
      'resource_type', 'warehouse_transfer',
      'resource_id', v_transfer,
      'idempotency_key', 'pgtap-wh-scan-approval-wrong-resource-type-1'
    )
  )
  LIMIT 1;

  PERFORM public.transition_task_v1(
    v_wrong_approval_task.task_id,
    'completed',
    NULL,
    '{}'::jsonb,
    'pgtap-wh-scan-approval-wrong-resource-type-complete-1'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object(
           'idempotency_key','pgtap-wh-scan-correction-wrong-resource-type-1',
           'device_id','%s',
           'scan_type','correction',
           'barcode','pgtap-wh-scan-corrected-wrong-resource-type',
           'correction_of_scan_event_id','%s',
           'correction_reason','wrong approval resource type',
           'correction_approval_task_id','%s',
           'captured_at', now()
         )) $$,
      v_device.device_id::text,
      v_scan.scan_event_id::text,
      v_wrong_approval_task.task_id::text
    ),
    '23514',
    'record_scan_event_v1 correction approval task must target scan_event'
  );

  SELECT * INTO v_wrong_approval_task
  FROM public.create_task_system_v1(
    jsonb_build_object(
      'task_type_key', 'warehouse_scan_supervisor_approval',
      'context', jsonb_build_object('organization_id', v_org),
      'resource_type', 'scan_event',
      'resource_id', v_scan_arrival.scan_event_id,
      'idempotency_key', 'pgtap-wh-scan-approval-wrong-target-1'
    )
  )
  LIMIT 1;

  RETURN NEXT ok(v_wrong_approval_task.task_id IS NOT NULL, 'wrong-target warehouse_scan_supervisor_approval task created');

  PERFORM public.transition_task_v1(
    v_wrong_approval_task.task_id,
    'completed',
    NULL,
    '{}'::jsonb,
    'pgtap-wh-scan-approval-wrong-target-complete-1'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object(
           'idempotency_key','pgtap-wh-scan-correction-wrong-target-1',
           'device_id','%s',
           'scan_type','correction',
           'barcode','pgtap-wh-scan-corrected-wrong-target',
           'correction_of_scan_event_id','%s',
           'correction_reason','wrong approval target',
           'correction_approval_task_id','%s',
           'captured_at', now()
         )) $$,
      v_device.device_id::text,
      v_scan.scan_event_id::text,
      v_wrong_approval_task.task_id::text
    ),
    '23514',
    'record_scan_event_v1 correction approval task must target the original scan event'
  );

  PERFORM public.transition_task_v1(
    v_approval_task.task_id,
    'completed',
    NULL,
    '{}'::jsonb,
    'pgtap-wh-scan-approval-complete-1'
  );

  SELECT * INTO v_correction
  FROM public.record_scan_event_v1(
    jsonb_build_object(
      'idempotency_key', 'pgtap-wh-scan-correction-1',
      'device_id', v_device.device_id,
      'scan_type', 'correction',
      'barcode', 'pgtap-wh-scan-corrected',
      'correction_of_scan_event_id', v_scan.scan_event_id,
      'correction_reason', 'wrong checkpoint recorded',
      'correction_approval_task_id', v_approval_task.task_id,
      'captured_at', now()
    )
  )
  LIMIT 1;

  RETURN NEXT ok(v_correction.created IS TRUE, 'record_scan_event_v1 correction created=true');

  RETURN NEXT is(
    (SELECT se.correction_of_scan_event_id::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_correction.scan_event_id LIMIT 1),
    v_scan.scan_event_id::text,
    'correction references the original scan event'
  );
  RETURN NEXT is(
    (SELECT se.correction_reason::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_correction.scan_event_id LIMIT 1),
    'wrong checkpoint recorded',
    'correction_reason persisted on append-only correction row'
  );
  RETURN NEXT is(
    (SELECT se.correction_approval_task_id::text FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = v_correction.scan_event_id LIMIT 1),
    v_approval_task.task_id::text,
    'correction approval task id persisted'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object(
           'idempotency_key','pgtap-wh-scan-correction-of-correction-1',
           'device_id','%s',
           'scan_type','correction',
           'barcode','pgtap-wh-scan-corrected-nested',
           'correction_of_scan_event_id','%s',
           'correction_reason','nested correction should fail',
           'captured_at', now()
         )) $$,
      v_device.device_id::text,
      v_correction.scan_event_id::text
    ),
    '23514',
    'record_scan_event_v1 cannot correct a correction scan'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.record_scan_events_batch_v1(
      jsonb_build_object(
        'bulk_manifest_barcode', 'MANIFEST-BULK-1',
        'scans', jsonb_build_array(
          jsonb_build_object(
             'idempotency_key', 'pgtap-wh-bulk-1',
             'device_id', v_device.device_id,
             'scan_type', 'warehouse_checkpoint',
             'barcode', v_bulk_hu_code,
             'handling_unit_code', v_bulk_hu_code,
             'warehouse_transfer_code', v_bulk_transfer_code,
             'checkpoint_key', 'load',
             'captured_at', now()
           ),
           jsonb_build_object(
             'idempotency_key', 'pgtap-wh-bulk-2',
             'device_id', v_device.device_id,
             'scan_type', 'warehouse_checkpoint',
             'barcode', v_bulk_hu_code,
             'handling_unit_code', v_bulk_hu_code,
             'warehouse_transfer_code', v_bulk_transfer_code,
             'checkpoint_key', 'unload',
             'captured_at', now()
           )
        )
      )
    )),
    2,
    'record_scan_events_batch_v1 inserted two scans'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT se.metadata->>'bulk_manifest_barcode' FROM public.scan_events se WHERE se.organization_id = v_org AND se.id = (
      SELECT se2.id
        FROM public.scan_events se2
       WHERE se2.organization_id = v_org
         AND se2.idempotency_key = 'pgtap-wh-bulk-1'
       LIMIT 1
    ) LIMIT 1),
    'MANIFEST-BULK-1',
    'bulk manifest barcode persisted in metadata'
  );

  v_policy_ctx := jsonb_build_object(
    'organization_id', v_org,
    'user_id', v_user,
    'event_type', 'scan_event'
  );

  SELECT *
    INTO v_scan_policy
    FROM public.resolve_scan_policy(v_policy_ctx)
   LIMIT 1;

  IF v_scan_policy.settings_id IS NULL
     OR v_scan_policy.settings_version_id IS NULL
     OR v_scan_policy.value IS NULL THEN
    RAISE EXCEPTION 'scan_events_warehouse_links_v1 pgTAP could not resolve scan_policy row for org context';
  END IF;

  v_scan_policy_value := v_scan_policy.value;

  UPDATE public.settings_versions
     SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{bulk,enabled}', 'false'::jsonb, TRUE),
         updated_at = now()
   WHERE id = v_scan_policy.settings_version_id;

  UPDATE public.settings
     SET cached_value = jsonb_set(COALESCE(cached_value, '{}'::jsonb), '{bulk,enabled}', 'false'::jsonb, TRUE),
         last_updated = now()
   WHERE id = v_scan_policy.settings_id;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_events_batch_v1(
           jsonb_build_object(
             'bulk_manifest_barcode', 'MANIFEST-BULK-DISABLED-1',
             'scans', jsonb_build_array(
               jsonb_build_object(
                 'idempotency_key', 'pgtap-wh-bulk-disabled-1',
                 'device_id', '%s',
                 'scan_type', 'sort',
                 'barcode', 'BULK-DISABLED-1'
               )
             )
           )
         ) $$,
      v_device.device_id::text
    ),
    '42501',
    'record_scan_events_batch_v1 blocked by scan_policy.bulk.enabled=false'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  UPDATE public.settings_versions
     SET value = v_scan_policy_value,
         updated_at = now()
   WHERE id = v_scan_policy.settings_version_id;

  UPDATE public.settings
     SET cached_value = v_scan_policy_value,
         last_updated = now()
   WHERE id = v_scan_policy.settings_id;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_events_batch_v1(
           jsonb_build_object(
             'bulk_manifest_barcode', 'MANIFEST-BULK-LIMIT-1',
             'scans',
             (
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'idempotency_key', 'pgtap-wh-bulk-limit-' || seq.n::text,
                   'device_id', '%s',
                   'scan_type', 'sort',
                   'barcode', 'BULK-LIMIT-' || seq.n::text
                 )
               )
               FROM generate_series(1, %s) AS seq(n)
             )
           )
         ) $$,
      v_device.device_id::text,
      (v_bulk_max_items + 1)::text
    ),
    '23514',
    'record_scan_events_batch_v1 exceeds scan_policy.bulk.max_items'
  );

  -- Org safety: cannot link to foreign-org IDs.
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object('idempotency_key','pgtap-wh-foreign-hu','device_id','%s','scan_type','sort','barcode','x','handling_unit_id','%s')) $$,
      v_device.device_id::text,
      v_other_handling_unit::text
    ),
    '23503',
    'record_scan_event_v1: handling_unit_id not found for org'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object('idempotency_key','pgtap-wh-missing-hu','device_id','%s','scan_type','sort','barcode','x','handling_unit_code','MISSING-HU')) $$,
      v_device.device_id::text
    ),
    '23503',
    'record_scan_event_v1: handling_unit_code not found for org'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object('idempotency_key','pgtap-wh-foreign-tr','device_id','%s','scan_type','sort','barcode','x','warehouse_transfer_id','%s')) $$,
      v_device.device_id::text,
      v_other_transfer::text
    ),
    '23503',
    'record_scan_event_v1: warehouse_transfer_id not found for org'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_scan_events_warehouse_links_v1();

SELECT * FROM finish();

ROLLBACK;
