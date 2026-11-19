-- pgTAP: public.v_route_run_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W24 (paired projection views — OPERATIONS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

-- 1) View exists
SELECT has_view(
  'public', 'v_route_run_directory',
  'public.v_route_run_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_route_run_directory',
  ARRAY[
    'id', 'organization_id', 'branch_id', 'driver_user_id', 'vehicle_id',
    'status', 'planned_date', 'planned_start_at', 'planned_end_at',
    'started_at', 'ended_at', 'metadata', 'created_at', 'updated_at',
    -- Display alias
    'run_display_id',
    -- Branch projection
    'branch_label', 'branch_code', 'branch_type',
    -- Driver/vehicle projections
    'driver_label', 'vehicle_label',
    -- Counter projections
    'stop_count', 'cod_total',
    -- Assignment projections
    'assignment_id', 'assignment_status', 'assignment_mode',
    'assignment_version', 'assignment_assigned_at',
    'assignment_driver_user_id', 'assignment_vehicle_id',
    'partner_payload', 'partner_name', 'is_partner_run'
  ],
  'v_route_run_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_route_run_directory', 'SELECT'),
  'service_role has SELECT on v_route_run_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_route_run_directory', 'SELECT'),
  'anon has no SELECT on v_route_run_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_route_run_directory', 'SELECT'),
  'authenticated has SELECT on v_route_run_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'route_runs'
       AND c.relkind = 'r'
  ),
  'public.route_runs remains a base table (SSOT preserved)'
);

-- 7) Projection: insert run with branch + driver + assignment, verify joins.
CREATE FUNCTION pg_temp.test_route_run_directory_scope() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000024c000';
  v_client UUID := '00000000-0000-0000-0000-00000024c001';
  v_branch UUID := '00000000-0000-0000-0000-00000024c002';
  v_driver UUID := '00000000-0000-0000-0000-00000024c003';
  v_vehicle UUID := '00000000-0000-0000-0000-00000024c004';
  v_run UUID := '00000000-0000-0000-0000-00000024c005';
  v_stop UUID := '00000000-0000-0000-0000-00000024c006';
  v_shipment UUID := '00000000-0000-0000-0000-00000024c007';
  v_assignment UUID := '00000000-0000-0000-0000-00000024c008';
  v_branch_label TEXT;
  v_driver_label TEXT;
  v_vehicle_label TEXT;
  v_stop_count INT;
  v_cod_total NUMERIC;
  v_assign_status TEXT;
  v_is_partner BOOLEAN;
  v_run_display TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W24 Route Run Directory Org', 'w24-route-run-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'W24 Run Client', 'w24-run-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (
    id, organization_id, code, name, branch_type
  )
  VALUES (
    v_branch, v_org, 'w24-rrd', 'W24 RRD Branch', 'depot'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_driver, v_org, 'w24-driver@example.invalid',
    'W24 Test Driver', 'driver', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicles (
    id, organization_id, branch_id, status, plate_number
  )
  VALUES (
    v_vehicle, v_org, v_branch, 'active', 'W24 PLATE 024'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_runs (
    id, organization_id, branch_id, driver_user_id, vehicle_id,
    status, planned_date
  )
  VALUES (
    v_run, v_org, v_branch, v_driver, v_vehicle,
    'planned', CURRENT_DATE
  )
  ON CONFLICT (id) DO NOTHING;

  -- Insert a shipment + stop so the cod_total + stop_count derive.
  INSERT INTO public.shipments (
    id, organization_id, client_id,
    service_type, tracking_number, box_count,
    cod_amount, cod_currency, status
  )
  VALUES (
    v_shipment, v_org, v_client,
    'delivery', 'W24-RRD-S-024', 1,
    250.00, 'SAR', 'created'
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

  INSERT INTO public.route_run_assignments (
    id, organization_id, route_run_id,
    assignment_status, assignment_mode,
    driver_user_id, vehicle_id
  )
  VALUES (
    v_assignment, v_org, v_run,
    'assigned', 'internal_driver',
    v_driver, v_vehicle
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT
    branch_label, driver_label, vehicle_label,
    stop_count, cod_total, assignment_status, is_partner_run, run_display_id
  INTO
    v_branch_label, v_driver_label, v_vehicle_label,
    v_stop_count, v_cod_total, v_assign_status, v_is_partner, v_run_display
  FROM public.v_route_run_directory
  WHERE id = v_run;

  RETURN NEXT ok(
    v_branch_label = (SELECT code || ' ' || chr(183) || ' ' || name FROM public.branches WHERE id = v_branch)
      AND v_driver_label = 'W24 Test Driver'
      AND v_vehicle_label = 'W24 PLATE 024'
      AND v_stop_count = 1
      AND v_cod_total = 250.00
      AND v_assign_status = 'assigned'
      AND v_is_partner = FALSE
      AND v_run_display LIKE 'RUN-%',
    'v_route_run_directory projects branch_label + driver_label + vehicle_label + stop_count + cod_total + assignment_status + is_partner_run + run_display_id'
  );
END;
$$;
SELECT * FROM pg_temp.test_route_run_directory_scope();

-- 8) Negative path: partner_fleet assignment populates partner_name and flips
-- is_partner_run; refused assignments are excluded from the active row.
CREATE FUNCTION pg_temp.test_route_run_directory_rollup() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000024d000';
  v_responder UUID := '00000000-0000-0000-0000-00000024d004';
  v_run UUID := '00000000-0000-0000-0000-00000024d001';
  v_alt_run UUID := '00000000-0000-0000-0000-00000024d006';
  v_refused_run UUID := '00000000-0000-0000-0000-00000024d005';
  v_assignment UUID := '00000000-0000-0000-0000-00000024d002';
  v_alt_assignment UUID := '00000000-0000-0000-0000-00000024d007';
  v_refused UUID := '00000000-0000-0000-0000-00000024d003';
  v_refused_assignment_id UUID;
  v_partner_name TEXT;
  v_is_partner BOOLEAN;
  v_assign_mode TEXT;
  v_alt_partner_name TEXT;
  v_alt_is_partner BOOLEAN;
  v_alt_assign_mode TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W24 Partner Run Org', 'w24-partner-run-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_runs (
    id, organization_id, status, planned_date
  )
  VALUES
    (v_run, v_org, 'planned', CURRENT_DATE),
    (v_alt_run, v_org, 'planned', CURRENT_DATE),
    (v_refused_run, v_org, 'planned', CURRENT_DATE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_responder, v_org, 'w24-responder@example.invalid',
    'W24 Assignment Responder', 'dispatcher', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Newer refused assignment (must be excluded from the active row).
  INSERT INTO public.route_run_assignments (
    id, organization_id, route_run_id,
    assignment_status, assignment_mode, partner,
    assignment_version, assigned_at,
    responded_by_user_id, refused_at, refusal_reason
  )
  VALUES (
    v_refused, v_org, v_refused_run,
    'refused', 'partner_fleet',
    '{"partner_id":"prt_old","partner_name":"Old Partner"}'::jsonb,
    3, now() - INTERVAL '2 hour',
    v_responder, now() - INTERVAL '90 minute', 'capacity unavailable'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Active partner_fleet assignment.
  INSERT INTO public.route_run_assignments (
    id, organization_id, route_run_id,
    assignment_status, assignment_mode, partner,
    assignment_version, assigned_at
  )
  VALUES (
    v_assignment, v_org, v_run,
    'assigned', 'partner_fleet',
    '{"partner_id":"prt_w24","partner_name":"W24 Logistics Co"}'::jsonb,
    2, now() - INTERVAL '5 minute'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Active alternate_capacity_pool assignment should also derive partner
  -- ownership from lookup_values metadata, not a partner_fleet literal.
  INSERT INTO public.route_run_assignments (
    id, organization_id, route_run_id,
    assignment_status, assignment_mode, partner,
    assignment_version, assigned_at
  )
  VALUES (
    v_alt_assignment, v_org, v_alt_run,
    'assigned', 'alternate_capacity_pool',
    '{"partner_id":"prt_w24_alt","partner_name":"W24 Overflow Pool"}'::jsonb,
    1, now() - INTERVAL '3 minute'
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT partner_name, is_partner_run, assignment_mode
    INTO v_partner_name, v_is_partner, v_assign_mode
    FROM public.v_route_run_directory
   WHERE id = v_run;

  SELECT partner_name, is_partner_run, assignment_mode
    INTO v_alt_partner_name, v_alt_is_partner, v_alt_assign_mode
    FROM public.v_route_run_directory
   WHERE id = v_alt_run;

  SELECT assignment_id
    INTO v_refused_assignment_id
    FROM public.v_route_run_directory
   WHERE id = v_refused_run;

  RETURN NEXT ok(
    v_partner_name = 'W24 Logistics Co'
      AND v_is_partner = TRUE
      AND v_assign_mode = 'partner_fleet'
      AND v_refused_assignment_id IS NULL,
    'v_route_run_directory excludes refused assignments and projects partner_name + is_partner_run for partner_fleet'
  );

  RETURN NEXT ok(
    v_alt_partner_name = 'W24 Overflow Pool'
      AND v_alt_is_partner = TRUE
      AND v_alt_assign_mode = 'alternate_capacity_pool',
    'v_route_run_directory derives is_partner_run for the alternate capacity assignment'
  );
END;
$$;
SELECT * FROM pg_temp.test_route_run_directory_rollup();

SELECT * FROM finish();
ROLLBACK;
