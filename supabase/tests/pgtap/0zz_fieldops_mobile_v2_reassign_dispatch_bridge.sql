SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_target_driver UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_source_run UUID := gen_random_uuid();
  v_target_run UUID := gen_random_uuid();
  v_stop UUID := gen_random_uuid();
  v_ship UUID := gen_random_uuid();
  v_key UUID := gen_random_uuid();
  v_resp JSONB;
  v_resp2 JSONB;
  v_task_id UUID;
  v_event_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'pgTAP mobile reassign bridge', 'pgt-mv2-reassign-' || substr(v_org::text, 1, 8))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, status)
  VALUES
    (v_driver, v_org, 'pgt-mv2-driver-' || substr(v_driver::text, 1, 8) || '@e.test', 'Mobile Driver', 'active'),
    (v_target_driver, v_org, 'pgt-mv2-target-' || substr(v_target_driver::text, 1, 8) || '@e.test', 'Target Driver', 'active')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Client', 'pgt-mv2-reassign-c-' || substr(v_client::text, 1, 8))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
  VALUES (v_branch, v_org, 'Branch', 'pgt-mv2-rb-' || substr(v_branch::text, 1, 8), 'primary', 'Asia/Riyadh', TRUE)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, planned_start_at)
  VALUES
    (v_source_run, v_org, v_branch, v_driver, 'in_progress', CURRENT_DATE, now()),
    (v_target_run, v_org, v_branch, v_target_driver, 'in_progress', CURRENT_DATE, now())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number, box_count, priority_score, status, status_updated_at
  )
  VALUES (v_ship, v_org, v_client, 'delivery', 'MV2-RSG-' || substr(v_ship::text, 1, 8), 1, 50, 'pending', now())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.route_stops (
    id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order, planned_window_start_at, metadata
  )
  VALUES (v_stop, v_org, v_source_run, v_client, v_ship, 'delivery', 1, now(), jsonb_build_object('status', 'pending'))
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver::text, 'role', 'authenticated')::text,
    true
  );

  v_resp := public.submit_fieldops_reassign_v1(
    v_stop,
    v_target_driver,
    'Flat tire; dispatch handoff needed',
    v_key
  );
  v_task_id := NULLIF(v_resp->>'dispatch_task_id', '')::uuid;

  PERFORM ok((v_resp->>'state') = 'requested' AND (v_resp->>'ok')::boolean, 'Mobile V2 reassign returns requested state');
  PERFORM ok(v_task_id IS NOT NULL, 'Mobile V2 reassign returns Dispatch task id');
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.tasks t
        JOIN public.task_types tt ON tt.id = t.task_type_id
       WHERE t.id = v_task_id
         AND tt.key = 'dispatch_exception_review'
         AND t.resource_type = 'route_stop'
         AND t.resource_id = v_stop
         AND t.status NOT IN ('completed', 'canceled')
         AND (t.metadata->>'mobile_v2_reassign_request')::boolean IS TRUE
         AND t.metadata->>'target_driver_user_id' = v_target_driver::text
    ),
    'Mobile V2 reassign creates pending Dispatch recovery task with target driver context'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.id = (v_resp->>'decision_log_id')::uuid
         AND dl.decision_category = 'fieldops_reassign'
         AND dl.resource_type = 'route_stop'
         AND dl.resource_id = v_stop
    ),
    'Mobile V2 reassign writes canonical decision log'
  );

  v_resp2 := public.submit_fieldops_reassign_v1(
    v_stop,
    v_target_driver,
    'Flat tire; dispatch handoff needed',
    v_key
  );
  PERFORM is(v_resp2->>'dispatch_task_id', v_task_id::text, 'Mobile V2 reassign replay returns same Dispatch task');

  INSERT INTO public.route_stop_reassignment_events (
    id,
    organization_id,
    route_stop_id,
    client_id,
    shipment_id,
    source_route_run_id,
    target_route_run_id,
    event_type,
    actor_system,
    payload
  )
  VALUES (
    v_event_id,
    v_org,
    v_stop,
    v_client,
    v_ship,
    v_source_run,
    v_target_run,
    'reassigned',
    'pgtap',
    jsonb_build_object('target_assignment', jsonb_build_object('driver_user_id', v_target_driver))
  );

  PERFORM is(
    (SELECT t.status FROM public.tasks t WHERE t.id = v_task_id),
    'completed',
    'Canonical reassignment event completes pending Mobile V2 Dispatch task'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.task_events te
       WHERE te.task_id = v_task_id
         AND te.to_status = 'completed'
         AND te.payload->>'route_stop_reassignment_event_id' = v_event_id::text
    ),
    'Task completion event links back to route_stop_reassignment_events'
  );

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

SELECT has_trigger(
  'public',
  'route_stop_reassignment_events',
  'trg_route_stop_reassign_complete_fieldops_request',
  'route_stop_reassignment_events completes Mobile V2 reassignment request tasks'
);

SELECT * FROM finish();
ROLLBACK;
