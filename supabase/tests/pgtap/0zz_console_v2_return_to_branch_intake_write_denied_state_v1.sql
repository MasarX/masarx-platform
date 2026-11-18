-- pgTAP: Console V2 returned-to-branch intake scan denies lower-permission
-- users before scanner-device, scan, inventory, or shipment-action side effects.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(19);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_return_to_branch_intake_write_denied_state_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_limited UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_tracking TEXT := 'RTB-DENIED-' || upper(left(gen_random_uuid()::text, 8));
  v_scan RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'record_scan_event_v1',
    ARRAY['jsonb'],
    'public.record_scan_event_v1 exists'
  );
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
  VALUES (v_org, 'Return Intake Denied Org', 'return-intake-denied-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, branch_type, is_active)
  VALUES (v_branch, v_org, 'rid-' || lower(left(v_org::text, 6)), 'Return Intake Denied Branch', 'Asia/Riyadh', 'warehouse', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (
      v_ops,
      v_org,
      'return-intake-denied-ops-' || left(v_ops::text, 8) || '@example.com',
      'Return Intake Denied Ops',
      'ops_admin',
      'active',
      'tenant',
      NULL
    ),
    (
      v_limited,
      v_org,
      'return-intake-denied-limited-' || left(v_limited::text, 8) || '@example.com',
      'Return Intake Denied Limited',
      'client_admin',
      'active',
      'tenant',
      NULL
    );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_ops);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_ops, r.id, v_ops, jsonb_build_object('source', 'pgtap', 'template_key', r.key)
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Return Intake Denied Client', 'return-intake-denied-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Return Intake Denied Sender', 'Return Intake Denied Sender', TRUE, 'active');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', v_tracking, 'pending');

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_limited::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  RETURN NEXT ok(
    NOT public.user_has_permission_v1('tasks.complete', v_org),
    'limited return-intake user lacks tasks.complete permission'
  );
  RETURN NEXT ok(
    NOT public.user_has_capability_v1('warehouse.scan', 'tenant', v_org),
    'limited return-intake user lacks warehouse.scan capability'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT * FROM public.record_scan_event_v1(jsonb_build_object('organization_id', %L::uuid, 'scan_type', 'return_to_branch_intake', 'branch_id', %L::uuid, 'client_id', %L::uuid, 'shipment_id', %L::uuid, 'barcode', %L, 'idempotency_key', 'pgtap-return-intake-denied-public', 'metadata', jsonb_build_object('source', 'console_v2.returned_to_branch.intake_scan'))) $q$,
      v_org::text,
      v_branch::text,
      v_client::text,
      v_shipment::text,
      v_tracking
    ),
    '42501',
    NULL,
    'limited user denied public returned-to-branch intake scan'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT * FROM api.record_scan_event_v1(jsonb_build_object('organization_id', %L::uuid, 'scan_type', 'return_to_branch_intake', 'branch_id', %L::uuid, 'client_id', %L::uuid, 'shipment_id', %L::uuid, 'barcode', %L, 'idempotency_key', 'pgtap-return-intake-denied-api', 'metadata', jsonb_build_object('source', 'console_v2.returned_to_branch.intake_scan'))) $q$,
      v_org::text,
      v_branch::text,
      v_client::text,
      v_shipment::text,
      v_tracking
    ),
    '42501',
    NULL,
    'limited user denied api returned-to-branch intake scan'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.scan_events WHERE organization_id = v_org),
    0,
    'denied return intake writes no scan_events'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.user_devices WHERE organization_id = v_org AND user_id = v_limited),
    0,
    'denied api return intake creates no managed scanner device'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.inventory_movements WHERE organization_id = v_org),
    0,
    'denied return intake writes no inventory_movements'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.shipment_actions WHERE organization_id = v_org),
    0,
    'denied return intake writes no shipment_actions'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.decision_log WHERE organization_id = v_org),
    0,
    'denied return intake writes no decision_log rows'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ops::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  RETURN NEXT ok(
    public.user_has_permission_v1('tasks.complete', v_org),
    'ops return-intake user has tasks.complete permission'
  );
  RETURN NEXT ok(
    public.user_has_capability_v1('warehouse.scan', 'tenant', v_org),
    'ops return-intake user has warehouse.scan capability'
  );

  SELECT *
    INTO v_scan
    FROM api.record_scan_event_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'scan_type', 'return_to_branch_intake',
        'branch_id', v_branch,
        'client_id', v_client,
        'shipment_id', v_shipment,
        'barcode', v_tracking,
        'idempotency_key', 'pgtap-return-intake-ops-api',
        'metadata', jsonb_build_object(
          'source', 'console_v2.returned_to_branch.intake_scan',
          'tracking_number', v_tracking
        )
      )
    )
   LIMIT 1;

  RETURN NEXT ok(COALESCE(v_scan.created, FALSE), 'ops user records returned-to-branch intake through api wrapper');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.user_devices WHERE organization_id = v_org AND user_id = v_ops),
    1,
    'allowed api return intake creates one managed scanner device'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.inventory_movements WHERE organization_id = v_org AND related_scan_event_id = v_scan.scan_event_id),
    1,
    'allowed return intake writes inventory movement for scan'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.shipment_actions WHERE organization_id = v_org AND shipment_id = v_shipment AND action_data->>'source_scan_event_id' = v_scan.scan_event_id::text),
    1,
    'allowed return intake writes shipment action for scan'
  );
  RETURN NEXT is(
    (SELECT metadata#>>'{return_to_branch,scan_event_id}' FROM public.shipments WHERE id = v_shipment),
    v_scan.scan_event_id::text,
    'allowed return intake projects scan lineage onto shipment metadata'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_return_to_branch_intake_write_denied_state_v1();

SELECT * FROM finish();

ROLLBACK;
