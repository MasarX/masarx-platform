-- Plan: PLAN-202604-b06-uc073-route-plan-constraints / Step: S01
-- pgTAP: Route plan constraint guards v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

CREATE OR REPLACE FUNCTION pg_temp.test_route_plan_constraint_guards_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_planner_user UUID := gen_random_uuid();
  v_driver_user UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_vehicle_type UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();

  v_shipment_1 UUID := gen_random_uuid();
  v_shipment_2 UUID := gen_random_uuid();
  v_shipment_3 UUID := gen_random_uuid();
  v_shipment_4 UUID := gen_random_uuid();

  v_plan_valid RECORD;
  v_plan_invalid_skill RECORD;
  v_plan_invalid_capacity RECORD;
  v_frozen_valid RECORD;

  v_workflow_start JSONB := '{}'::jsonb;
  v_workflow_run_id UUID := NULL;
  v_workflow_status TEXT := NULL;
  v_iter INT := 0;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'route_plan_constraint_policy_default_v1',
    ARRAY[]::text[],
    'public.route_plan_constraint_policy_default_v1() exists'
  );
  RETURN NEXT has_function(
    'public',
    'route_plan_validate_constraints_v1',
    ARRAY['uuid'],
    'public.route_plan_validate_constraints_v1(uuid) exists'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings_category_registry
      WHERE category = 'route_plan_constraint_policy'
    ),
    'settings_category_registry exposes route_plan_constraint_policy'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.schema_registry
      WHERE category = 'route_plan_constraint_policy'
        AND version = 1
    ),
    'schema_registry exposes route_plan_constraint_policy v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings
      WHERE category = 'route_plan_constraint_policy'
        AND scope_type = 'global'
        AND scope_id IS NULL
    ),
    'global route_plan_constraint_policy default exists'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Plan Constraint Org', 'route-plan-constraints-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'rpc-' || left(v_branch::text, 8), 'Route Plan Constraint Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_planner_user, v_org, 'planner-' || left(v_planner_user::text, 8) || '@example.com', 'Route Planner', 'ops_admin', 'active', 'tenant'),
    (v_driver_user, v_org, 'driver-' || left(v_driver_user::text, 8) || '@example.com', 'Constraint Driver', 'driver', 'active', 'tenant');

  INSERT INTO public.driver_profiles (organization_id, user_id, driver_code, status, metadata)
  VALUES (
    v_org,
    v_driver_user,
    'drv-' || left(v_driver_user::text, 6),
    'active',
    jsonb_build_object(
      'route_planning', jsonb_build_object(
        'skill_keys', jsonb_build_array('hazmat', 'cold_chain')
      )
    )
  );

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Route Plan Constraint Client', 'route-plan-constraint-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Route Plan Constraint Sender', 'Route Plan Constraint Sender', TRUE, 'active');

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active, metadata)
  VALUES (
    v_vehicle_type,
    v_org,
    'constraint-van',
    'Constraint Van',
    TRUE,
    jsonb_build_object(
      'route', jsonb_build_object(
        'capacity', jsonb_build_object(
          'weight_kg', 100,
          'shipments', 10
        )
      ),
      'route_planning', jsonb_build_object(
        'skill_keys', jsonb_build_array('refrigerated')
      )
    )
  );

  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active, metadata)
  VALUES (
    v_vehicle,
    v_org,
    v_branch,
    v_vehicle_type,
    'UC073-' || upper(left(replace(v_vehicle::text, '-', ''), 6)),
    'active',
    TRUE,
    jsonb_build_object(
      'skill_keys', jsonb_build_array('fragile')
    )
  );

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES
    (v_shipment_1, v_org, v_client, v_sender, 'delivery', 'uc073-' || left(v_shipment_1::text, 8), 'created'),
    (v_shipment_2, v_org, v_client, v_sender, 'delivery', 'uc073-' || left(v_shipment_2::text, 8), 'created'),
    (v_shipment_3, v_org, v_client, v_sender, 'delivery', 'uc073-' || left(v_shipment_3::text, 8), 'created'),
    (v_shipment_4, v_org, v_client, v_sender, 'delivery', 'uc073-' || left(v_shipment_4::text, 8), 'created');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_plan_valid
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'requested_by_user_id', v_planner_user,
        'planned_date', DATE '2026-04-06',
        'idempotency_key', 'pgtap-uc073-valid',
        'constraints', jsonb_build_object(
          'required_driver_skill_keys', jsonb_build_array('hazmat'),
          'required_vehicle_skill_keys', jsonb_build_array('refrigerated'),
          'capacity_demand', jsonb_build_object('weight_kg', 40),
          'enforce_stop_count_capacity', TRUE
        ),
        'solution', jsonb_build_object(
          'vehicle_id', v_vehicle,
          'driver_user_id', v_driver_user,
          'stops', jsonb_build_array(
            jsonb_build_object(
              'client_id', v_client,
              'shipment_id', v_shipment_1,
              'stop_kind', 'delivery',
              'sequence_order', 1,
              'metadata', jsonb_build_object(
                'required_driver_skill_keys', jsonb_build_array('cold_chain'),
                'required_vehicle_skill_keys', jsonb_build_array('fragile'),
                'capacity_demand', jsonb_build_object('weight_kg', 12)
              )
            ),
            jsonb_build_object(
              'client_id', v_client,
              'shipment_id', v_shipment_2,
              'stop_kind', 'delivery',
              'sequence_order', 2,
              'metadata', jsonb_build_object(
                'capacity_demand', jsonb_build_object('weight_kg', 8)
              )
            )
          )
        )
      )
    )
    LIMIT 1;

  SELECT *
    INTO v_frozen_valid
    FROM public.freeze_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan_valid.route_plan_id,
        'actor_user_id', v_planner_user,
        'idempotency_key', 'pgtap-uc073-valid-freeze'
      )
    )
    LIMIT 1;

  RETURN NEXT is(v_frozen_valid.status, 'frozen', 'freeze_route_plan_v1 accepts a route plan that satisfies declared constraints');
  RETURN NEXT ok(
    COALESCE(
      (
        SELECT (metadata->'constraint_validation'->>'valid')::boolean
        FROM public.route_plans
        WHERE id = v_plan_valid.route_plan_id
      ),
      FALSE
    ),
    'frozen route_plan stores a successful constraint_validation report'
  );
  RETURN NEXT ok(
    (
      SELECT COALESCE(metadata->'constraint_validation'->'required_driver_skill_keys', '[]'::jsonb)
      FROM public.route_plans
      WHERE id = v_plan_valid.route_plan_id
    ) @> '["cold_chain"]'::jsonb,
    'constraint_validation aggregates stop-level driver skill requirements'
  );
  RETURN NEXT is(
    (
      SELECT metadata->'constraint_validation'->'capacity_demand'->>'weight_kg'
      FROM public.route_plans
      WHERE id = v_plan_valid.route_plan_id
    ),
    '60',
    'constraint_validation aggregates plan and stop capacity demand'
  );
  RETURN NEXT is(
    (
      SELECT metadata->'constraint_validation'->'capacity_demand'->>'shipments'
      FROM public.route_plans
      WHERE id = v_plan_valid.route_plan_id
    ),
    '2',
    'constraint_validation applies stop-count capacity demand when enabled'
  );

  SELECT *
    INTO v_plan_invalid_skill
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'requested_by_user_id', v_planner_user,
        'planned_date', DATE '2026-04-07',
        'idempotency_key', 'pgtap-uc073-invalid-skill',
        'constraints', jsonb_build_object(
          'required_driver_skill_keys', jsonb_build_array('cash_collection')
        ),
        'solution', jsonb_build_object(
          'vehicle_id', v_vehicle,
          'driver_user_id', v_driver_user,
          'stops', jsonb_build_array(
            jsonb_build_object(
              'client_id', v_client,
              'shipment_id', v_shipment_3,
              'stop_kind', 'delivery',
              'sequence_order', 1
            )
          )
        )
      )
    )
    LIMIT 1;

  BEGIN
    PERFORM 1
    FROM public.freeze_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan_invalid_skill.route_plan_id,
        'actor_user_id', v_planner_user,
        'idempotency_key', 'pgtap-uc073-invalid-skill-freeze'
      )
    );
    RETURN NEXT fail('freeze_route_plan_v1 rejects missing driver skills');
  EXCEPTION
    WHEN others THEN
      RETURN NEXT matches(
        SQLERRM,
        '.*missing required skill keys.*',
        'freeze_route_plan_v1 rejects missing driver skills'
      );
  END;

  SELECT *
    INTO v_plan_invalid_capacity
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'requested_by_user_id', v_planner_user,
        'planned_date', DATE '2026-04-08',
        'idempotency_key', 'pgtap-uc073-invalid-capacity',
        'constraints', jsonb_build_object(
          'capacity_demand', jsonb_build_object('weight_kg', 150)
        ),
        'solution', jsonb_build_object(
          'vehicle_id', v_vehicle,
          'driver_user_id', v_driver_user,
          'stops', jsonb_build_array(
            jsonb_build_object(
              'client_id', v_client,
              'shipment_id', v_shipment_4,
              'stop_kind', 'delivery',
              'sequence_order', 1
            )
          )
        )
      )
    )
    LIMIT 1;

  BEGIN
    PERFORM 1
    FROM public.freeze_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan_invalid_capacity.route_plan_id,
        'actor_user_id', v_planner_user,
        'idempotency_key', 'pgtap-uc073-invalid-capacity-freeze'
      )
    );
    RETURN NEXT fail('freeze_route_plan_v1 rejects capacity overflow');
  EXCEPTION
    WHEN others THEN
      RETURN NEXT matches(
        SQLERRM,
        '.*capacity.*below required demand.*',
        'freeze_route_plan_v1 rejects capacity overflow'
      );
  END;

  EXECUTE 'SET LOCAL ROLE postgres';

  UPDATE public.vehicles
     SET metadata = jsonb_build_object(
       'skill_keys', jsonb_build_array('fragile'),
       'route', jsonb_build_object(
         'capacity', jsonb_build_object('weight_kg', 20)
       )
     )
   WHERE id = v_vehicle;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  BEGIN
    PERFORM 1
    FROM public.apply_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_plan_valid.route_plan_id,
        'actor_user_id', v_planner_user,
        'idempotency_key', 'pgtap-uc073-apply-should-fail'
      )
    );
    RETURN NEXT fail('apply_route_plan_v1 revalidates frozen plans before route_run materialization');
  EXCEPTION
    WHEN others THEN
      RETURN NEXT matches(
        SQLERRM,
        '.*constraint validation failed.*below required demand.*',
        'apply_route_plan_v1 revalidates frozen plans before route_run materialization'
      );
  END;

  SELECT public.start_route_plan_apply_workflow_v1(
    jsonb_build_object(
      'route_plan_id', v_plan_valid.route_plan_id,
      'actor_user_id', v_planner_user,
      'idempotency_key', 'pgtap-uc073-apply-workflow'
    )
  )
    INTO v_workflow_start;

  BEGIN
    v_workflow_run_id := NULLIF(v_workflow_start->>'workflow_run_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_workflow_run_id := NULL;
  END;

  RETURN NEXT ok(v_workflow_run_id IS NOT NULL, 'start_route_plan_apply_workflow_v1 returns a workflow_run_id for the constrained route plan');

  FOR v_iter IN 1..10 LOOP
    PERFORM public.progress_workflow_run(v_workflow_run_id);

    SELECT workflow_status
      INTO v_workflow_status
      FROM public.workflow_runs
     WHERE id = v_workflow_run_id;

    EXIT WHEN v_workflow_status IN ('completed', 'failed', 'cancelled');
  END LOOP;

  RETURN NEXT is(COALESCE(v_workflow_status, ''), 'failed', 'route_plan_apply workflow fails closed when a frozen plan becomes invalid');
  RETURN NEXT is(
    (
      SELECT COUNT(*)::int
      FROM public.route_runs
      WHERE route_plan_id = v_plan_valid.route_plan_id
    ),
    0,
    'failed workflow apply does not materialize a route_run'
  );
  RETURN NEXT is(
    (
      SELECT status
      FROM public.route_plans
      WHERE id = v_plan_valid.route_plan_id
    ),
    'frozen',
    'failed workflow apply leaves the route_plan frozen'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_route_plan_constraint_guards_v1();

SELECT * FROM finish();
ROLLBACK;
