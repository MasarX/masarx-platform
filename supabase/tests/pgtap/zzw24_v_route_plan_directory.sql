-- pgTAP: public.v_route_plan_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W24 (paired projection views — OPERATIONS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

-- 1) View exists
SELECT has_view(
  'public', 'v_route_plan_directory',
  'public.v_route_plan_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_route_plan_directory',
  ARRAY[
    'id', 'organization_id', 'branch_id', 'planned_date',
    'status', 'status_reason',
    'requested_by_user_id', 'requested_at', 'solved_at', 'applied_at',
    'idempotency_key', 'version', 'metadata',
    'created_at', 'updated_at',
    -- Display alias
    'plan_display_id',
    -- Branch projections
    'branch_label', 'branch_code',
    -- Wave projections
    'wave_label', 'wave_key',
    -- Counter projections
    'run_count', 'stop_count', 'drivers_notified_count',
    -- Derived applied flag
    'is_applied'
  ],
  'v_route_plan_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_route_plan_directory', 'SELECT'),
  'service_role has SELECT on v_route_plan_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_route_plan_directory', 'SELECT'),
  'anon has no SELECT on v_route_plan_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_route_plan_directory', 'SELECT'),
  'authenticated has SELECT on v_route_plan_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'route_plans'
       AND c.relkind = 'r'
  ),
  'public.route_plans remains a base table (SSOT preserved)'
);

-- 7) Projection: insert plan with branch + run + stop, verify counters resolve.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000024e000';
  v_client UUID := '00000000-0000-0000-0000-00000024e001';
  v_branch UUID := '00000000-0000-0000-0000-00000024e002';
  v_plan UUID := '00000000-0000-0000-0000-00000024e003';
  v_run UUID := '00000000-0000-0000-0000-00000024e004';
  v_stop UUID := '00000000-0000-0000-0000-00000024e005';
  v_shipment UUID := '00000000-0000-0000-0000-00000024e006';
  v_branch_label TEXT;
  v_branch_code TEXT;
  v_wave_label TEXT;
  v_run_count INT;
  v_stop_count INT;
  v_is_applied BOOLEAN;
  v_plan_display TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W24 Route Plan Directory Org', 'w24-route-plan-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'W24 Plan Client', 'w24-plan-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (
    id, organization_id, code, name, branch_type
  )
  VALUES (
    v_branch, v_org, 'w24-rpd', 'W24 RPD Branch', 'depot'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_plans (
    id, organization_id, branch_id, planned_date,
    status, metadata
  )
  VALUES (
    v_plan, v_org, v_branch, CURRENT_DATE,
    'solved',
    '{"wave_label":"W24 · Wave 1","wave":"wave_morning"}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_runs (
    id, organization_id, branch_id, route_plan_id,
    status, planned_date
  )
  VALUES (
    v_run, v_org, v_branch, v_plan,
    'planned', CURRENT_DATE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id,
    service_type, tracking_number, box_count, status
  )
  VALUES (
    v_shipment, v_org, v_client,
    'delivery', 'W24-RPD-S-024', 1, 'created'
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  INSERT INTO public.route_stops (
    id, organization_id, route_run_id, client_id, shipment_id,
    stop_kind, sequence_order
  )
  VALUES (
    v_stop, v_org, v_run, v_client, v_shipment,
    'delivery', 1
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT
    branch_label, branch_code, wave_label,
    run_count, stop_count, is_applied, plan_display_id
  INTO
    v_branch_label, v_branch_code, v_wave_label,
    v_run_count, v_stop_count, v_is_applied, v_plan_display
  FROM public.v_route_plan_directory
  WHERE id = v_plan;

  PERFORM ok(
    v_branch_label = 'W24 RPD Branch'
      AND v_branch_code = 'w24-rpd'
      AND v_wave_label = 'W24 · Wave 1'
      AND v_run_count = 1
      AND v_stop_count = 1
      AND v_is_applied = FALSE
      AND v_plan_display LIKE 'PLN-%',
    'v_route_plan_directory projects branch_label + branch_code + wave_label + run_count + stop_count + is_applied + plan_display_id'
  );
END;
$$;

-- 8) Projection: planned route-plan inputs.stops count before route_runs exist.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000024d000';
  v_client UUID := '00000000-0000-0000-0000-00000024d001';
  v_branch UUID := '00000000-0000-0000-0000-00000024d002';
  v_plan UUID := '00000000-0000-0000-0000-00000024d003';
  v_shipment_a UUID := '00000000-0000-0000-0000-00000024d004';
  v_shipment_b UUID := '00000000-0000-0000-0000-00000024d005';
  v_run_count INT;
  v_stop_count INT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W24 Planned Stops Org', 'w24-planned-stops-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'W24 Planned Stops Client', 'w24-planned-stops-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, branch_type)
  VALUES (v_branch, v_org, 'w24-planned', 'W24 Planned Stops Branch', 'depot')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id,
    service_type, tracking_number, box_count, status
  )
  VALUES
    (v_shipment_a, v_org, v_client, 'delivery', 'W24-PLN-A', 1, 'created'),
    (v_shipment_b, v_org, v_client, 'delivery', 'W24-PLN-B', 1, 'created')
  ON CONFLICT (id, client_id) DO NOTHING;

  INSERT INTO public.route_plans (
    id, organization_id, branch_id, planned_date,
    status, inputs, metadata
  )
  VALUES (
    v_plan, v_org, v_branch, CURRENT_DATE,
    'created',
    jsonb_build_object(
      'wave_id', 'wave_morning',
      'wave_label', 'Morning',
      'stops', jsonb_build_array(
        jsonb_build_object('shipment_id', v_shipment_a, 'client_id', v_client, 'sequence_order', 1),
        jsonb_build_object('shipment_id', v_shipment_b, 'client_id', v_client, 'sequence_order', 2)
      )
    ),
    '{"source":"pgtap.planned_stops"}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT run_count, stop_count
    INTO v_run_count, v_stop_count
    FROM public.v_route_plan_directory
   WHERE id = v_plan;

  PERFORM ok(
    v_run_count = 0
      AND v_stop_count = 2,
    'v_route_plan_directory counts route_plans.inputs.stops before route_runs are materialized'
  );
END;
$$;

-- 9) Negative path: applied_at populated flips is_applied to TRUE; drivers_notified_count
-- counts DISTINCT actor_user_id on driver_notified events.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000024f000';
  v_branch UUID := '00000000-0000-0000-0000-00000024f001';
  v_user_a UUID := '00000000-0000-0000-0000-00000024f002';
  v_user_b UUID := '00000000-0000-0000-0000-00000024f003';
  v_plan UUID := '00000000-0000-0000-0000-00000024f004';
  v_is_applied BOOLEAN;
  v_drivers_notified INT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W24 Applied Plan Org', 'w24-applied-plan-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES
    (v_user_a, v_org, 'w24-driver-a@example.invalid',
     'W24 Driver A', 'driver', 'active'),
    (v_user_b, v_org, 'w24-driver-b@example.invalid',
     'W24 Driver B', 'driver', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (
    id, organization_id, code, name
  )
  VALUES (
    v_branch, v_org, 'w24-applied-rpd', 'W24 Applied Branch'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_plans (
    id, organization_id, branch_id, planned_date,
    status, applied_at
  )
  VALUES (
    v_plan, v_org, v_branch, CURRENT_DATE,
    'applied', now()
  )
  ON CONFLICT (id) DO NOTHING;

  -- Two distinct drivers notified, with one duplicate event for driver A.
  INSERT INTO public.route_plan_events (
    route_plan_id, organization_id, event_type,
    actor_user_id, plan_version
  )
  VALUES
    (v_plan, v_org, 'driver_notified', v_user_a, 1),
    (v_plan, v_org, 'driver_notified', v_user_b, 1),
    (v_plan, v_org, 'driver_notified', v_user_a, 2);  -- duplicate counted once

  SELECT is_applied, drivers_notified_count
    INTO v_is_applied, v_drivers_notified
    FROM public.v_route_plan_directory
   WHERE id = v_plan;

  PERFORM ok(
    v_is_applied = TRUE
      AND v_drivers_notified = 2,
    'v_route_plan_directory derives is_applied (applied_at IS NOT NULL) and drivers_notified_count (DISTINCT actor_user_id over driver_notified events)'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
