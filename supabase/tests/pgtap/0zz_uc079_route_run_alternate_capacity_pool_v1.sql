-- pgTAP: UC079 route run alternate capacity pool write path

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(23);

CREATE OR REPLACE FUNCTION pg_temp.test_uc079_route_run_alternate_capacity_pool_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_commands JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_supplier_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_route RECORD;
  v_request_id UUID := gen_random_uuid();
  v_assign_result JSONB := NULL;
  v_replay_result JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_commands
    FROM public.settings
   WHERE category = 'ui_command_registry'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_function('public', 'route_assignment_policy_default_v1', ARRAY[]::TEXT[], 'public.route_assignment_policy_default_v1 exists');
  RETURN NEXT has_function('public', 'route_assignment_policy_resolve_v1', ARRAY['jsonb'], 'public.route_assignment_policy_resolve_v1 exists');
  RETURN NEXT has_function('public', 'route_run_resolve_alternate_capacity_v1', ARRAY['uuid'], 'public.route_run_resolve_alternate_capacity_v1 exists');
  RETURN NEXT is(public.route_assignment_policy_default_v1()#>>'{alternate_capacity,enabled}', 'false',
    'automatic capacity is disabled in the SQL default');
  RETURN NEXT is((SELECT examples FROM public.schema_registry
    WHERE category = 'route_assignment_policy' AND version = 1),
    jsonb_build_array(public.route_assignment_policy_default_v1()),
    'the settings editor example uses the disabled SQL default');
  RETURN NEXT is((SELECT cached_value#>>'{alternate_capacity,enabled}' FROM public.settings
    WHERE category = 'route_assignment_policy' AND scope_type = 'global' AND scope_id IS NULL), 'false',
    'the published global setting is disabled');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_values lv
        JOIN public.lookup_definitions ld
          ON ld.id = lv.lookup_definition_id
       WHERE ld.category = 'route_assignment_mode'
         AND lv.value = 'alternate_capacity_pool'
    ),
    'route_assignment_mode lookup includes alternate_capacity_pool'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.settings s
       WHERE s.category = 'route_assignment_policy'
         AND s.scope_type = 'global'
         AND s.scope_id IS NULL
    ),
    'route_assignment_policy global settings row exists'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(item.value#>'{input_schema,fields}', '[]'::jsonb)) AS field(value)
       WHERE item.value->>'key' = 'routes.assign'
         AND field.value->>'key' = 'assignment_mode'
         AND field.value->>'default_value' = 'internal_driver'
    ),
    'ui_command_registry exposes assignment_mode field for routes.assign'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(item.value#>'{input_schema,fields}', '[]'::jsonb)) AS field(value)
       WHERE item.value->>'key' = 'routes.reassign'
         AND field.value->>'key' = 'assignment_mode'
         AND field.value->>'placeholder' = 'internal_driver | partner_fleet | alternate_capacity_pool'
    ),
    'ui_command_registry exposes alternate-capacity guidance for routes.reassign'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(item.value#>'{input_schema,fields}', '[]'::jsonb)) AS field(value)
       WHERE item.value->>'key' = 'routes.reassign'
         AND field.value->>'key' = 'reassignment_reason'
         AND COALESCE((field.value->>'required')::boolean, FALSE)
    ),
    'ui_command_registry keeps reassignment_reason required on routes.reassign'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'UC079 pgTap Org', 'uc079-pgtap-' || left(v_org::text, 8)),
    (v_supplier_org, 'UC079 pgTap Supplier', 'uc079-supplier-' || left(v_supplier_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'uc079', 'UC079 Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'UC079 Client', 'uc079-client-' || left(v_client::text, 8), 'active');

  -- Simulate a client policy materialized before onboarding exclusions.
  PERFORM public.upsert_settings_value_v1(
    'route_assignment_policy', 'client', v_client, '{"alternate_capacity":{"enabled":false}}'::jsonb,
    1, 'Seed legacy materialized client policy'
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (v_operator, v_org, 'uc079-ops-' || left(v_operator::text, 8) || '@example.com', 'UC079 Ops', 'ops_admin', 'active', 'tenant');

  INSERT INTO public.shipments (organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_org, v_client, 'UC079-PGTAP-1', 'delivery', 'pending'),
    (v_org, v_client, 'UC079-PGTAP-2', 'delivery', 'pending');

  SELECT *
    INTO v_route
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'stops', (
          SELECT jsonb_agg(
            jsonb_build_object(
              'client_id', s.client_id,
              'shipment_id', s.id,
              'stop_kind', 'delivery',
              'sequence_order', s.sequence_order
            )
            ORDER BY s.sequence_order
          )
          FROM (
            SELECT
              id,
              client_id,
              row_number() OVER (ORDER BY created_at, id) AS sequence_order
            FROM public.shipments
            WHERE organization_id = v_org
          ) s
        )
      )
    )
   LIMIT 1;

  INSERT INTO public.marketplace_requests (
    id,
    requester_organization_id,
    request_kind_key,
    status,
    release_state,
    title,
    request_details,
    private_pool,
    metadata,
    decision_metadata
  )
  VALUES (
    v_request_id,
    v_org,
    'capacity_block',
    'published',
    'private_pool',
    'UC079 pgTap capacity block',
    '{}'::jsonb,
    jsonb_build_array(v_supplier_org),
    '{}'::jsonb,
    '{}'::jsonb
  );

  UPDATE public.route_runs
     SET metadata = jsonb_set(
       COALESCE(metadata, '{}'::jsonb),
       '{alternate_capacity}',
       jsonb_build_object(
         'demand_class', 'express',
         'marketplace_request_id', v_request_id
       ),
       true
     )
   WHERE id = v_route.route_run_id;

  PERFORM public.upsert_settings_value_v1(
    'route_assignment_policy', 'global', NULL, '{"alternate_capacity":{"enabled":true}}'::jsonb,
    1, 'Exercise a legacy global setting'
  );
  RETURN NEXT is((SELECT value#>>'{alternate_capacity,enabled}'
    FROM public.route_assignment_policy_resolve_v1(jsonb_build_object('organization_id', v_org))), 'false',
    'a legacy global opt-in cannot enable automatic capacity');

  PERFORM public.upsert_settings_value_v1(
    'route_assignment_policy', 'tenant', v_org, '{"alternate_capacity":{"enabled":true}}'::jsonb,
    1, 'Opt the synthetic tenant into automatic capacity'
  );
  RETURN NEXT is((SELECT value#>>'{alternate_capacity,enabled}'
    FROM public.route_assignment_policy_resolve_v1(jsonb_build_object('organization_id', v_org))), 'true',
    'an explicit tenant setting enables automatic capacity');
  RETURN NEXT is((SELECT value#>>'{alternate_capacity,enabled}'
    FROM public.route_assignment_policy_resolve_v1(jsonb_build_object('organization_id', v_supplier_org))), 'false',
    'another tenant cannot inherit the explicit opt-in');

  RETURN NEXT is(
    (SELECT jsonb_build_array(scope_type, scope_id, value#>'{alternate_capacity,enabled}')
       FROM public.route_assignment_policy_resolve_v1(
         jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'resource_id', v_branch)
       )),
    jsonb_build_array('client', v_client, false),
    'the client onboarding default wins over a later tenant opt-in'
  );
  PERFORM public.upsert_settings_value_v1(
    'route_assignment_policy', 'client', v_client, '{"alternate_capacity":{"enabled":true}}'::jsonb,
    1, 'Opt the synthetic route client into automatic capacity'
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_assign_result := api.ui_execute_route_run_assign_v1(
    'routes.assign',
    'routes',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'use_alternate_capacity', true,
      'idempotency_key', 'uc079-pgtap-assign-1'
    )
  );

  RETURN NEXT is(v_assign_result->>'status', 'assigned', 'alternate capacity ui RPC reports assigned');
  RETURN NEXT is((v_assign_result#>>'{items,0,assignment_mode}'), 'alternate_capacity_pool', 'alternate capacity assignment returns alternate_capacity_pool mode');
  RETURN NEXT is((v_assign_result#>>'{items,0,partner,source_type}'), 'marketplace_private_pool', 'alternate capacity partner source is marketplace_private_pool');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT assignment_mode FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id), 'alternate_capacity_pool', 'projection stores alternate capacity mode');
  RETURN NEXT is(
    (SELECT partner->>'partner_id' FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id),
    v_supplier_org::text,
    'projection stores supplier organization as partner'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
      FROM public.tasks t
      JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE tt.organization_id = v_org
        AND tt.key = 'route_stop_execute'
        AND t.assigned_to IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.route_stops rs
          WHERE rs.id = t.resource_id
            AND rs.route_run_id = v_route.route_run_id
        )
    ),
    '0',
    'alternate capacity assignments leave route_stop_execute tasks unassigned'
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_replay_result := api.ui_execute_route_run_assign_v1(
    'routes.assign',
    'routes',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'use_alternate_capacity', true,
      'idempotency_key', 'uc079-pgtap-assign-1'
    )
  );

  RETURN NEXT is((v_replay_result#>>'{items,0,created}'), 'false', 'alternate capacity idempotency replay returns created=false');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT COUNT(*)::text FROM public.route_run_assignment_events WHERE route_run_id = v_route.route_run_id),
    '1',
    'alternate capacity idempotency replay does not create a second assignment event'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_uc079_route_run_alternate_capacity_pool_v1();

SELECT * FROM finish();

ROLLBACK;
