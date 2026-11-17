-- Plan: B07 route closeout / UC085
-- pgTAP: route closeout command + helper contract

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

CREATE OR REPLACE FUNCTION pg_temp.seed_route_closeout_fixture()
RETURNS TABLE (
  organization_id UUID,
  driver_user_id UUID,
  other_driver_user_id UUID,
  route_run_id UUID,
  route_stop_id UUID,
  task_id UUID
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_other_driver UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_route_run_id UUID := NULL;
  v_route_stop_id UUID := NULL;
  v_task_id UUID := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Closeout Org', 'route-closeout-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_driver, v_org, 'driver-' || left(v_driver::text, 8) || '@example.com', 'Route Driver', 'tenant'),
    (v_other_driver, v_org, 'driver-' || left(v_other_driver::text, 8) || '@example.com', 'Other Driver', 'tenant');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_other_driver);

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_other_driver, r.id, v_other_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'rc-' || left(v_branch::text, 8), 'Route Closeout Branch', 'Asia/Riyadh', TRUE);

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status, settings_override)
  VALUES (
    v_client,
    v_org,
    'Route Closeout Client',
    'route-closeout-' || left(v_client::text, 8),
    'standard',
    'active',
    '{}'::jsonb
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    service_type,
    tracking_number,
    status,
    shipment_settings_override,
    metadata
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    'delivery',
    'RC-' || left(v_shipment::text, 8),
    'out_for_delivery',
    '{}'::jsonb,
    '{"source":"pgtap"}'::jsonb
  );

  SELECT created.route_run_id, created.stop_ids[1]
    INTO v_route_run_id, v_route_stop_id
  FROM public.create_route_run_v1(
    jsonb_build_object(
      'organization_id', v_org,
      'branch_id', v_branch,
      'driver_user_id', v_driver,
      'vehicle_id', v_vehicle,
      'idempotency_key', 'pgtap-route-closeout-' || left(gen_random_uuid()::text, 8),
      'stops', jsonb_build_array(
        jsonb_build_object(
          'client_id', v_client,
          'shipment_id', v_shipment,
          'stop_kind', 'delivery',
          'sequence_order', 1
        )
      )
    )
  ) AS created;

  UPDATE public.route_runs
     SET status = 'in_progress',
         started_at = now()
   WHERE id = v_route_run_id;

  SELECT created_task.task_id
    INTO v_task_id
  FROM public.create_task_system_v1(
    jsonb_build_object(
      'task_type_key', 'route_stop_execute',
      'context', jsonb_build_object('organization_id', v_org),
      'resource_type', 'route_stop',
      'resource_id', v_route_stop_id,
      'idempotency_key', 'pgtap-route-closeout-task-' || left(gen_random_uuid()::text, 8),
      'metadata', jsonb_build_object('source', 'pgtap', 'purpose', 'route-closeout')
    )
  ) AS created_task;

  RETURN QUERY
  SELECT v_org, v_driver, v_other_driver, v_route_run_id, v_route_stop_id, v_task_id;
END;
$function$;

CREATE TEMP TABLE route_closeout_fixture ON COMMIT DROP AS
SELECT * FROM pg_temp.seed_route_closeout_fixture();

CREATE OR REPLACE FUNCTION pg_temp.as_driver_close_route(
  p_actor UUID,
  p_task UUID,
  p_leftover_stop_count INT,
  p_leftover_notes TEXT,
  p_closeout_notes TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('role', 'authenticated', 'sub', p_actor::text)::text,
      true
    );

    SELECT public.ui_execute_command_v1(
      'tasks.close_route',
      'tasks',
      ARRAY[p_task::text],
      p_task::text,
      1,
      jsonb_build_object(
        'payload', jsonb_strip_nulls(
          jsonb_build_object(
            'vehicle_secured_ack', 'confirmed',
            'proofs_synced_ack', 'confirmed',
            'exceptions_reviewed_ack', 'confirmed',
            'leftover_stop_count', p_leftover_stop_count,
            'leftover_notes', p_leftover_notes,
            'closeout_notes', p_closeout_notes
          )
        )
      )
    )
    INTO v_result;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'SET LOCAL ROLE postgres';
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'postgres', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'postgres')::text, true);
    RAISE;
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'postgres')::text, true);

  RETURN v_result;
END;
$function$;

SELECT has_function(
  'public',
  'close_route_run_v1',
  ARRAY['jsonb'],
  'public.close_route_run_v1(jsonb) exists'
);

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
      FROM public.settings s,
           LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
      WHERE s.category = 'ui_command_registry'
        AND cmd->>'key' = 'tasks.close_route'
        AND cmd->>'capability' = 'tasks.complete'
        AND COALESCE(cmd->'execution'->>'payload_key', '') = 'payload'
        AND COALESCE(cmd->'execution'->'params'->>'handler', '') = 'route_closeout'
    )
  ),
  'tasks.close_route command is present with payload handler contract'
);

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
      FROM public.settings s,
           LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd,
           LATERAL jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
      WHERE s.category = 'ui_command_registry'
        AND cmd->>'key' = 'tasks.close_route'
        AND field->>'key' = 'leftover_stop_count'
        AND field->>'type' = 'number'
    )
  ),
  'tasks.close_route declares leftover_stop_count input schema'
);

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
      FROM public.settings s,
           LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd,
           LATERAL jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
      WHERE s.category = 'ui_command_registry'
        AND cmd->>'key' = 'tasks.close_route'
        AND field->>'key' = 'vehicle_secured_ack'
        AND COALESCE(field->>'default_value', '') = 'confirmed'
    )
  ),
  'tasks.close_route pre-fills checklist confirmations'
);

SELECT throws_ok(
  format(
    $$SELECT pg_temp.as_driver_close_route('%s'::uuid, '%s'::uuid, 0, NULL, 'bad count');$$,
    (SELECT driver_user_id::text FROM route_closeout_fixture),
    (SELECT task_id::text FROM route_closeout_fixture)
  ),
  '23514',
  'close_route_run_v1 leftover_stop_count mismatch: expected 1, got 0',
  'route closeout fails closed when leftover count does not match remaining stops'
);

SELECT throws_ok(
  format(
    $$SELECT pg_temp.as_driver_close_route('%s'::uuid, '%s'::uuid, 1, NULL, 'missing leftover note');$$,
    (SELECT driver_user_id::text FROM route_closeout_fixture),
    (SELECT task_id::text FROM route_closeout_fixture)
  ),
  '23514',
  'close_route_run_v1 leftover_notes is required when leftovers remain',
  'route closeout requires leftover notes when stops remain'
);

SELECT ok(
  (
    SELECT COALESCE((pg_temp.as_driver_close_route(driver_user_id, task_id, 1, 'One stop held at branch', 'Driver returned to branch with one leftover') -> 'items' -> 0 ->> 'remaining_stop_count')::int, -1)
    FROM route_closeout_fixture
  ) = 1,
  'route closeout returns the remaining stop count'
);

SELECT ok(
  (
    SELECT COALESCE((pg_temp.as_driver_close_route(driver_user_id, task_id, 1, 'One stop held at branch', 'Driver returned to branch with one leftover') -> 'items' -> 0 ->> 'route_run_status'), '')
    FROM route_closeout_fixture
  ) = 'in_progress',
  'route closeout preserves route_run status while stops remain'
);

SELECT ok(
  (
    SELECT COALESCE(route_runs.metadata->'route_closeout'->>'closeout_notes', '')
    FROM route_closeout_fixture fixture
    JOIN public.route_runs route_runs
      ON route_runs.id = fixture.route_run_id
  ) = 'Driver returned to branch with one leftover',
  'route_runs.metadata.route_closeout persists closeout notes'
);

SELECT ok(
  (
    SELECT COALESCE((route_runs.metadata->'route_closeout'->>'remaining_stop_count')::int, -1)
    FROM route_closeout_fixture fixture
    JOIN public.route_runs route_runs
      ON route_runs.id = fixture.route_run_id
  ) = 1,
  'route_runs.metadata.route_closeout persists remaining stop count'
);

SELECT ok(
  (
    SELECT COALESCE(route_runs.metadata->'route_closeout'->'checklist'->'vehicle_secured_ack'->>'status', '')
    FROM route_closeout_fixture fixture
    JOIN public.route_runs route_runs
      ON route_runs.id = fixture.route_run_id
  ) = 'confirmed',
  'route_runs.metadata.route_closeout persists checklist confirmations'
);

SELECT throws_ok(
  format(
    $$SELECT pg_temp.as_driver_close_route('%s'::uuid, '%s'::uuid, 1, 'One stop held at branch', 'Unauthorized actor');$$,
    (SELECT other_driver_user_id::text FROM route_closeout_fixture),
    (SELECT task_id::text FROM route_closeout_fixture)
  ),
  '42501',
  'close_route_run_v1 requires route ownership',
  'route closeout requires the route owner for tenant actors'
);

SELECT * FROM finish();
ROLLBACK;
