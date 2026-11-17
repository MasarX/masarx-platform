-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- pgTAP: Route plan lifecycle foundation v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(30);

CREATE OR REPLACE FUNCTION pg_temp.test_route_plan_lifecycle_foundation_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();

  v_shipment1 UUID := gen_random_uuid();
  v_shipment2 UUID := gen_random_uuid();
  v_shipment3 UUID := gen_random_uuid();

  v_template_id UUID;
  v_plan1 RECORD;
  v_plan1_retry RECORD;
  v_frozen1 RECORD;
  v_applied1 RECORD;
  v_applied1_retry RECORD;

  v_plan2 RECORD;
  v_frozen2 RECORD;
  v_plan3 RECORD;

  v_events_same_version INT := 0;
  v_route_run_plan_link UUID := NULL;
  v_route_stop_count INT := 0;
  v_workflow_run_id UUID := NULL;
  v_workflow_status TEXT := NULL;
  v_workflow_route_run_id UUID := NULL;
  v_workflow_start JSONB := '{}'::jsonb;
  v_iter INT := 0;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function('public', 'create_route_plan_v1', ARRAY['jsonb'], 'service RPC exists: create_route_plan_v1(jsonb)');
  RETURN NEXT has_function('public', 'freeze_route_plan_v1', ARRAY['jsonb'], 'service RPC exists: freeze_route_plan_v1(jsonb)');
  RETURN NEXT has_function('public', 'apply_route_plan_v1', ARRAY['jsonb'], 'service RPC exists: apply_route_plan_v1(jsonb)');
  RETURN NEXT has_function('public', 'start_route_plan_apply_workflow_v1', ARRAY['jsonb'], 'service RPC exists: start_route_plan_apply_workflow_v1(jsonb)');
  RETURN NEXT has_function('public', 'route_plan_resolve_stops_v1', ARRAY['uuid'], 'helper exists: route_plan_resolve_stops_v1(uuid)');
  RETURN NEXT has_column('public', 'route_plans', 'idempotency_hash', 'route_plans has idempotency_hash');

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'route_plan_apply' AND is_active IS TRUE),
    'handler registered: route_plan_apply'
  );

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'route_plan_apply_v1'
   LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: route_plan_apply_v1');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id),
    1,
    'route_plan_apply_v1 has 1 step'
  );
  RETURN NEXT is(
    (SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 1),
    'route_plan_apply',
    'route_plan_apply_v1 step 1 handler_key = route_plan_apply'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'route_plan_events'
        AND indexname = 'idx_route_plan_events_plan_idempotency'
    ),
    'route_plan_events has idx_route_plan_events_plan_idempotency'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'route_runs'
        AND indexname = 'idx_route_runs_route_plan_id_unique'
    ),
    'route_runs has idx_route_runs_route_plan_id_unique'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Plan Org', 'route-plan-org-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'rp-' || left(v_branch::text, 8), 'Route Plan Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'route-plan-' || left(v_user::text, 8) || '@example.com', 'Route Plan User', 'tenant');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Route Plan Client', 'route-plan-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Route Plan Sender', 'Route Plan Sender', TRUE, 'active');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES
    (v_shipment1, v_org, v_client, v_sender, 'delivery', 'pgtap-route-plan-' || left(v_shipment1::text, 8), 'created'),
    (v_shipment2, v_org, v_client, v_sender, 'delivery', 'pgtap-route-plan-' || left(v_shipment2::text, 8), 'created'),
    (v_shipment3, v_org, v_client, v_sender, 'delivery', 'pgtap-route-plan-' || left(v_shipment3::text, 8), 'created');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_plan1
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'requested_by_user_id', v_user,
        'planned_date', '2026-04-03',
        'idempotency_key', 'pgtap-route-plan-create-1',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1),
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 2)
          )
        ),
        'solution', jsonb_build_object(
          'vehicle_id', v_vehicle,
          'driver_user_id', v_user,
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1),
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 2)
          )
        )
      )
    )
    LIMIT 1;

  SELECT *
    INTO v_plan1_retry
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'requested_by_user_id', v_user,
        'planned_date', '2026-04-03',
        'idempotency_key', 'pgtap-route-plan-create-1',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1),
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 2)
          )
        ),
        'solution', jsonb_build_object(
          'vehicle_id', v_vehicle,
          'driver_user_id', v_user,
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1),
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 2)
          )
        )
      )
    )
    LIMIT 1;

  RETURN NEXT is(v_plan1.created, TRUE, 'create_route_plan_v1 first call created=true');
  RETURN NEXT is(v_plan1_retry.created, FALSE, 'create_route_plan_v1 second call created=false (idempotent)');
  RETURN NEXT is(v_plan1.route_plan_id::text, v_plan1_retry.route_plan_id::text, 'create_route_plan_v1 idempotency returns same route_plan_id');

  SELECT *
    INTO v_frozen1
    FROM public.freeze_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan1.route_plan_id,
        'actor_user_id', v_user,
        'idempotency_key', 'pgtap-route-plan-freeze-1'
      )
    )
    LIMIT 1;

  RETURN NEXT is(v_frozen1.status, 'frozen', 'freeze_route_plan_v1 transitions route_plan to frozen');
  RETURN NEXT is(v_frozen1.stop_count, 2, 'freeze_route_plan_v1 resolves two stops');

  SELECT COUNT(*)::int
    INTO v_events_same_version
    FROM public.route_plan_events
   WHERE route_plan_id = v_plan1.route_plan_id
     AND plan_version = 1;

  RETURN NEXT is(v_events_same_version, 2, 'route_plan_events stores multiple lifecycle events for one plan version');

  SELECT *
    INTO v_plan3
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'requested_by_user_id', v_user,
        'planned_date', '2026-04-04',
        'idempotency_key', 'pgtap-route-plan-create-3',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment3, 'stop_kind', 'delivery', 'sequence_order', 1)
          )
        )
      )
    )
    LIMIT 1;

  BEGIN
    PERFORM 1
    FROM public.apply_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan3.route_plan_id,
        'actor_user_id', v_user,
        'idempotency_key', 'pgtap-route-plan-apply-should-fail'
      )
    );
    RETURN NEXT fail('apply_route_plan_v1 rejects non-frozen plans');
  EXCEPTION
    WHEN others THEN
      RETURN NEXT matches(SQLERRM, '.*to be frozen.*', 'apply_route_plan_v1 rejects non-frozen plans');
  END;

  SELECT *
    INTO v_applied1
    FROM public.apply_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan1.route_plan_id,
        'actor_user_id', v_user,
        'idempotency_key', 'pgtap-route-plan-apply-1'
      )
    )
    LIMIT 1;

  RETURN NEXT is(v_applied1.created, TRUE, 'apply_route_plan_v1 first call created=true');
  RETURN NEXT is(v_applied1.status, 'applied', 'apply_route_plan_v1 transitions route_plan to applied');

  SELECT rr.route_plan_id
    INTO v_route_run_plan_link
    FROM public.route_runs rr
   WHERE rr.id = v_applied1.route_run_id
   LIMIT 1;

  RETURN NEXT is(v_route_run_plan_link::text, v_plan1.route_plan_id::text, 'route_run is linked back to route_plan_id');

  SELECT COUNT(*)::int
    INTO v_route_stop_count
    FROM public.route_stops
   WHERE route_run_id = v_applied1.route_run_id;

  RETURN NEXT is(v_route_stop_count, 2, 'apply_route_plan_v1 creates route_stops from frozen plan');

  SELECT *
    INTO v_applied1_retry
    FROM public.apply_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan1.route_plan_id,
        'actor_user_id', v_user,
        'idempotency_key', 'pgtap-route-plan-apply-1'
      )
    )
    LIMIT 1;

  RETURN NEXT is(v_applied1_retry.created, FALSE, 'apply_route_plan_v1 second call created=false (idempotent)');
  RETURN NEXT is(v_applied1_retry.route_run_id::text, v_applied1.route_run_id::text, 'apply_route_plan_v1 idempotency returns same route_run_id');

  SELECT *
    INTO v_plan2
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'requested_by_user_id', v_user,
        'planned_date', '2026-04-05',
        'idempotency_key', 'pgtap-route-plan-create-2',
        'solution', jsonb_build_object(
          'vehicle_id', v_vehicle,
          'driver_user_id', v_user,
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment3, 'stop_kind', 'delivery', 'sequence_order', 1)
          )
        )
      )
    )
    LIMIT 1;

  SELECT *
    INTO v_frozen2
    FROM public.freeze_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan2.route_plan_id,
        'actor_user_id', v_user,
        'idempotency_key', 'pgtap-route-plan-freeze-2'
      )
    )
    LIMIT 1;

  RETURN NEXT is(v_frozen2.status, 'frozen', 'second plan freezes for workflow execution');

  SELECT public.start_route_plan_apply_workflow_v1(
    jsonb_build_object(
      'route_plan_id', v_plan2.route_plan_id,
      'actor_user_id', v_user,
      'idempotency_key', 'pgtap-route-plan-apply-workflow-1'
    )
  )
    INTO v_workflow_start;

  BEGIN
    v_workflow_run_id := NULLIF(v_workflow_start->>'workflow_run_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_workflow_run_id := NULL;
  END;

  RETURN NEXT ok(v_workflow_run_id IS NOT NULL, 'start_route_plan_apply_workflow_v1 returns workflow_run_id');

  FOR v_iter IN 1..10 LOOP
    PERFORM public.progress_workflow_run(v_workflow_run_id);

    SELECT workflow_status
      INTO v_workflow_status
      FROM public.workflow_runs
     WHERE id = v_workflow_run_id;

    EXIT WHEN v_workflow_status IN ('completed', 'failed', 'cancelled');
  END LOOP;

  RETURN NEXT is(COALESCE(v_workflow_status, ''), 'completed', 'route_plan_apply_v1 workflow run completes');

  SELECT (context->'route_plan_apply'->>'route_run_id')::uuid
    INTO v_workflow_route_run_id
    FROM public.workflow_runs
   WHERE id = v_workflow_run_id;

  RETURN NEXT ok(v_workflow_route_run_id IS NOT NULL, 'route_plan_apply_v1 writes route_run_id into workflow context');
  RETURN NEXT is(
    (SELECT status FROM public.route_plans WHERE id = v_plan2.route_plan_id),
    'applied',
    'route_plan_apply_v1 marks the frozen route_plan as applied'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_route_plan_lifecycle_foundation_v1();

SELECT * FROM finish();

ROLLBACK;
