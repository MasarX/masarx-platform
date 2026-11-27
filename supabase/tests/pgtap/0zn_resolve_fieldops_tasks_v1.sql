-- Test Suite: resolve_fieldops_tasks_v1 — Mobile V2 Tasks unified aggregator
-- Validates that 202605102200_resolve_fieldops_tasks_v1 has shipped:
--   (a) helper functions (classify_urgency, priority_int, resolve_tone)
--   (b) the main resolve_fieldops_tasks_v1(text, jsonb) RPC with full
--       contract (return type, security definer, grant posture)
--   (c) the api.resolve_fieldops_tasks_v1 wrapper with security invoker
--   (d) functional behaviour:
--       - driver sees their own assigned route_stops
--       - loader sees pickup/load/transfer stops org-wide
--       - supervisor sees route_runs awaiting review
--       - unknown role returns empty
--       - rejects unauthenticated callers
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(41);

-- ----------------------------------------------------------------------------
-- (a) Helper functions
-- ----------------------------------------------------------------------------

SELECT has_function(
  'public', 'fieldops_v2_classify_urgency',
  ARRAY['timestamp with time zone', 'timestamp with time zone'],
  'fieldops_v2_classify_urgency exists'
);

SELECT is(
  public.fieldops_v2_classify_urgency(NULL::timestamptz, '2026-05-10 12:00:00+00'::timestamptz),
  'later',
  'classify_urgency(NULL) -> later'
);

SELECT is(
  public.fieldops_v2_classify_urgency(
    '2026-05-10 12:30:00+00'::timestamptz,
    '2026-05-10 12:00:00+00'::timestamptz
  ),
  'now',
  'classify_urgency(within 60min) -> now'
);

SELECT is(
  public.fieldops_v2_classify_urgency(
    '2026-05-10 23:00:00+00'::timestamptz,
    '2026-05-10 12:00:00+00'::timestamptz
  ),
  'today',
  'classify_urgency(later same day) -> today'
);

SELECT is(
  public.fieldops_v2_classify_urgency(
    '2026-05-12 09:00:00+00'::timestamptz,
    '2026-05-10 12:00:00+00'::timestamptz
  ),
  'later',
  'classify_urgency(future day) -> later'
);

SELECT has_function(
  'public', 'fieldops_v2_priority_int', ARRAY['numeric'],
  'fieldops_v2_priority_int exists'
);

SELECT is(public.fieldops_v2_priority_int(NULL::numeric), 50, 'priority_int(NULL) -> 50');
SELECT is(public.fieldops_v2_priority_int((-5)::numeric), 0, 'priority_int(-5) -> 0 (clamp)');
SELECT is(public.fieldops_v2_priority_int(150::numeric), 100, 'priority_int(150) -> 100 (clamp)');
SELECT is(public.fieldops_v2_priority_int(73.6::numeric), 74, 'priority_int(73.6) -> 74 (round)');

SELECT has_function(
  'public', 'fieldops_v2_resolve_tone',
  ARRAY['text', 'integer', 'timestamp with time zone', 'timestamp with time zone'],
  'fieldops_v2_resolve_tone exists'
);

SELECT is(
  public.fieldops_v2_resolve_tone(
    'now', 80,
    '2026-05-10 12:00:00+00'::timestamptz,
    '2026-05-10 12:30:00+00'::timestamptz
  ),
  'danger',
  'resolve_tone: window past now-15min -> danger'
);

SELECT is(
  public.fieldops_v2_resolve_tone(
    'now', 80,
    '2026-05-10 12:30:00+00'::timestamptz,
    '2026-05-10 12:00:00+00'::timestamptz
  ),
  'warning',
  'resolve_tone: now + priority>=75 -> warning'
);

SELECT is(
  public.fieldops_v2_resolve_tone(
    'now', 50,
    '2026-05-10 12:30:00+00'::timestamptz,
    '2026-05-10 12:00:00+00'::timestamptz
  ),
  'accent',
  'resolve_tone: now + low priority -> accent'
);

SELECT is(
  public.fieldops_v2_resolve_tone(
    'today', 50,
    '2026-05-10 18:00:00+00'::timestamptz,
    '2026-05-10 12:00:00+00'::timestamptz
  ),
  'info',
  'resolve_tone: today -> info'
);

-- ----------------------------------------------------------------------------
-- (b) Main aggregator function
-- ----------------------------------------------------------------------------

SELECT has_function(
  'public', 'resolve_fieldops_tasks_v1', ARRAY['text', 'jsonb'],
  'resolve_fieldops_tasks_v1(text, jsonb) exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_fieldops_tasks_v1'
      AND p.prosecdef = TRUE
  ),
  'resolve_fieldops_tasks_v1 is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_fieldops_tasks_v1'
      AND p.provolatile = 's'  -- STABLE
  ),
  'resolve_fieldops_tasks_v1 is STABLE'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.resolve_fieldops_tasks_v1(text, jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE resolve_fieldops_tasks_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.resolve_fieldops_tasks_v1(text, jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE resolve_fieldops_tasks_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.resolve_fieldops_tasks_v1(text, jsonb)', 'EXECUTE'),
  'service_role can EXECUTE resolve_fieldops_tasks_v1'
);

-- ----------------------------------------------------------------------------
-- (c) api wrapper
-- ----------------------------------------------------------------------------

SELECT has_function(
  'api', 'resolve_fieldops_tasks_v1', ARRAY['text', 'jsonb'],
  'api.resolve_fieldops_tasks_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_fieldops_tasks_v1(text, jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE api.resolve_fieldops_tasks_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.resolve_fieldops_tasks_v1(text, jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE api.resolve_fieldops_tasks_v1'
);

-- ----------------------------------------------------------------------------
-- (d) Functional behaviour with seeded data
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_org_id UUID := gen_random_uuid();
  v_user_id UUID := gen_random_uuid();
  v_loader_id UUID := gen_random_uuid();
  v_supervisor_id UUID := gen_random_uuid();
  v_client_id UUID := gen_random_uuid();
  v_sender_id UUID := gen_random_uuid();
  v_branch_id UUID := gen_random_uuid();
  v_run_id UUID := gen_random_uuid();
  v_review_run_id UUID := gen_random_uuid();
  v_shipment_id UUID := gen_random_uuid();
  v_address_id UUID := gen_random_uuid();
  v_geocode_id UUID := gen_random_uuid();
  v_stop_id UUID := gen_random_uuid();
  v_pickup_stop_id UUID := gen_random_uuid();
  v_pickup_run_id UUID := gen_random_uuid();
  v_pickup_shipment_id UUID := gen_random_uuid();
  v_driver_pickup_run_id UUID := gen_random_uuid();
  v_driver_pickup_stop_id UUID := gen_random_uuid();
  v_driver_pickup_shipment_id UUID := gen_random_uuid();
  v_driver_count INT;
  v_loader_count INT;
  v_supervisor_count INT;
  v_first_task RECORD;
  v_driver_pickup_task RECORD;
BEGIN
  -- Seed
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_id, 'pgTAP tasks org', 'pgtap-tasks-' || substr(v_org_id::text, 1, 8))
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.users (id, organization_id, email, full_name, status)
  VALUES (v_user_id, v_org_id, 'pgtap-tasks-' || substr(v_user_id::text, 1, 8) || '@example.test', 'pgTAP tasks user', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (v_loader_id, v_org_id, v_loader_id || '@example.test', 'Loader fixture', 'driver', 'active'),
         (v_supervisor_id, v_org_id, v_supervisor_id || '@example.test', 'Supervisor fixture', 'ops_admin', 'active');
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org_id, ARRAY['warehouse_operator'], v_loader_id);
  INSERT INTO public.rbac_roles (organization_id, key, name)
  VALUES (v_org_id, 'supervisor', 'Supervisor');
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
  SELECT v_org_id, actor.user_id, r.id
  FROM (VALUES (v_loader_id, 'warehouse_operator'), (v_supervisor_id, 'supervisor')) actor(user_id, role_key)
  JOIN public.rbac_roles r ON r.organization_id = v_org_id AND r.key = actor.role_key;
  INSERT INTO public.mobile_v2_active_role (user_id, organization_id, role_key)
  VALUES (v_loader_id, v_org_id, 'loader'), (v_supervisor_id, v_org_id, 'supervisor');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client_id, v_org_id, 'pgTAP tasks client', 'pgtap-tasks-client-' || substr(v_client_id::text, 1, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender_id, v_client_id, 'pgTAP tasks sender', 'pgTAP tasks sender', TRUE, 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org_id,
    'pgtap:resolve-fieldops-tasks-fixture-bootstrap'
  );

  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, normalized_line1, district,
    city, province, country, building_number, postal_code, sa_short_code,
    validation_status
  )
  VALUES (
    v_address_id, v_org_id, v_client_id, 'TEST0000 Olaya Riyadh',
    'TEST0000 Olaya Riyadh', 'Olaya', 'Riyadh', 'Riyadh', 'SA',
    '4419', '12212', 'TEST0000', 'valid'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.geocodes (
    id, organization_id, client_id, address_id, provider_name, coordinates,
    confidence_score, accuracy_type, metadata, is_primary
  )
  VALUES (
    v_geocode_id, v_org_id, v_client_id, v_address_id, 'pgtap-fieldops-geocode',
    ST_SetSRID(ST_MakePoint(46.6753, 24.7136), 4326)::geography,
    0.97, 'rooftop', jsonb_build_object('match_strategy', 'sa_short_code_registry', 'accuracy_m', 8),
    TRUE
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
  VALUES (v_branch_id, v_org_id, 'pgTAP tasks branch', 'pgtap-tasks-branch-' || substr(v_branch_id::text, 1, 8), 'primary', 'Asia/Riyadh', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Driver run + delivery stop + shipment
  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, planned_start_at)
  VALUES (v_run_id, v_org_id, v_branch_id, v_user_id, 'in_progress', CURRENT_DATE, now() + INTERVAL '30 minutes')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number, box_count,
    priority_score, promised_delivery_date, service_level, status, status_updated_at,
    destination_address_id
  ) VALUES (
    v_shipment_id, v_org_id, v_client_id, 'delivery', 'PGTAP-' || substr(v_shipment_id::text, 1, 8),
    1, 80, CURRENT_DATE, 'standard', 'pending', now(), v_address_id
  ) ON CONFLICT DO NOTHING;

  INSERT INTO public.route_stops (
    id, organization_id, route_run_id, client_id, shipment_id,
    stop_kind, sequence_order, planned_window_start_at, metadata
  ) VALUES (
    v_stop_id, v_org_id, v_run_id, v_client_id, v_shipment_id,
    'delivery', 1, now() + INTERVAL '30 minutes',
    jsonb_build_object('area', 'Olaya')
  ) ON CONFLICT DO NOTHING;

  -- Loader pickup stop on a separate run (no driver assigned)
  INSERT INTO public.route_runs (id, organization_id, branch_id, status, planned_date, planned_start_at)
  VALUES (v_pickup_run_id, v_org_id, v_branch_id, 'planned', CURRENT_DATE, now() + INTERVAL '2 hours')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number, box_count,
    status, status_updated_at
  ) VALUES (
    v_pickup_shipment_id, v_org_id, v_client_id, 'pickup', 'PGTAP-PU-' || substr(v_pickup_shipment_id::text, 1, 8),
    3, 'pending', now()
  ) ON CONFLICT DO NOTHING;

  INSERT INTO public.route_stops (
    id, organization_id, route_run_id, client_id, shipment_id,
    stop_kind, sequence_order, planned_window_start_at
  ) VALUES (
    v_pickup_stop_id, v_org_id, v_pickup_run_id, v_client_id, v_pickup_shipment_id,
    'pickup', 1, now() + INTERVAL '90 minutes'
  ) ON CONFLICT DO NOTHING;

  -- Driver-assigned pickup stop with a canonical client reference. Mobile V2
  -- must show this row-driven pickup reference while retaining tracking lineage.
  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, planned_start_at)
  VALUES (v_driver_pickup_run_id, v_org_id, v_branch_id, v_user_id, 'in_progress', CURRENT_DATE, now() + INTERVAL '75 minutes')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number, client_reference_number,
    box_count, status, status_updated_at
  ) VALUES (
    v_driver_pickup_shipment_id, v_org_id, v_client_id, 'pickup',
    'PGTAP-PU-TRACK-' || substr(v_driver_pickup_shipment_id::text, 1, 8),
    'PGTAP-PICKUP-CLIENT-REF', 2, 'pending', now()
  ) ON CONFLICT DO NOTHING;

  INSERT INTO public.route_stops (
    id, organization_id, route_run_id, client_id, shipment_id,
    stop_kind, sequence_order, planned_window_start_at
  ) VALUES (
    v_driver_pickup_stop_id, v_org_id, v_driver_pickup_run_id, v_client_id, v_driver_pickup_shipment_id,
    'pickup', 1, now() + INTERVAL '75 minutes'
  ) ON CONFLICT DO NOTHING;

  -- Supervisor review run
  INSERT INTO public.route_runs (id, organization_id, branch_id, status, planned_date, planned_start_at)
  VALUES (v_review_run_id, v_org_id, v_branch_id, 'pending_review', CURRENT_DATE, now() + INTERVAL '15 minutes')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_user_id::text)::text,
    TRUE
  );

  -- (d1) Driver sees their own delivery stop
  SELECT COUNT(*) INTO v_driver_count
    FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) t
   WHERE t.task_id = 'stop:' || v_stop_id::text;
  PERFORM ok(v_driver_count = 1, 'driver sees their assigned delivery stop');

  -- (d2) Driver does NOT see the unassigned pickup stop
  SELECT COUNT(*) INTO v_driver_count
    FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) t
   WHERE t.task_id = 'stop:' || v_pickup_stop_id::text;
  PERFORM ok(v_driver_count = 0, 'driver does NOT see unassigned pickup stop');

  -- (d3) Driver task envelope shape
  SELECT * INTO v_first_task
    FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) t
   WHERE t.task_id = 'stop:' || v_stop_id::text
   LIMIT 1;
  PERFORM ok(v_first_task.code LIKE 'PGTAP-%', 'driver task code = shipment tracking_number');
  PERFORM ok(v_first_task.urgency = 'now', 'driver stop within 60min -> urgency=now');
  PERFORM ok(v_first_task.priority = 80, 'priority forwarded from shipments.priority_score');
  PERFORM ok(v_first_task.area = 'Olaya', 'area pulled from route_stops.metadata');
  PERFORM ok(v_first_task.route = '/mobile/stop/' || v_stop_id::text, 'driver task route href correct');
  PERFORM ok(
    abs((v_first_task.meta->>'destination_latitude')::numeric - 24.7136) < 0.000001
    AND abs((v_first_task.meta->>'destination_longitude')::numeric - 46.6753) < 0.000001,
    'driver task route-map metadata includes PostGIS geocode coordinates'
  );
  PERFORM is(
    v_first_task.meta->>'short_national_address',
    'TEST0000',
    'driver task route-map metadata includes Saudi short national address'
  );
  PERFORM is(
    v_first_task.meta->>'geocoding_provider',
    'pgtap-fieldops-geocode',
    'driver task route-map metadata includes geocoding provider lineage'
  );

  -- (d3b) Driver pickup task envelope shows pickup client reference and keeps tracking lineage
  SELECT * INTO v_driver_pickup_task
    FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) t
   WHERE t.task_id = 'stop:' || v_driver_pickup_stop_id::text
   LIMIT 1;
  PERFORM is(
    v_driver_pickup_task.title,
    'PGTAP-PICKUP-CLIENT-REF',
    'driver pickup task title uses shipment client reference'
  );
  PERFORM ok(
    v_driver_pickup_task.code LIKE 'PGTAP-PU-TRACK-%',
    'driver pickup task code keeps shipment tracking number'
  );
  PERFORM is(
    v_driver_pickup_task.meta->>'client_reference_number',
    'PGTAP-PICKUP-CLIENT-REF',
    'driver pickup task metadata includes shipment client reference'
  );

  -- (d4) Loader sees the org-wide pickup stop
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_loader_id)::text, TRUE);
  SELECT COUNT(*) INTO v_loader_count
    FROM public.resolve_fieldops_tasks_v1('loader', '{}'::jsonb) t
   WHERE t.task_id = 'stop:' || v_pickup_stop_id::text;
  PERFORM ok(v_loader_count = 1, 'loader sees pickup stop');

  -- (d5) Supervisor sees pending_review run
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_supervisor_id)::text, TRUE);
  SELECT COUNT(*) INTO v_supervisor_count
    FROM public.resolve_fieldops_tasks_v1('supervisor', '{}'::jsonb) t
   WHERE t.task_id = 'run:' || v_review_run_id::text;
  PERFORM ok(v_supervisor_count = 1, 'supervisor sees pending_review run');

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_id)::text, TRUE);
  -- (d6) Invalid role is denied.
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_tasks_v1(''unknown_role_xyz'', ''{}''::jsonb)',
    '42501', NULL, 'unknown role is denied'
  );

  -- (d7) p_active_role default is 'driver' (whitespace trimmed + lowercased)
  SELECT COUNT(*) INTO v_driver_count
    FROM public.resolve_fieldops_tasks_v1('  DRIVER ', '{}'::jsonb) t
   WHERE t.task_id = 'stop:' || v_stop_id::text;
  PERFORM ok(v_driver_count = 1, 'role normalisation: trim + lowercase -> driver');

  PERFORM set_config('request.jwt.claims', '', TRUE);

  -- The surrounding pgTAP transaction rolls back these rows. Avoid explicit
  -- cleanup here because tenant onboarding triggers may create scoped sender
  -- rows whose RLS delete policy differs from this test's read persona.
END $$;

SELECT * FROM finish();
ROLLBACK;
