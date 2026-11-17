-- Plan: Batch 7 field execution platform hardening / Step: E07
-- pgTAP: access-restricted delivery attempts must be standardized on shipment_actions and visible on api.route_stops/timeline

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(20);

CREATE OR REPLACE FUNCTION pg_temp.test_b07_delivery_attempt_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_task_type_stop UUID := gen_random_uuid();

  v_shipment_attempt UUID := gen_random_uuid();
  v_shipment_untouched UUID := gen_random_uuid();
  v_route_stop_attempt UUID;
  v_route_stop_untouched UUID;
  v_route_run_id UUID;
  v_created RECORD;
  v_task_created RECORD;
  v_task_id UUID;
  v_next_task_version INTEGER := 1;
  v_action_id UUID;
  v_timeline JSONB := '{}'::jsonb;
  v_timeline_event JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'dispatch_exception_reason'
        AND lv.value = 'access_restricted'
        AND lv.status = 'active'
    ),
    'dispatch_exception_reason exposes access_restricted'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'attempt_reason'
        AND lv.value = 'partial_delivery'
        AND lv.status = 'active'
    ),
    'attempt_reason exposes partial_delivery'
  );

  RETURN NEXT has_function(
    'public',
    'validate_delivery_attempt_evidence_v1',
    ARRAY[]::TEXT[],
    'validate_delivery_attempt_evidence_v1 exists'
  );
  RETURN NEXT has_function(
    'public',
    'compute_delivery_attempt_projection_v1',
    ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'text', 'text', 'jsonb', 'timestamp with time zone'],
    'compute_delivery_attempt_projection_v1 exists'
  );
  RETURN NEXT col_type_is('public', 'shipment_actions', 'delivery_attempt_outcome', 'text', 'shipment_actions exposes delivery_attempt_outcome');
  RETURN NEXT col_type_is('public', 'shipment_actions', 'delivery_attempt_count', 'integer', 'shipment_actions exposes delivery_attempt_count');
  RETURN NEXT col_type_is('api', 'route_stops', 'route_stop_outcome', 'text', 'api.route_stops exposes route_stop_outcome');
  RETURN NEXT col_type_is('api', 'route_stops', 'delivery_attempt_reason', 'text', 'api.route_stops exposes delivery_attempt_reason');

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B07 Attempt Contract Org', 'b07-attempt-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'b07-' || left(v_branch::text, 8), 'B07 Attempt Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_driver, v_org, 'b07-driver-' || left(v_driver::text, 8) || '@example.com', 'B07 Driver', 'tenant');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B07 Attempt Client', 'b07-attempt-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'B07 Attempt Sender', 'B07 Attempt Sender', TRUE, 'active');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_task_type_stop, v_org, 'route_stop_execute', 'Route Stop Execute', TRUE, 50, 'default');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES
    (v_shipment_attempt, v_org, v_client, v_sender, 'delivery', 'B07ATTEMPT' || upper(left(v_shipment_attempt::text, 8)), 'out_for_delivery'),
    (v_shipment_untouched, v_org, v_client, v_sender, 'delivery', 'B07UNTOUCHED' || upper(left(v_shipment_untouched::text, 8)), 'out_for_delivery');

  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-b07-attempt-route-run',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment_attempt, 'stop_kind', 'delivery', 'sequence_order', 1),
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment_untouched, 'stop_kind', 'delivery', 'sequence_order', 2)
        )
      )
    )
   LIMIT 1;
  v_route_run_id := v_created.route_run_id;
  v_route_stop_attempt := (v_created.stop_ids)[1];
  v_route_stop_untouched := (v_created.stop_ids)[2];

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_attempt,
        'idempotency_key', 'pgtap-b07-attempt-task',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;
  v_task_id := v_task_created.task_id;
  SELECT COALESCE(MAX(te.task_version), 0) + 1
    INTO v_next_task_version
    FROM public.task_events te
   WHERE te.task_id = v_task_id;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT throws_ok(
    format(
      $sql$
        INSERT INTO public.task_events (
          task_id,
          organization_id,
          event_type,
          from_status,
          to_status,
          actor_system,
          payload,
          task_version
        ) VALUES (
          '%1$s'::uuid,
          '%2$s'::uuid,
          'status_changed',
          'assigned',
          'completed',
          'pgtap',
          jsonb_build_object('exception_reason', 'access_restricted'),
          %3$s
        )
      $sql$,
      v_task_id,
      v_org,
      v_next_task_version
    ),
    '23514',
    'access_restricted delivery attempts require notes, proof artifacts, or a geostamp',
    'access_restricted task_events fail closed without evidence'
  );

  INSERT INTO public.shipment_actions (
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_system,
    action_data,
    timestamp
  ) VALUES (
    v_shipment_attempt,
    v_org,
    v_client,
    'exception',
    'exception',
    'delivery_failed',
    'pgtap',
    jsonb_build_object(
      'route_run_id', v_route_run_id,
      'route_stop_id', v_route_stop_attempt,
      'outcome_reason', 'access_restricted',
      'artifact_ids', jsonb_build_array(gen_random_uuid()),
      'task_event_payload', jsonb_build_object(
        'exception_reason', 'access_restricted',
        'exception_notes', 'Security denied access at the gate',
        'exception_evidence', jsonb_build_object(
          'captured_at', '2026-04-10T10:15:00Z',
          'proof_artifact_count', 1,
          'geostamp', jsonb_build_object('latitude', 24.7136, 'longitude', 46.6753, 'accuracy_m', 8)
        )
      )
    ),
    '2026-04-10T10:15:00Z'::timestamptz
  )
  RETURNING id INTO v_action_id;

  RETURN NEXT is(
    (SELECT delivery_attempt_outcome FROM public.shipment_actions WHERE id = v_action_id),
    'not_delivered',
    'shipment_action projects standardized failed attempt outcome'
  );
  RETURN NEXT is(
    (SELECT delivery_attempt_reason FROM public.shipment_actions WHERE id = v_action_id),
    'access_restricted',
    'shipment_action projects standardized failed attempt reason'
  );
  RETURN NEXT is(
    (SELECT delivery_attempt_count::text FROM public.shipment_actions WHERE id = v_action_id),
    '1',
    'shipment_action projects attempt count'
  );
  RETURN NEXT is(
    (SELECT route_stop_outcome FROM public.shipment_actions WHERE id = v_action_id),
    'attempted',
    'shipment_action projects route_stop_outcome'
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'role', 'authenticated',
      'sub', v_driver::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(
    (SELECT shipment_action_id::text FROM api.route_stops WHERE id = v_route_stop_attempt),
    v_action_id::text,
    'api.route_stops links the latest shipment action for attempted stop'
  );
  RETURN NEXT is(
    (SELECT route_stop_outcome FROM api.route_stops WHERE id = v_route_stop_attempt),
    'attempted',
    'api.route_stops exposes attempted outcome for touched stop'
  );
  RETURN NEXT is(
    (SELECT route_stop_outcome FROM api.route_stops WHERE id = v_route_stop_untouched),
    'untouched',
    'api.route_stops exposes untouched outcome for stop without attempt'
  );
  RETURN NEXT is(
    (SELECT delivery_attempt_reason FROM api.route_stops WHERE id = v_route_stop_attempt),
    'access_restricted',
    'api.route_stops exposes standardized attempt reason'
  );

  v_timeline := public.ui_get_shipment_timeline_v1(v_shipment_attempt);
  SELECT value
    INTO v_timeline_event
    FROM jsonb_array_elements(COALESCE(v_timeline->'timeline_events', '[]'::jsonb)) AS item(value)
   WHERE item.value->>'event_source' = 'shipment_action'
     AND item.value->>'event_id' = v_action_id::text
   LIMIT 1;

  RETURN NEXT ok(v_timeline_event IS NOT NULL, 'shipment timeline includes the attempted shipment_action event');
  RETURN NEXT is(
    v_timeline_event #>> '{metadata,delivery_attempt_reason}',
    'access_restricted',
    'shipment timeline exposes standardized attempt reason'
  );
  RETURN NEXT is(
    v_timeline_event #>> '{metadata,route_stop_outcome}',
    'attempted',
    'shipment timeline exposes route_stop_outcome'
  );
END;
$function$;

SELECT * FROM pg_temp.test_b07_delivery_attempt_contract_v1();

SELECT * FROM finish();
ROLLBACK;
