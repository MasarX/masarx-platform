-- Plan: Batch 8 proof-of-delivery photo contract / Step: E02
-- pgTAP: delivered route-stop finalization must require at least one photo artifact when pod_policy says so

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

CREATE OR REPLACE FUNCTION pg_temp.test_b08_pod_photo_proof_contract_v1()
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

  v_photo_artifact_id UUID;
  v_signature_artifact_id UUID;

  v_created RECORD;
  v_task_created RECORD;

  v_shipment_fail UUID := gen_random_uuid();
  v_route_stop_fail UUID;
  v_task_fail UUID;
  v_task_done_event_fail UUID;
  v_domain_event_fail UUID;
  v_run_fail UUID;
  v_run_status_fail TEXT;
  v_step_error_fail TEXT;

  v_shipment_pass UUID := gen_random_uuid();
  v_route_stop_pass UUID;
  v_task_pass UUID;
  v_task_done_event_pass UUID;
  v_domain_event_pass UUID;
  v_run_pass UUID;
  v_run_status_pass TEXT;
  v_action_id_pass UUID;

  v_shipment_partial UUID := gen_random_uuid();
  v_route_stop_partial UUID;
  v_route_run_partial UUID;
  v_task_partial UUID;
  v_task_done_event_partial UUID;
  v_domain_event_partial UUID;
  v_workflow_run_partial UUID;
  v_run_status_partial TEXT;
  v_action_id_partial UUID;
  v_partial_box_ids UUID[];

  v_iter INT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.operation_handlers
      WHERE handler_key = 'route_stop_finalize'
        AND handler_schema = 'workflow_handlers'
        AND handler_name = 'execute_route_stop_finalize_' || handler_version
        AND substring(handler_version from '^v([0-9]+)$')::INT >= 9
        AND is_active IS TRUE
    ),
    'route_stop_finalize handler is active at v9 or newer'
  );

  RETURN NEXT is(
    (
      SELECT COALESCE((value->'requirements'->'completed'->>'photo_required')::boolean, FALSE)
      FROM public.resolve_pod_policy('{}'::jsonb)
      LIMIT 1
    ),
    TRUE,
    'global pod_policy still requires proof photos for completed deliveries'
  );

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B08 POD Photo Org', 'b08-pod-photo-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'br-' || left(v_branch::text, 8), 'B08 POD Photo Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_driver, v_org, 'driver-' || left(v_driver::text, 8) || '@example.com', 'B08 Driver', 'tenant');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B08 POD Client', 'b08-pod-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'B08 POD Sender', 'B08 POD Sender', TRUE, 'active');

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:b08-pod-photo-fixture-bootstrap');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_task_type_stop, v_org, 'route_stop_execute', 'Route Stop Execute', TRUE, 50, 'default');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment_fail, v_org, v_client, v_sender, 'delivery', 'B08PHOTOFAIL' || upper(left(v_shipment_fail::text, 8)), 'out_for_delivery');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment_pass, v_org, v_client, v_sender, 'delivery', 'B08PHOTOPASS' || upper(left(v_shipment_pass::text, 8)), 'out_for_delivery');

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    box_count
  )
  VALUES (
    v_shipment_partial,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'B08PHOTOPARTIAL' || upper(left(v_shipment_partial::text, 8)),
    'out_for_delivery',
    3
  );

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT artifact_id
    INTO v_signature_artifact_id
    FROM public.register_artifact_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'storage_bucket', 'fieldops-evidence',
        'storage_key', v_org::text || '/pgtap/signature.svg',
        'mime_type', 'image/svg+xml',
        'size_bytes', 512,
        'sha256', repeat('a', 64),
        'source_system', 'fieldops_mobile',
        'metadata', jsonb_build_object('artifact_kind', 'signature', 'source', 'pgtap')
      )
    )
   LIMIT 1;

  SELECT artifact_id
    INTO v_photo_artifact_id
    FROM public.register_artifact_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'storage_bucket', 'fieldops-evidence',
        'storage_key', v_org::text || '/pgtap/photo.jpg',
        'mime_type', 'image/jpeg',
        'size_bytes', 1024,
        'sha256', repeat('b', 64),
        'source_system', 'fieldops_mobile',
        'metadata', jsonb_build_object('artifact_kind', 'photo', 'source', 'pgtap')
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_signature_artifact_id IS NOT NULL AND v_photo_artifact_id IS NOT NULL, 'seed artifacts created for signature and photo proof');

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-b08-photo-fail-route-run',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment_fail, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;
  v_route_stop_fail := (v_created.stop_ids)[1];

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_fail,
        'idempotency_key', 'pgtap-b08-photo-fail-task',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;
  v_task_fail := v_task_created.task_id;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_fail
    FROM public.transition_task_v1(
      p_task_id := v_task_fail,
      p_to_status := 'completed',
      p_status_reason := 'delivered',
      p_payload := jsonb_build_object(
        'handover_mode', 'mailroom',
        'recipient_name', 'Faisal QA',
        'recipient_class', 'mailroom',
        'artifact_ids', jsonb_build_array(v_signature_artifact_id)
      ),
      p_idempotency_key := 'pgtap-b08-photo-fail-done'
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_fail, v_run_fail
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.route_stop_execute'
     AND (de.payload->>'task_event_id') = v_task_done_event_fail::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_run_fail
      FROM public.domain_events
     WHERE id = v_domain_event_fail;
    EXIT WHEN v_run_fail IS NOT NULL;
  END LOOP;

  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status_fail FROM public.workflow_runs WHERE id = v_run_fail;
    EXIT WHEN v_run_status_fail IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_run_fail);
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT COALESCE(last_error, '')
    INTO v_step_error_fail
    FROM public.workflow_run_steps
   WHERE workflow_run_id = v_run_fail
     AND sequence_order = 1
   LIMIT 1;

  RETURN NEXT is(v_run_status_fail, 'failed', 'signature-only evidence fails delivered photo-proof guard');
  RETURN NEXT ok(position('pod photo artifacts required' IN COALESCE(v_step_error_fail, '')) > 0, 'failure explains missing photo proof');
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment_fail),
    'out_for_delivery',
    'failed photo-proof guard leaves shipment status unchanged'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.shipment_actions WHERE shipment_id = v_shipment_fail),
    0,
    'failed photo-proof guard emits no shipment_action'
  );

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-b08-photo-pass-route-run',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment_pass, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;
  v_route_stop_pass := (v_created.stop_ids)[1];

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_pass,
        'idempotency_key', 'pgtap-b08-photo-pass-task',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;
  v_task_pass := v_task_created.task_id;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_pass
    FROM public.transition_task_v1(
      p_task_id := v_task_pass,
      p_to_status := 'completed',
      p_status_reason := 'delivered',
      p_payload := jsonb_build_object(
        'handover_mode', 'mailroom',
        'recipient_name', 'Faisal QA',
        'recipient_class', 'mailroom',
        'artifact_ids', jsonb_build_array(v_photo_artifact_id)
      ),
      p_idempotency_key := 'pgtap-b08-photo-pass-done'
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_pass, v_run_pass
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.route_stop_execute'
     AND (de.payload->>'task_event_id') = v_task_done_event_pass::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_run_pass
      FROM public.domain_events
     WHERE id = v_domain_event_pass;
    EXIT WHEN v_run_pass IS NOT NULL;
  END LOOP;

  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status_pass FROM public.workflow_runs WHERE id = v_run_pass;
    EXIT WHEN v_run_status_pass IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_run_pass);
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id
    INTO v_action_id_pass
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment_pass
     AND (sa.action_data->>'task_event_id') = v_task_done_event_pass::text
   ORDER BY sa.timestamp DESC
   LIMIT 1;

  RETURN NEXT is(v_run_status_pass, 'completed', 'photo-backed completion passes route-stop finalization');
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment_pass),
    'delivered',
    'photo-backed completion updates shipment status'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.artifact_links al
     WHERE al.organization_id = v_org
       AND al.artifact_id = v_photo_artifact_id
       AND al.resource_type = 'shipment_action'
       AND al.resource_id = v_action_id_pass
       AND al.relation_type = 'pod'),
    1,
    'photo artifact is linked as pod evidence for the successful completion'
  );

  PERFORM 1 FROM public.ensure_shipment_boxes(v_shipment_partial, 3);

  SELECT array_agg(sb.id ORDER BY sb.box_number)
    INTO v_partial_box_ids
    FROM public.shipment_boxes sb
   WHERE sb.shipment_id = v_shipment_partial;

  RETURN NEXT ok(
    COALESCE(array_length(v_partial_box_ids, 1), 0) = 3,
    'partial shipment boxes ensured'
  );

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-b08-photo-partial-route-run',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment_partial, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
  )
   LIMIT 1;
  v_route_stop_partial := (v_created.stop_ids)[1];
  v_route_run_partial := v_created.route_run_id;

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_partial,
        'idempotency_key', 'pgtap-b08-photo-partial-task',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;
  v_task_partial := v_task_created.task_id;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_partial
    FROM public.transition_task_v1(
      p_task_id := v_task_partial,
      p_to_status := 'completed',
      p_status_reason := 'partial_delivery',
      p_payload := jsonb_build_object(
        'handover_mode', 'locker',
        'recipient_name', 'B08 Parcel Locker',
        'recipient_class', 'locker',
        'completion_notes', 'Two of three boxes delivered, remainder left outstanding',
        'delivered_box_ids', jsonb_build_array(v_partial_box_ids[1], v_partial_box_ids[2]),
        'source', 'pgtap',
        'run', gen_random_uuid()::text
      ),
      p_idempotency_key := 'pgtap-b08-photo-partial-done'
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_partial, v_workflow_run_partial
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.route_stop_execute'
     AND (de.payload->>'task_event_id') = v_task_done_event_partial::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_workflow_run_partial
      FROM public.domain_events
     WHERE id = v_domain_event_partial;
    EXIT WHEN v_workflow_run_partial IS NOT NULL;
  END LOOP;

  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status_partial FROM public.workflow_runs WHERE id = v_workflow_run_partial;
    EXIT WHEN v_run_status_partial IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_workflow_run_partial);
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id
    INTO v_action_id_partial
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment_partial
     AND (sa.action_data->>'task_event_id') = v_task_done_event_partial::text
   ORDER BY sa.timestamp DESC
   LIMIT 1;

  RETURN NEXT is(v_run_status_partial, 'completed', 'partial-delivery workflow run completes');
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment_partial),
    'out_for_delivery',
    'partial delivery leaves shipment out_for_delivery'
  );
  RETURN NEXT ok(
    (SELECT delivered_at IS NULL FROM public.shipments WHERE id = v_shipment_partial),
    'partial delivery leaves shipments.delivered_at null'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.shipment_boxes WHERE shipment_id = v_shipment_partial AND status = 'delivered'),
    2,
    'partial delivery marks two boxes delivered'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.shipment_boxes WHERE shipment_id = v_shipment_partial AND status = 'pending'),
    1,
    'partial delivery leaves one box pending'
  );
  RETURN NEXT is(
    (SELECT sa.action_data->'delivery_completion'->>'completion_kind' FROM public.shipment_actions sa WHERE sa.id = v_action_id_partial),
    'partial',
    'shipment_action records partial delivery completion kind'
  );
  RETURN NEXT is(
    (SELECT sa.action_data->'delivery_completion'->>'delivered_box_count' FROM public.shipment_actions sa WHERE sa.id = v_action_id_partial),
    '2',
    'shipment_action records delivered box count'
  );
  RETURN NEXT is(
    (SELECT status FROM public.route_runs WHERE id = v_route_run_partial),
    'completed',
    'single-stop partial delivery closes the route run'
  );
  RETURN NEXT ok(
    (SELECT ended_at IS NOT NULL FROM public.route_runs WHERE id = v_route_run_partial),
    'route run ended_at recorded for partial delivery'
  );
  RETURN NEXT is(
    (SELECT route_runs.metadata->'route_closeout'->>'completed_stop_count' FROM public.route_runs WHERE id = v_route_run_partial),
    '1',
    'route closeout completed_stop_count recorded'
  );
  RETURN NEXT is(
    (SELECT route_runs.metadata->'route_closeout'->>'remaining_stop_count' FROM public.route_runs WHERE id = v_route_run_partial),
    '0',
    'route closeout remaining_stop_count recorded'
  );
END;
$function$;

SELECT * FROM pg_temp.test_b08_pod_photo_proof_contract_v1();

ROLLBACK;
