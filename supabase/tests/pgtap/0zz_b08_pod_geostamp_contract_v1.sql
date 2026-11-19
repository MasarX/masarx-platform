-- Plan: Batch 8 proof-of-delivery geostamp contract / Step: E04
-- pgTAP: delivery POD captured_at/geostamp must normalize at task_events and persist through delivery_completion/UI projections

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

CREATE OR REPLACE FUNCTION pg_temp.test_b08_pod_geostamp_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_created RECORD;
  v_route_stop_id UUID;
  v_route_run_id UUID;
  v_task_created RECORD;
  v_task_id UUID;
  v_task_done_event_id UUID;
  v_domain_event_id UUID;
  v_domain_event_run_id UUID;
  v_run_status TEXT;
  v_iter INT;
  v_step_error TEXT;
  v_photo_artifact_id UUID;
  v_pod_captured_at CONSTANT TIMESTAMPTZ := '2026-04-06T08:15:30Z'::timestamptz;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'normalize_delivery_pod_task_event_v1',
    ARRAY[]::TEXT[],
    'public.normalize_delivery_pod_task_event_v1() exists'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'task_events'
        AND t.tgname = 'trg_task_events_delivery_pod_normalize'
        AND NOT t.tgisinternal
    ),
    'task_events delivery POD normalization trigger exists'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.operation_handlers
      WHERE handler_key = 'route_stop_finalize'
        AND handler_schema = 'workflow_handlers'
        AND handler_name = format('execute_route_stop_finalize_%s', handler_version)
        AND handler_version ~ '^v[0-9]+$'
        AND regexp_replace(handler_version, '^v', '')::INT >= 9
        AND is_active IS TRUE
    ),
    'route_stop_finalize handler is v9 or newer'
  );

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B08 POD Geostamp Org', 'b08-pod-geo-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_driver,
    v_org,
    'b08-pod-geo-' || left(v_driver::text, 8) || '@example.com',
    'B08 POD Geostamp Driver',
    'driver',
    'tenant'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'b08-' || left(v_branch::text, 8), 'B08 POD Geostamp Branch', 'UTC', TRUE);

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B08 POD Geostamp Client', 'b08-pod-geostamp-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'B08 POD Sender', 'B08 POD Sender', TRUE, 'active');

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:b08-pod-geostamp-fixture-bootstrap');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', 'B08PODGEO' || upper(left(v_shipment::text, 8)), 'out_for_delivery');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT artifact_id
    INTO v_photo_artifact_id
    FROM public.register_artifact_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'storage_bucket', 'fieldops-evidence',
        'storage_key', v_org::text || '/pgtap/pod-geo-photo.jpg',
        'mime_type', 'image/jpeg',
        'size_bytes', 1024,
        'sha256', repeat('c', 64),
        'source_system', 'fieldops_mobile',
        'metadata', jsonb_build_object('artifact_kind', 'photo', 'source', 'pgtap')
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_photo_artifact_id IS NOT NULL, 'photo proof artifact seeded');

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-b08-pod-geo-route-run',
        'stops', jsonb_build_array(
          jsonb_build_object(
            'client_id', v_client,
            'shipment_id', v_shipment,
            'stop_kind', 'delivery',
            'sequence_order', 1
          )
        )
      )
    )
    LIMIT 1;

  v_route_run_id := v_created.route_run_id;
  v_route_stop_id := (v_created.stop_ids)[1];
  RETURN NEXT ok(v_route_stop_id IS NOT NULL AND v_route_run_id IS NOT NULL, 'create_route_run_v1 returns delivery stop and route run');

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'pgtap-b08-pod-geo-task',
        'actor_system', 'dispatch_engine'
      )
    )
    LIMIT 1;

  v_task_id := v_task_created.task_id;
  RETURN NEXT ok(v_task_id IS NOT NULL, 'create_task_system_v1 creates route_stop task');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'delivered',
      p_payload := jsonb_build_object(
        'handover_mode', 'mailroom',
        'recipient_name', 'Faisal QA',
        'artifact_ids', jsonb_build_array(v_photo_artifact_id),
        'pod', jsonb_build_object(
          'captured_at', v_pod_captured_at,
          'geostamp', jsonb_build_object(
            'latitude', 24.7113,
            'longitude', 46.6745,
            'accuracy_m', 12
          ),
          'artifact_ids', jsonb_build_array(v_photo_artifact_id)
        )
      ),
      p_idempotency_key := 'pgtap-b08-pod-geo-done'
    )
    LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'completed delivery task_event created');
  RETURN NEXT is(
    (SELECT ((payload #>> '{pod,captured_at}')::timestamptz)::text FROM public.task_events WHERE id = v_task_done_event_id),
    v_pod_captured_at::text,
    'task_events payload normalizes pod.captured_at'
  );
  RETURN NEXT is(
    (SELECT payload #>> '{pod,geostamp,latitude}' FROM public.task_events WHERE id = v_task_done_event_id),
    '24.7113',
    'task_events payload normalizes pod geostamp latitude'
  );
  RETURN NEXT is(
    (SELECT payload #>> '{geostamp,longitude}' FROM public.task_events WHERE id = v_task_done_event_id),
    '46.6745',
    'task_events payload mirrors top-level geostamp longitude'
  );

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_id, v_domain_event_run_id
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.route_stop_execute'
     AND (de.payload->>'task_event_id') = v_task_done_event_id::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_domain_event_run_id
      FROM public.domain_events
     WHERE id = v_domain_event_id;
    EXIT WHEN v_domain_event_run_id IS NOT NULL;
  END LOOP;

  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status FROM public.workflow_runs WHERE id = v_domain_event_run_id;
    EXIT WHEN v_run_status IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_domain_event_run_id);
  END LOOP;

  IF v_run_status IS DISTINCT FROM 'completed' THEN
    SELECT COALESCE(last_error, '')::text
      INTO v_step_error
      FROM public.workflow_run_steps
     WHERE workflow_run_id = v_domain_event_run_id
       AND sequence_order = 1
     LIMIT 1;
    RETURN NEXT diag('route_stop_finalize last_error=' || COALESCE(NULLIF(v_step_error, ''), '<empty>'));
  END IF;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(v_run_status, 'completed', 'route_stop finalize workflow completes with POD geostamp payload');
  RETURN NEXT is(
    (
      SELECT (pod_captured_at::timestamptz)::text
      FROM public.shipment_actions
      WHERE shipment_id = v_shipment
      ORDER BY created_at DESC
      LIMIT 1
    ),
    v_pod_captured_at::text,
    'shipment_actions stores generated pod_captured_at'
  );
  RETURN NEXT is(
    (SELECT pod_geostamp_latitude::text FROM public.shipment_actions WHERE shipment_id = v_shipment ORDER BY created_at DESC LIMIT 1),
    '24.7113',
    'shipment_actions stores generated pod_geostamp_latitude'
  );
  RETURN NEXT is(
    (
      SELECT ((action_data #>> '{delivery_completion,captured_at}')::timestamptz)::text
      FROM public.shipment_actions
      WHERE shipment_id = v_shipment
      ORDER BY created_at DESC
      LIMIT 1
    ),
    v_pod_captured_at::text,
    'shipment_actions delivery_completion stores captured_at'
  );
  RETURN NEXT is(
    (SELECT metadata #>> '{delivery_completion,geostamp,accuracy_m}' FROM public.route_stops WHERE id = v_route_stop_id),
    '12',
    'route_stops metadata delivery_completion stores geostamp accuracy'
  );
  RETURN NEXT is(
    (SELECT metadata #>> '{delivery_completion,geostamp,latitude}' FROM public.shipments WHERE id = v_shipment),
    '24.7113',
    'shipments metadata delivery_completion stores geostamp latitude'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_b08_pod_geostamp_contract_v1();

SELECT * FROM finish();

ROLLBACK;
