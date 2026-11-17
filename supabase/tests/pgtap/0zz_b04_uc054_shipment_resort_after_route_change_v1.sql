-- Plan: B04 UC054 shipment resort after route change / Step: E01
-- pgTAP: shipment resort UI/API contract

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(19);

CREATE OR REPLACE FUNCTION pg_temp.test_b04_uc054_shipment_resort_after_route_change_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_commands JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_sender_no_policy UUID := gen_random_uuid();
  v_shipment_blocked UUID := gen_random_uuid();
  v_old_basket UUID := gen_random_uuid();
  v_new_basket UUID := gen_random_uuid();
  v_result JSONB := NULL;
  v_blocked_result JSONB := NULL;
  v_workflow_run_id UUID := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_commands
    FROM public.settings
   WHERE category = 'ui_command_registry'
   LIMIT 1;

  RETURN NEXT has_function(
    'public',
    'ui_resort_shipment_v1',
    ARRAY['jsonb'],
    'public.ui_resort_shipment_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_resort_shipment_v1',
    ARRAY['jsonb'],
    'api.ui_resort_shipment_v1 exists'
  );
  RETURN NEXT has_function(
    'public',
    'ui_execute_shipment_resort_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'public.ui_execute_shipment_resort_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_shipment_resort_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'api.ui_execute_shipment_resort_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_resort_shipment_v1(jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_resort_shipment_v1'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_shipment_resort_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_execute_shipment_resort_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege(
      'anon',
      'api.ui_execute_shipment_resort_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'anon cannot execute api.ui_execute_shipment_resort_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'shipments.resort'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_shipment_resort_v1'
    ),
    'ui_command_registry exposes shipments.resort'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'UC054 Resort Org', 'uc054-resort-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client, v_org, 'UC054 Client', 'uc054-client-' || left(v_client::text, 8), 'standard', 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'UC054 Sender', 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_operator,
    v_org,
    'uc054-ops-' || left(v_operator::text, 8) || '@example.com',
    'UC054 Operator',
    'ops_admin',
    'tenant'
  );

  INSERT INTO public.baskets (
    id,
    organization_id,
    basket_type,
    state,
    sort_route_key,
    current_count,
    created_at,
    updated_at
  )
  VALUES
    (v_old_basket, v_org, 'zone_based', 'forming', 'route-a', 0, now(), now()),
    (v_new_basket, v_org, 'zone_based', 'forming', 'route-b', 0, now(), now());

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    tracking_number,
    status,
    service_type,
    metadata,
    box_count,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'UC054-' || upper(left(v_shipment::text, 8)),
    'pending',
    'delivery',
    jsonb_build_object('routing', jsonb_build_object('route_key', 'route-b')),
    1,
    now(),
    now()
  );

  INSERT INTO public.basket_items (basket_id, shipment_id, shipment_client_id)
  VALUES (v_old_basket, v_shipment, v_client);

  PERFORM public.upsert_settings_value_v1(
    'basket_policy',
    'sender',
    v_sender,
    jsonb_build_object(
      'version', 1,
      'enabled', true,
      'basket_type', 'zone_based',
      'open_states', jsonb_build_array('forming'),
      'create_if_missing', true,
      'require_zone', false,
      'group_by_route', true,
      'route_key_paths', 'routing.route_key|dispatch.route_key'
    ),
    1,
    'pgTAP fixture: UC054 route-key basket policy'
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_operator::text,
      'role', 'authenticated'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_execute_shipment_resort_v1(
    'shipments.resort',
    'shipments',
    ARRAY[v_shipment::text],
    v_shipment::text,
    1,
    '{}'::jsonb
  );

  BEGIN
    v_workflow_run_id := NULLIF(v_result->>'workflow_run_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_workflow_run_id := NULL;
  END;

  RETURN NEXT is(v_result->>'status', 'resorted', 'api.ui_execute_shipment_resort_v1 reports resorted status');
  RETURN NEXT is(
    v_result#>>'{items,0,previous_basket_id}',
    v_old_basket::text,
    'shipment resort returns previous_basket_id'
  );
  RETURN NEXT is(
    v_result#>>'{items,0,basket_id}',
    v_new_basket::text,
    'shipment resort returns the reassigned basket_id'
  );
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (
      SELECT bi.basket_id::text
      FROM public.basket_items bi
      WHERE bi.shipment_id = v_shipment
        AND bi.shipment_client_id = v_client
        AND bi.removed_at IS NULL
      ORDER BY bi.added_at DESC, bi.id DESC
      LIMIT 1
    ),
    v_new_basket::text,
    'active basket membership moves to the new route basket'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
      FROM public.mis_sort_exceptions mse
      WHERE mse.shipment_id = v_shipment
        AND mse.shipment_client_id = v_client
    ),
    '0',
    'mis_sort_exceptions are cleared after shipment resort'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.decision_log dl
      WHERE dl.resource_type = 'shipment'
        AND dl.resource_id = v_shipment
        AND dl.decision_point = 'shipment_resort'
        AND dl.decision_outcome = 'resorted'
        AND dl.correlation_id = v_workflow_run_id
    ),
    'decision_log records the shipment_resort outcome'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.workflow_runs wr
      JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
      WHERE wr.id = v_workflow_run_id
        AND wt.name = 'shipment_resort_v1'
        AND wr.workflow_status = 'completed'
    ),
    'shipment_resort_v1 workflow run completes for the selected shipment'
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_operator::text,
      'role', 'authenticated'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_execute_shipment_resort_v1(
    'shipments.resort',
    'shipments',
    ARRAY[v_shipment::text],
    v_shipment::text,
    1,
    '{}'::jsonb
  );

  RETURN NEXT is(v_result->>'status', 'already_sorted', 'duplicate shipment resort returns already_sorted');

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender_no_policy, v_client, 'UC054 Sender No Policy', 'active');

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    tracking_number,
    status,
    service_type,
    metadata,
    box_count,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment_blocked,
    v_org,
    v_client,
    v_sender_no_policy,
    'UC054B-' || upper(left(v_shipment_blocked::text, 8)),
    'pending',
    'delivery',
    jsonb_build_object('routing', jsonb_build_object('route_key', 'route-c')),
    1,
    now(),
    now()
  );

  INSERT INTO public.basket_items (basket_id, shipment_id, shipment_client_id)
  VALUES (v_old_basket, v_shipment_blocked, v_client);

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_operator::text,
      'role', 'authenticated'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_blocked_result := api.ui_execute_shipment_resort_v1(
    'shipments.resort',
    'shipments',
    ARRAY[v_shipment_blocked::text],
    v_shipment_blocked::text,
    1,
    '{}'::jsonb
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(v_blocked_result->>'status', 'blocked', 'shipment resort blocks when no basket policy can resolve a target basket');
  RETURN NEXT is(
    v_blocked_result#>>'{items,0,previous_basket_id}',
    v_old_basket::text,
    'blocked shipment resort preserves the current basket as previous_basket_id'
  );
  RETURN NEXT is(
    (
      SELECT bi.basket_id::text
      FROM public.basket_items bi
      WHERE bi.shipment_id = v_shipment_blocked
        AND bi.shipment_client_id = v_client
        AND bi.removed_at IS NULL
      ORDER BY bi.added_at DESC, bi.id DESC
      LIMIT 1
    ),
    v_old_basket::text,
    'blocked shipment resort leaves the shipment in its original basket'
  );
END;
$function$;

SELECT * FROM pg_temp.test_b04_uc054_shipment_resort_after_route_change_v1();

SELECT * FROM finish();

ROLLBACK;
