BEGIN;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(22);

SELECT ok(NOT has_function_privilege('anon', 'api.public_tracking_live_session_v1(jsonb)', 'EXECUTE'),
  'anon cannot access the live session RPC directly');
SELECT ok(NOT has_function_privilege('authenticated', 'api.public_tracking_live_session_v1(jsonb)', 'EXECUTE'),
  'authenticated cannot access the live session RPC directly');
SELECT ok(NOT has_table_privilege('anon', 'public.public_tracking_live_cells', 'SELECT'),
  'anon cannot read stored cells');
SELECT ok(NOT has_table_privilege('authenticated', 'public.public_tracking_live_cells', 'SELECT'),
  'authenticated cannot read stored cells');

CREATE FUNCTION pg_temp.check_public_tracking_live_session()
RETURNS SETOF text
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_other_client uuid := gen_random_uuid();
  v_driver uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_earlier_stop uuid := gen_random_uuid();
  v_earlier_shipment uuid := gen_random_uuid();
  v_extra_stop uuid := gen_random_uuid();
  v_extra_shipment uuid := gen_random_uuid();
  v_other_shipment uuid := gen_random_uuid();
  v_other_tracking_number text := 'OTHER-' || left(v_other_shipment::text, 8);
  v_shipment uuid := gen_random_uuid();
  v_task_type uuid;
  v_token text := gen_random_uuid()::text;
  v_other_token text := gen_random_uuid()::text;
  v_expired_token text := gen_random_uuid()::text;
  v_input jsonb := jsonb_build_object('session_token', v_token, 'ip_hash', gen_random_uuid());
  v_live jsonb;
  v_other_tracking jsonb;
  v_cell jsonb;
  v_ping geometry := ST_SetSRID(ST_MakePoint(11.0123, 10.0123), 4326);
  v_south numeric;
  v_west numeric;
  v_north numeric;
  v_east numeric;
  v_policy jsonb;
  v_time timestamptz := date_trunc('month', now()) + interval '1 day';
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Tracking test', 'tracking-live-' || left(v_org::text, 8)),
    (v_other_org, 'Other tracking test', 'tracking-other-' || left(v_other_org::text, 8));
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client, v_org, 'Tracking test client', 'tracking-live-' || left(v_client::text, 8), 'active'),
    (v_other_client, v_other_org, 'Other tracking test client', 'tracking-other-' || left(v_other_client::text, 8), 'active');
  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_driver, v_org, 'driver-' || left(v_driver::text, 8) || '@example.com', 'Fixture', 'tenant');
  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:tracking-live');
  PERFORM public.bootstrap_tenant_onboarding_v1(v_other_org, 'pgtap:tracking-live');

  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_other_shipment, v_other_org, v_other_client, v_other_tracking_number, 'delivery', 'pending'),
    (v_earlier_shipment, v_org, v_client, 'EARLY-' || left(v_earlier_shipment::text, 8), 'delivery', 'pending'),
    (v_extra_shipment, v_org, v_client, 'EXTRA-' || left(v_extra_shipment::text, 8), 'delivery', 'pending'),
    (v_shipment, v_org, v_client, 'LIVE-' || left(v_shipment::text, 8), 'delivery', 'out_for_delivery');

  INSERT INTO public.route_runs (id, organization_id, driver_user_id, status, started_at)
  VALUES (v_run, v_org, v_driver, 'in_progress', v_time - interval '20 minutes');

  INSERT INTO public.route_stops
    (id, organization_id, route_run_id, client_id, shipment_id, sequence_order, planned_window_start_at, planned_window_end_at)
  VALUES
    (v_earlier_stop, v_org, v_run, v_client, v_earlier_shipment, 1, v_time, v_time + interval '1 hour'),
    (v_extra_stop, v_org, v_run, v_client, v_extra_shipment, 2, v_time, v_time + interval '1 hour'),
    (gen_random_uuid(), v_org, v_run, v_client, v_shipment, 3, v_time, v_time + interval '1 hour');

  INSERT INTO public.tracking_sessions (organization_id, client_id, shipment_id, token, expires_at)
  VALUES
    (v_org, v_client, v_shipment, v_token, v_time + interval '1 hour'),
    (v_other_org, v_other_client, v_other_shipment, v_other_token, v_time + interval '1 hour'),
    (v_org, v_client, v_shipment, v_expired_token, v_time - interval '1 minute');
  INSERT INTO public.location_pings (organization_id, route_run_id, actor_user_id, coordinates, captured_at)
  VALUES (v_org, v_run, v_driver, v_ping::geography, v_time);

  PERFORM set_config('platform.now_override', v_time::text, true);
  v_policy := public.public_tracking_policy_v1(jsonb_build_object('organization_id', v_org, 'client_id', v_client));

  EXECUTE 'SET LOCAL ROLE service_role';
  v_live := api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery}';
  RETURN NEXT is(v_live->>'status', 'hidden', 'area is off by default');
  RETURN NEXT is((v_live->>'eta_window_end_at')::timestamptz - (v_live->>'eta_window_start_at')::timestamptz,
    interval '15 minutes', 'the default ETA window remains available while area is off');

  RETURN NEXT is(api.public_tracking_live_session_v1(v_input || jsonb_build_object('session_token', gen_random_uuid()))
    #>> '{error,code}', 'invalid_session', 'wrong token cannot access live tracking');
  RETURN NEXT is(api.public_tracking_live_session_v1(v_input || jsonb_build_object('session_token', v_expired_token))
    #>> '{error,code}', 'invalid_session', 'expired token cannot access live tracking');
  RESET ROLE;

  PERFORM public.upsert_settings_value_v1('public_tracking_policy', 'tenant', v_org,
    v_policy || '{"live_delivery":{"area_enabled":true,"eta_enabled":false}}'::jsonb, 1, 'pgtap disable ETA');

  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery}',
    'null'::jsonb, 'disabling ETA returns null for an active delivery');
  RESET ROLE;

  v_policy := v_policy || '{"live_delivery":{
    "area_enabled":true,"max_stops_ahead":1,"stale_after_seconds":120,"eta_window_minutes":20
  }}'::jsonb;
  PERFORM public.upsert_settings_value_v1('public_tracking_policy', 'tenant', v_org,
    v_policy, 1, 'pgtap configure live delivery');

  EXECUTE 'SET LOCAL ROLE service_role';
  v_live := api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery}';
  RETURN NEXT ok(v_live->>'status' = 'too_far' AND v_live->'area' = 'null'::jsonb
    AND v_live->>'stops_ahead' = '2' AND v_live->>'eta_window_end_at' IS NOT NULL,
    'more stops ahead than the policy allows hides the area and keeps the ETA');
  RESET ROLE;

  DELETE FROM public.route_stops WHERE id = v_extra_stop;

  EXECUTE 'SET LOCAL ROLE service_role';
  v_live := api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery}';
  v_cell := v_live->'area';
  RETURN NEXT is(v_live->>'stops_ahead', '1', 'live count includes only preceding open stops');
  RETURN NEXT ok(v_live->>'status' = 'live'
    AND v_cell ?& ARRAY['south', 'west', 'north', 'east']
    AND (SELECT count(*) FROM jsonb_object_keys(v_cell)) = 4
    AND NOT (v_live ?| ARRAY['route_run_id','route_stop_id','actor_user_id','latitude','longitude','radius']),
    'live response contains only coarse bounds and approved summary');

  v_south := (v_cell->>'south')::numeric;
  v_west := (v_cell->>'west')::numeric;
  v_north := (v_cell->>'north')::numeric;
  v_east := (v_cell->>'east')::numeric;
  RETURN NEXT ok(ST_Covers(ST_MakeEnvelope(v_west, v_south, v_east, v_north, 4326), v_ping)
    AND ST_DistanceSphere(ST_Point(v_west, v_south, 4326), ST_Point(v_west, v_north, 4326)) >= 500
    AND ST_DistanceSphere(ST_Point(v_west, v_north, 4326), ST_Point(v_east, v_north, 4326)) >= 500,
    'area contains the ping and spans at least the default 500 m policy grid in each direction');
  RETURN NEXT is((v_live->>'eta_window_end_at')::timestamptz - (v_live->>'eta_window_start_at')::timestamptz,
    interval '20 minutes', 'live ETA uses the configured tenant window width');

  v_other_tracking := api.public_tracking_live_session_v1(v_input || jsonb_build_object(
    'session_token', v_other_token, 'shipment_id', v_shipment)) -> 'tracking';
  RETURN NEXT ok(v_other_tracking #>> '{shipment,tracking_number}' = v_other_tracking_number
    AND v_other_tracking->'live_delivery' = 'null'::jsonb,
    'another tenant session stays bound to its own shipment');
  RESET ROLE;

  INSERT INTO public.route_run_assignments (organization_id, route_run_id, assignment_mode, partner)
  VALUES (v_org, v_run, 'partner_fleet', jsonb_build_object('partner_id', gen_random_uuid()));

  EXECUTE 'SET LOCAL ROLE service_role';
  v_live := api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery}';
  RETURN NEXT ok(v_live->>'status' = 'hidden' AND v_live->'area' = 'null'::jsonb
    AND v_live->>'eta_window_end_at' IS NOT NULL, 'a partner run needs its own opt-in to show the area');
  RESET ROLE;

  UPDATE public.route_run_assignments SET assignment_mode = 'alternate_capacity_pool' WHERE route_run_id = v_run;

  EXECUTE 'SET LOCAL ROLE service_role';
  v_live := api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery}';
  RETURN NEXT ok(v_live->>'status' = 'hidden' AND v_live->'area' = 'null'::jsonb
    AND v_live->>'eta_window_end_at' IS NOT NULL, 'alternate capacity partner runs also require opt-in');
  RESET ROLE;

  DELETE FROM public.route_run_assignments WHERE route_run_id = v_run;

  INSERT INTO public.location_pings (organization_id, route_run_id, actor_user_id, coordinates, captured_at)
  VALUES (v_org, v_run, v_driver, ST_SetSRID(ST_MakePoint(11.0323, 10.0323), 4326)::geography, v_time + interval '30 seconds');
  PERFORM set_config('platform.now_override', (v_time + interval '30 seconds')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery,area}',
    v_cell, 'new ping cannot change the cell within 60 seconds');
  RESET ROLE;

  SELECT id INTO v_task_type FROM public.task_types WHERE organization_id = v_org AND key = 'route_stop_execute';
  IF v_task_type IS NULL THEN
    INSERT INTO public.task_types (organization_id, key, name, enabled, default_priority, default_queue_key)
    VALUES (v_org, 'route_stop_execute', 'Fixture route stop', true, 50, 'default') RETURNING id INTO v_task_type;
  END IF;
  INSERT INTO public.tasks
    (organization_id, task_type_id, resource_type, resource_id, status, status_reason, priority)
  VALUES (v_org, v_task_type, 'route_stop', v_earlier_stop, 'in_progress', 'arrived', 50);

  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery,area}',
    'null'::jsonb, 'arrival at an earlier open stop hides the area immediately');

  PERFORM set_config('platform.now_override', (v_time + interval '3 minutes')::text, true);
  v_live := api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery}';
  RETURN NEXT ok(v_live->>'status' = 'paused' AND v_live->'area' = 'null'::jsonb
    AND (v_live->>'eta_window_start_at')::timestamptz = v_time
    AND v_live->>'updated_at' IS NOT NULL, 'pings past the tenant staleness cutoff show only the planning window');
  RESET ROLE;

  DELETE FROM public.route_stops WHERE id = v_earlier_stop;
  PERFORM set_config('platform.now_override', (v_time + interval '30 seconds')::text, true);
  PERFORM public.upsert_settings_value_v1('public_tracking_policy', 'tenant', v_org,
    jsonb_set(v_policy, '{live_delivery,max_stops_ahead}', '0'::jsonb), 1, 'pgtap disable area at any stop count');

  EXECUTE 'SET LOCAL ROLE service_role';
  v_live := api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery}';
  RETURN NEXT ok(v_live->>'stops_ahead' = '0' AND v_live->>'status' = 'hidden' AND v_live->'area' = 'null'::jsonb,
    'a zero max_stops_ahead never shows the area, even at the next stop');
  RESET ROLE;

  UPDATE public.shipments SET status = 'delivered' WHERE id = v_shipment AND client_id = v_client;
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.public_tracking_live_session_v1(v_input) #> '{tracking,live_delivery}',
    'null'::jsonb, 'delivery immediately removes live tracking');
  RESET ROLE;
END;
$$;

SELECT * FROM pg_temp.check_public_tracking_live_session();
SELECT * FROM finish();
ROLLBACK;
