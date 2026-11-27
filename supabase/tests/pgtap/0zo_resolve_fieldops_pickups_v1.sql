-- Test Suite: resolve_fieldops_pickups_v1
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(24);

SELECT has_function(
  'public', 'resolve_fieldops_pickups_v1', ARRAY['text', 'jsonb'],
  'resolve_fieldops_pickups_v1(text, jsonb) exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_fieldops_pickups_v1'
      AND p.prosecdef = TRUE
  ),
  'resolve_fieldops_pickups_v1 is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_fieldops_pickups_v1'
      AND p.provolatile = 's'
  ),
  'resolve_fieldops_pickups_v1 is STABLE'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.resolve_fieldops_pickups_v1(text, jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE resolve_fieldops_pickups_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.resolve_fieldops_pickups_v1(text, jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE resolve_fieldops_pickups_v1'
);

SELECT has_function(
  'api', 'resolve_fieldops_pickups_v1', ARRAY['text', 'jsonb'],
  'api.resolve_fieldops_pickups_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_fieldops_pickups_v1(text, jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE api.resolve_fieldops_pickups_v1'
);

SELECT ok(
  position('shipment_action_id' IN pg_get_functiondef('public.resolve_fieldops_pickups_v1(text,jsonb)'::regprocedure)) > 0
  AND position('workflow_run_id' IN pg_get_functiondef('public.resolve_fieldops_pickups_v1(text,jsonb)'::regprocedure)) > 0,
  'pickup resolver projects workflow and shipment-action lineage fields'
);

-- Functional test with seeded data
DO $$
DECLARE
  v_org_id UUID := gen_random_uuid();
  v_driver_id UUID := gen_random_uuid();
  v_loader_id UUID := gen_random_uuid();
  v_other_driver_id UUID := gen_random_uuid();
  v_client_id UUID := gen_random_uuid();
  v_sender_id UUID := gen_random_uuid();
  v_branch_id UUID := gen_random_uuid();
  v_driver_run UUID := gen_random_uuid();
  v_other_run UUID := gen_random_uuid();
  v_pickup_stop_driver UUID := gen_random_uuid();
  v_pickup_stop_other UUID := gen_random_uuid();
  v_pickup_stop_handoff UUID := gen_random_uuid();
  v_pickup_stop_fail_rpc UUID := gen_random_uuid();
  v_delivery_stop UUID := gen_random_uuid();
  v_pickup_shipment UUID := gen_random_uuid();
  v_pickup_shipment_2 UUID := gen_random_uuid();
  v_pickup_shipment_handoff UUID := gen_random_uuid();
  v_pickup_shipment_fail_rpc UUID := gen_random_uuid();
  v_delivery_shipment UUID := gen_random_uuid();
  v_task_type_route_stop UUID := gen_random_uuid();
  v_task_handoff UUID := gen_random_uuid();
  v_task_fail_rpc UUID := gen_random_uuid();
  v_count_driver INT;
  v_count_loader INT;
  v_resp JSONB;
BEGIN
  -- Seed org, users, client, branch
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_id, 'pgTAP pickups org', 'pgtap-pickups-' || substr(v_org_id::text, 1, 8))
  ON CONFLICT DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status) VALUES
    (v_driver_id, v_org_id, 'pgt-d-' || substr(v_driver_id::text, 1, 8) || '@e.test', 'Driver A', 'fieldops_money_driver', 'active'),
    (v_other_driver_id, v_org_id, 'pgt-o-' || substr(v_other_driver_id::text, 1, 8) || '@e.test', 'Driver B', 'driver', 'active')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client_id, v_org_id, 'Client', 'pgt-c-' || substr(v_client_id::text, 1, 8), 'active')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender_id, v_client_id, 'pgTAP pickups sender', 'pgTAP pickups sender', TRUE, 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org_id,
    'pgtap:resolve-fieldops-pickups-fixture-bootstrap'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org_id, ARRAY['driver'], v_driver_id);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org_id, v_driver_id, r.id, v_driver_id, jsonb_build_object('source', 'fieldops_mobile_v2_pickup_pgtap')
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org_id
     AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (v_loader_id, v_org_id, v_loader_id || '@example.test', 'Loader fixture', 'warehouse_operator', 'active');
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org_id, ARRAY['warehouse_operator'], v_loader_id);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
  SELECT v_org_id, v_loader_id, id FROM public.rbac_roles
  WHERE organization_id = v_org_id AND key = 'warehouse_operator';
  INSERT INTO public.mobile_v2_active_role (user_id, organization_id, role_key)
  VALUES (v_loader_id, v_org_id, 'loader');

  INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
  VALUES (v_branch_id, v_org_id, 'Branch', 'pgt-b-' || substr(v_branch_id::text, 1, 8), 'primary', 'Asia/Riyadh', TRUE)
  ON CONFLICT DO NOTHING;

  -- Runs: one for each driver
  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, planned_start_at) VALUES
    (v_driver_run, v_org_id, v_branch_id, v_driver_id, 'in_progress', CURRENT_DATE, now() + INTERVAL '20 minutes'),
    (v_other_run, v_org_id, v_branch_id, v_other_driver_id, 'in_progress', CURRENT_DATE, now() + INTERVAL '20 minutes')
  ON CONFLICT DO NOTHING;

  -- Shipments
  INSERT INTO public.shipments (id, organization_id, client_id, service_type, tracking_number, box_count, priority_score, status, status_updated_at) VALUES
    (v_pickup_shipment, v_org_id, v_client_id, 'pickup', 'PU-' || substr(v_pickup_shipment::text, 1, 8), 2, 70, 'pending', now()),
    (v_pickup_shipment_2, v_org_id, v_client_id, 'pickup', 'PU-' || substr(v_pickup_shipment_2::text, 1, 8), 1, 50, 'pending', now()),
    (v_pickup_shipment_handoff, v_org_id, v_client_id, 'pickup', 'PU-' || substr(v_pickup_shipment_handoff::text, 1, 8), 2, 80, 'pending', now()),
    (v_pickup_shipment_fail_rpc, v_org_id, v_client_id, 'pickup', 'PU-' || substr(v_pickup_shipment_fail_rpc::text, 1, 8), 1, 85, 'pending', now()),
    (v_delivery_shipment, v_org_id, v_client_id, 'delivery', 'DLX-' || substr(v_delivery_shipment::text, 1, 8), 1, 60, 'pending', now())
  ON CONFLICT DO NOTHING;

  -- Stops: 1 pickup on driver's run, 1 pickup on other driver's run, 1 delivery on driver's run
  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order, planned_window_start_at) VALUES
    (v_pickup_stop_driver, v_org_id, v_driver_run, v_client_id, v_pickup_shipment, 'pickup', 1, now() + INTERVAL '30 minutes'),
    (v_pickup_stop_handoff, v_org_id, v_driver_run, v_client_id, v_pickup_shipment_handoff, 'pickup', 2, now() + INTERVAL '35 minutes'),
    (v_pickup_stop_fail_rpc, v_org_id, v_driver_run, v_client_id, v_pickup_shipment_fail_rpc, 'pickup', 3, now() + INTERVAL '40 minutes'),
    (v_pickup_stop_other, v_org_id, v_other_run, v_client_id, v_pickup_shipment_2, 'pickup', 1, now() + INTERVAL '90 minutes'),
    (v_delivery_stop, v_org_id, v_driver_run, v_client_id, v_delivery_shipment, 'delivery', 4, now() + INTERVAL '120 minutes')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.task_types (id, organization_id, key, name, default_priority, default_queue_key, enabled, metadata)
  VALUES (v_task_type_route_stop, v_org_id, 'route_stop_execute', 'Route Stop Execute', 50, 'default', TRUE, '{}'::jsonb)
  ON CONFLICT (organization_id, key) DO UPDATE
  SET name = EXCLUDED.name
  RETURNING id INTO v_task_type_route_stop;

  INSERT INTO public.tasks (
    id, organization_id, client_id, task_type_id, resource_type, resource_id,
    status, priority, queue_key, assigned_to, assigned_at, idempotency_key, metadata
  )
  VALUES
    (v_task_handoff, v_org_id, v_client_id, v_task_type_route_stop, 'route_stop', v_pickup_stop_handoff,
     'open', 50, 'default', v_driver_id, now(), 'pgtap-mobile-v2-pickup-handoff-' || v_pickup_stop_handoff::text,
     jsonb_build_object('route_run_id', v_driver_run, 'route_stop_id', v_pickup_stop_handoff, 'shipment_id', v_pickup_shipment_handoff)),
    (v_task_fail_rpc, v_org_id, v_client_id, v_task_type_route_stop, 'route_stop', v_pickup_stop_fail_rpc,
     'open', 50, 'default', v_driver_id, now(), 'pgtap-mobile-v2-pickup-fail-' || v_pickup_stop_fail_rpc::text,
     jsonb_build_object('route_run_id', v_driver_run, 'route_stop_id', v_pickup_stop_fail_rpc, 'shipment_id', v_pickup_shipment_fail_rpc))
  ON CONFLICT (id) DO NOTHING;

  -- Set driver context
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver_id::text)::text,
    TRUE
  );

  PERFORM ok(
    public.user_has_capability_v1('pickups.read', 'tenant', v_org_id),
    'fieldops money driver has pickups.read for Mobile V2 pickup navigation'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(public.ui_navigation_v1('mobile')->'sections') section,
             jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
       WHERE item->>'id' = 'mobile-pickups'
         AND item->>'capability' = 'pickups.read'
         AND NOT (item ? 'disabled_reason')
    ),
    'ui_navigation returns enabled Mobile V2 Pickups for fieldops money driver'
  );

  -- Driver should see ONLY their own pickup, NOT delivery or other driver's pickup
  SELECT COUNT(*) INTO v_count_driver
    FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
    WHERE t.task_id = 'pickup:' || v_pickup_stop_driver::text;
  PERFORM ok(v_count_driver = 1, 'driver sees their own pickup stop');

  SELECT COUNT(*) INTO v_count_driver
    FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
    WHERE t.task_id = 'pickup:' || v_pickup_stop_other::text;
  PERFORM ok(v_count_driver = 0, 'driver does NOT see another driver pickup');

  SELECT COUNT(*) INTO v_count_driver
    FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
    WHERE t.task_id = 'pickup:' || v_delivery_stop::text;
  PERFORM ok(v_count_driver = 0, 'driver does NOT see delivery stops (only pickup stop_kind)');

  -- Loader sees ALL pickup stops org-wide
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_loader_id)::text, TRUE);
  SELECT COUNT(*) INTO v_count_loader
    FROM public.resolve_fieldops_pickups_v1('loader', '{}'::jsonb) t
    WHERE t.task_id IN ('pickup:' || v_pickup_stop_driver::text, 'pickup:' || v_pickup_stop_other::text);
  PERFORM ok(v_count_loader = 2, 'loader sees ALL org pickup stops (both drivers)');

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_driver_id)::text, TRUE);

  -- Envelope shape: code, type, route, action are correct
  PERFORM ok(
    EXISTS (
      SELECT 1 FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
      WHERE t.task_id = 'pickup:' || v_pickup_stop_driver::text
        AND t.type = 'pickup'
        AND t.action = 'pickup'
        AND t.code LIKE 'PU-%'
        AND t.route = '/mobile/pickup/' || v_pickup_stop_driver::text
    ),
    'pickup envelope has correct type, action, code, route'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1 FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
      WHERE t.task_id = 'pickup:' || v_pickup_stop_driver::text
        AND t.meta->>'route_stop_id' = v_pickup_stop_driver::text
        AND t.meta->>'stop_kind' = 'pickup'
        AND (t.meta->>'expected_qty')::int = 2
        AND t.meta->>'pickup_status' = 'pending'
        AND t.meta->>'status' = 'pending'
    ),
    'pickup meta exposes route_stop_id, stop_kind, expected_qty, and pending status'
  );

  UPDATE public.shipments
     SET status = 'in_transit',
         status_updated_at = now()
   WHERE id = v_pickup_shipment;

  PERFORM ok(
    EXISTS (
      SELECT 1 FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
      WHERE t.task_id = 'pickup:' || v_pickup_stop_driver::text
        AND t.meta->>'status' = 'completed'
        AND (t.meta->>'picked')::int = 2
    ),
    'pickup meta projects completed readback from canonical shipment state'
  );

  -- Urgency=now for stop within 60 minutes
  PERFORM ok(
    EXISTS (
      SELECT 1 FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
      WHERE t.task_id = 'pickup:' || v_pickup_stop_driver::text
        AND t.urgency = 'now'
    ),
    'pickup within 60min has urgency=now'
  );

  v_resp := public.submit_fieldops_proof_v1(
    v_pickup_stop_handoff,
    'delivered',
    jsonb_build_object(
      'source', 'fieldops_mobile_v2_pickup',
      'stop_kind', 'pickup',
      'pickup_action', 'handoff',
      'pod_methods', 'pickup_handoff',
      'confirmed_quantity', 2,
      'expected_quantity', 2,
      'receipt_context', 'pgtap-mobile-v2-pickup-handoff'
    ),
    gen_random_uuid()
  );

  PERFORM ok(
    (v_resp ? 'task_event_id')
      AND (v_resp ? 'workflow_run_id')
      AND (v_resp ? 'shipment_action_id')
      AND (v_resp->>'workflow_status') = 'completed',
    'submit_fieldops_proof_v1 pickup handoff returns canonical closeout lineage'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1 FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
      WHERE t.task_id = 'pickup:' || v_pickup_stop_handoff::text
        AND t.meta->>'status' = 'completed'
        AND t.meta->>'pickup_status' = 'completed'
        AND t.meta->>'shipment_status' = 'in_transit'
        AND (t.meta->>'picked')::int = 2
        AND t.meta->>'route_stop_task_id' = v_task_handoff::text
        AND t.meta->>'task_event_id' = v_resp->>'task_event_id'
        AND t.meta->>'workflow_run_id' = v_resp->>'workflow_run_id'
        AND t.meta->>'shipment_action_id' = v_resp->>'shipment_action_id'
    ),
    'pickup resolver returns same-context handoff readback after Mobile V2 write RPC'
  );

  v_resp := public.submit_fieldops_proof_v1(
    v_pickup_stop_fail_rpc,
    'failed',
    jsonb_build_object(
      'source', 'fieldops_mobile_v2_pickup',
      'stop_kind', 'pickup',
      'pickup_action', 'failure',
      'pod_methods', 'pickup_failure',
      'reason_code', 'pickup_not_ready',
      'status_reason', 'pickup_not_ready',
      'exception_reason', 'pickup_not_ready',
      'exception_notes', 'pgtap Mobile V2 pickup failure readback'
    ),
    gen_random_uuid()
  );

  PERFORM ok(
    (v_resp ? 'task_event_id')
      AND (v_resp ? 'workflow_run_id')
      AND (v_resp ? 'shipment_action_id')
      AND (v_resp->>'state') = 'failed'
      AND (v_resp->>'workflow_status') = 'completed',
    'submit_fieldops_proof_v1 pickup failure returns canonical closeout lineage'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1 FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
      WHERE t.task_id = 'pickup:' || v_pickup_stop_fail_rpc::text
        AND t.meta->>'status' = 'failed'
        AND t.meta->>'pickup_status' = 'failed'
        AND t.meta->>'shipment_status' = 'pickup_failed'
        AND t.meta->>'failure_reason' = 'pickup_not_ready'
        AND (t.meta->>'picked')::int = 0
        AND t.meta->>'route_stop_task_id' = v_task_fail_rpc::text
        AND t.meta->>'task_event_id' = v_resp->>'task_event_id'
        AND t.meta->>'workflow_run_id' = v_resp->>'workflow_run_id'
        AND t.meta->>'shipment_action_id' = v_resp->>'shipment_action_id'
    ),
    'pickup resolver returns same-context failure readback after Mobile V2 write RPC'
  );

  UPDATE public.route_stops
     SET metadata = jsonb_build_object(
           'status', 'failed',
           'last_proof', jsonb_build_object(
             'evidence', jsonb_build_object(
               'stop_kind', 'pickup',
               'reason_code', 'pickup_not_ready',
               'status_reason', 'pickup_not_ready',
               'expected_quantity', 2
             )
           )
         ),
         updated_at = now()
   WHERE id = v_pickup_stop_driver;

  UPDATE public.shipments
     SET status = 'pickup_failed',
         status_updated_at = now()
   WHERE id = v_pickup_shipment;

  UPDATE public.route_runs
     SET status = 'completed',
         updated_at = now()
   WHERE id = v_driver_run;

  PERFORM ok(
    EXISTS (
      SELECT 1 FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
      WHERE t.task_id = 'pickup:' || v_pickup_stop_driver::text
        AND t.meta->>'pickup_status' = 'failed'
        AND t.meta->>'failure_reason' = 'pickup_not_ready'
        AND (t.meta->>'picked')::int = 0
    ),
    'pickup resolver preserves pickup failure reason and quantity readback'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1 FROM public.resolve_fieldops_pickups_v1('driver', '{}'::jsonb) t
      WHERE t.task_id = 'pickup:' || v_pickup_stop_driver::text
        AND t.meta->>'route_run_status' = 'completed'
    ),
    'completed pickup route remains visible for same-session Mobile V2 readback'
  );

  PERFORM set_config('request.jwt.claims', '', TRUE);
END $$;

SELECT * FROM finish();
ROLLBACK;
