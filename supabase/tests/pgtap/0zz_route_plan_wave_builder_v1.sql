-- Plan: PLAN-202603-b06-planning-dispatch-wave0 / Step: S07
-- pgTAP: Route plan delivery wave builder v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

CREATE OR REPLACE FUNCTION pg_temp.test_route_plan_wave_builder_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_other_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_zone UUID := gen_random_uuid();
  v_lineage_branch UUID := gen_random_uuid();
  v_lineage_zone UUID := gen_random_uuid();
  v_standard_level UUID := gen_random_uuid();
  v_express_level UUID := gen_random_uuid();
  v_lineage_level UUID := gen_random_uuid();
  v_lineage_offering UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_ship_high UUID := gen_random_uuid();
  v_ship_low UUID := gen_random_uuid();
  v_ship_future UUID := gen_random_uuid();
  v_ship_other_branch UUID := gen_random_uuid();
  v_ship_express UUID := gen_random_uuid();
  v_ship_planned UUID := gen_random_uuid();
  v_ship_lineage UUID := gen_random_uuid();
  v_lineage_key TEXT := 'a2z_standard_service_level_20260615';
  v_candidate_count INT := 0;
  v_lineage_candidate_count INT := 0;
  v_candidate_ids UUID[] := '{}'::uuid[];
  v_first_source TEXT := NULL;
  v_lineage_stop_payload JSONB := NULL;
  v_build1 RECORD;
  v_build2 RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function('public', 'route_plan_delivery_wave_candidates_v1', ARRAY['jsonb'], 'public.route_plan_delivery_wave_candidates_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'build_delivery_wave_route_plan_v1', ARRAY['jsonb'], 'public.build_delivery_wave_route_plan_v1(jsonb) exists');
  RETURN NEXT ok(
    has_function_privilege('service_role', 'public.route_plan_delivery_wave_candidates_v1(jsonb)', 'EXECUTE'),
    'service_role can execute route_plan_delivery_wave_candidates_v1'
  );

  INSERT INTO public.organizations (id, name, slug, timezone)
  VALUES (v_org, 'Route Wave Org', 'route-wave-' || left(v_org::text, 8), 'Asia/Riyadh');

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES
    (v_branch, v_org, 'wave-' || lower(left(v_branch::text, 6)), 'Wave Branch', 'Asia/Riyadh'),
    (v_other_branch, v_org, 'wave-' || lower(left(v_other_branch::text, 6)), 'Other Wave Branch', 'Asia/Riyadh'),
    (v_lineage_branch, v_org, 'wave-' || lower(left(v_lineage_branch::text, 6)), 'Lineage Wave Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Route Wave Client', 'route-wave-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_user, v_org, 'route-wave-' || left(v_user::text, 8) || '@example.com', 'Route Wave Planner', 'ops_admin', 'tenant', NULL);

  INSERT INTO public.zones (id, organization_id, name, slug)
  VALUES (v_zone, v_org, 'Wave Zone', 'wave-zone-' || left(v_zone::text, 8));

  INSERT INTO public.branch_zones (branch_id, zone_id, priority)
  VALUES (v_branch, v_zone, 10);

  INSERT INTO public.zones (id, organization_id, name, slug)
  VALUES (v_lineage_zone, v_org, 'Lineage Wave Zone', 'lineage-wave-zone-' || left(v_lineage_zone::text, 8));

  INSERT INTO public.branch_zones (branch_id, zone_id, priority)
  VALUES (v_lineage_branch, v_lineage_zone, 10);

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES (v_standard_level, v_org, 'standard', 'Standard', TRUE)
  ON CONFLICT (organization_id, key) DO UPDATE
    SET name = EXCLUDED.name,
        is_active = EXCLUDED.is_active
  RETURNING id INTO v_standard_level;

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES (v_express_level, v_org, 'express', 'Express', TRUE)
  ON CONFLICT (organization_id, key) DO UPDATE
    SET name = EXCLUDED.name,
        is_active = EXCLUDED.is_active
  RETURNING id INTO v_express_level;

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES (v_lineage_level, v_org, v_lineage_key, 'A2Z Standard Service Level', TRUE)
  ON CONFLICT (organization_id, key) DO UPDATE
    SET name = EXCLUDED.name,
        is_active = EXCLUDED.is_active
  RETURNING id INTO v_lineage_level;

  INSERT INTO public.service_offerings (service_level_id, branch_id, zone_id, effective_from, is_active, priority)
  VALUES
    (v_standard_level, v_branch, v_zone, '2026-01-01T00:00:00Z', TRUE, 10),
    (v_express_level, v_branch, v_zone, '2026-01-01T00:00:00Z', TRUE, 10);

  INSERT INTO public.service_offerings (id, service_level_id, branch_id, zone_id, effective_from, is_active, priority)
  VALUES (v_lineage_offering, v_lineage_level, v_lineage_branch, v_lineage_zone, '2026-01-01T00:00:00Z', TRUE, 10);

  INSERT INTO public.branch_capacity_windows (
    branch_id,
    zone_id,
    service_level_id,
    effective_from,
    capacity,
    is_active,
    priority
  )
  VALUES (
    v_branch,
    v_zone,
    v_standard_level,
    '2026-01-01T00:00:00Z',
    jsonb_build_object('max_stops', 250),
    TRUE,
    10
  );

  INSERT INTO public.branch_capacity_windows (
    branch_id,
    zone_id,
    service_level_id,
    effective_from,
    capacity,
    is_active,
    priority
  )
  VALUES (
    v_lineage_branch,
    v_lineage_zone,
    v_lineage_level,
    '2026-01-01T00:00:00Z',
    jsonb_build_object('max_stops', 250),
    TRUE,
    10
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    tracking_number,
    status,
    service_type,
    service_level,
    zone_id,
    branch_id,
    promised_delivery_date,
    promised_window_start_at,
    promised_window_end_at,
    priority_score,
    created_at,
    updated_at
  )
  VALUES
    (
      v_ship_high,
      v_org,
      v_client,
      'WAVE-HIGH-' || upper(left(v_ship_high::text, 8)),
      'created',
      'delivery',
      'standard',
      v_zone,
      NULL,
      DATE '2026-04-04',
      '2026-04-04T07:00:00Z',
      '2026-04-04T08:00:00Z',
      90,
      '2026-04-03T06:00:00Z',
      '2026-04-03T06:00:00Z'
    ),
    (
      v_ship_low,
      v_org,
      v_client,
      'WAVE-LOW-' || upper(left(v_ship_low::text, 8)),
      'created',
      'delivery',
      'standard',
      v_zone,
      NULL,
      DATE '2026-04-04',
      '2026-04-04T08:30:00Z',
      '2026-04-04T09:30:00Z',
      10,
      '2026-04-03T08:00:00Z',
      '2026-04-03T08:00:00Z'
    ),
    (
      v_ship_future,
      v_org,
      v_client,
      'WAVE-FUT-' || upper(left(v_ship_future::text, 8)),
      'created',
      'delivery',
      'standard',
      v_zone,
      NULL,
      DATE '2026-04-05',
      '2026-04-05T08:30:00Z',
      '2026-04-05T09:30:00Z',
      50,
      '2026-04-03T09:00:00Z',
      '2026-04-03T09:00:00Z'
    ),
    (
      v_ship_other_branch,
      v_org,
      v_client,
      'WAVE-OTH-' || upper(left(v_ship_other_branch::text, 8)),
      'created',
      'delivery',
      'standard',
      v_zone,
      v_other_branch,
      DATE '2026-04-04',
      '2026-04-04T07:30:00Z',
      '2026-04-04T08:30:00Z',
      60,
      '2026-04-03T09:30:00Z',
      '2026-04-03T09:30:00Z'
    ),
    (
      v_ship_express,
      v_org,
      v_client,
      'WAVE-EXP-' || upper(left(v_ship_express::text, 8)),
      'created',
      'delivery',
      'express',
      v_zone,
      NULL,
      DATE '2026-04-04',
      '2026-04-04T07:15:00Z',
      '2026-04-04T08:15:00Z',
      70,
      '2026-04-03T10:00:00Z',
      '2026-04-03T10:00:00Z'
    ),
    (
      v_ship_planned,
      v_org,
      v_client,
      'WAVE-PLN-' || upper(left(v_ship_planned::text, 8)),
      'created',
      'delivery',
      'standard',
      v_zone,
      NULL,
      DATE '2026-04-04',
      '2026-04-04T10:00:00Z',
      '2026-04-04T11:00:00Z',
      55,
      '2026-04-03T11:00:00Z',
      '2026-04-03T11:00:00Z'
    );

  INSERT INTO public.route_runs (id, organization_id, branch_id, status, planned_date, metadata)
  VALUES (v_run, v_org, v_branch, 'planned', DATE '2026-04-04', '{}'::jsonb);

  INSERT INTO public.route_stops (
    organization_id,
    route_run_id,
    client_id,
    shipment_id,
    stop_kind,
    sequence_order,
    metadata
  )
  VALUES (
    v_org,
    v_run,
    v_client,
    v_ship_planned,
    'delivery',
    1,
    '{}'::jsonb
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    tracking_number,
    status,
    service_type,
    service_level,
    zone_id,
    branch_id,
    promised_delivery_date,
    promised_window_start_at,
    promised_window_end_at,
    priority_score,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_ship_lineage,
    v_org,
    v_client,
    'WAVE-LIN-' || upper(left(v_ship_lineage::text, 8)),
    'created',
    'delivery',
    'standard',
    NULL,
    NULL,
    DATE '2026-04-04',
    '2026-04-04T07:45:00Z',
    '2026-04-04T08:45:00Z',
    80,
    jsonb_build_object(
      'service_offering_id', v_lineage_offering::text,
      'service_level_id', v_lineage_level::text,
      'service_level_key', v_lineage_key,
      'service_offering_branch_id', v_lineage_branch::text,
      'service_offering_zone_id', v_lineage_zone::text
    ),
    '2026-04-03T07:00:00Z',
    '2026-04-03T07:00:00Z'
  );

  SELECT COUNT(*)::int
    INTO v_candidate_count
  FROM public.route_plan_delivery_wave_candidates_v1(
    jsonb_build_object(
      'organization_id', v_org,
      'branch_id', v_branch,
      'planned_date', '2026-04-04'
    )
  );

  SELECT
    COALESCE(array_agg(c.shipment_id ORDER BY c.sequence_order), '{}'::uuid[]),
    min(c.stop_payload #>> '{metadata,source}')
    INTO v_candidate_ids, v_first_source
  FROM public.route_plan_delivery_wave_candidates_v1(
    jsonb_build_object(
      'organization_id', v_org,
      'branch_id', v_branch,
      'planned_date', '2026-04-04'
    )
  ) AS c;

  RETURN NEXT is(v_candidate_count, 2, 'candidate selection keeps only due, ready, unplanned shipments');
  RETURN NEXT is(v_candidate_ids[1]::text, v_ship_high::text, 'highest priority shipment is ranked first');
  RETURN NEXT is(v_candidate_ids[2]::text, v_ship_low::text, 'lower priority shipment is ranked second');
  RETURN NEXT ok(NOT (v_ship_future = ANY(v_candidate_ids)), 'future shipment is excluded');
  RETURN NEXT ok(NOT (v_ship_other_branch = ANY(v_candidate_ids)), 'shipment pinned to another branch is excluded');
  RETURN NEXT ok(NOT (v_ship_express = ANY(v_candidate_ids)), 'branch readiness excludes service levels without matching capacity window');
  RETURN NEXT ok(NOT (v_ship_planned = ANY(v_candidate_ids)), 'already planned shipment is excluded');
  RETURN NEXT is(v_first_source, 'delivery_wave_builder', 'candidate stop payload marks delivery_wave_builder source');

  SELECT *
    INTO v_build1
    FROM public.build_delivery_wave_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'planned_date', '2026-04-04',
        'requested_by_user_id', v_user
      )
    )
   LIMIT 1;

  SELECT *
    INTO v_build2
    FROM public.build_delivery_wave_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'planned_date', '2026-04-04',
        'requested_by_user_id', v_user
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_build1.created IS TRUE, 'first delivery-wave build creates a route_plan');
  RETURN NEXT ok(v_build2.created IS FALSE, 'second delivery-wave build is idempotent');
  RETURN NEXT is(v_build2.route_plan_id::text, v_build1.route_plan_id::text, 'idempotent build returns the same route_plan_id');
  RETURN NEXT is(v_build1.stop_count, 2, 'build result reports selected stop count');
  RETURN NEXT is(
    (SELECT jsonb_array_length(inputs->'stops') FROM public.route_plans WHERE id = v_build1.route_plan_id),
    2,
    'route_plan inputs capture the selected delivery-wave stops'
  );
  RETURN NEXT is(
    (SELECT (metadata#>>'{builder,candidate_count}')::int FROM public.route_plans WHERE id = v_build1.route_plan_id),
    2,
    'route_plan metadata records builder candidate_count'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::int
      FROM public.route_plan_events
      WHERE route_plan_id = v_build1.route_plan_id
        AND event_type = 'delivery_wave_built'
    ),
    1,
    'delivery_wave_built event is logged once across idempotent retries'
  );

  SELECT COUNT(*)::int
    INTO v_lineage_candidate_count
  FROM public.route_plan_delivery_wave_candidates_v1(
    jsonb_build_object(
      'organization_id', v_org,
      'branch_id', v_lineage_branch,
      'planned_date', '2026-04-04'
    )
  ) AS c
  WHERE c.shipment_id = v_ship_lineage;

  SELECT c.stop_payload
    INTO v_lineage_stop_payload
  FROM public.route_plan_delivery_wave_candidates_v1(
    jsonb_build_object(
      'organization_id', v_org,
      'branch_id', v_lineage_branch,
      'planned_date', '2026-04-04'
    )
  ) AS c
  WHERE c.shipment_id = v_ship_lineage
  LIMIT 1;

  RETURN NEXT is(v_lineage_candidate_count, 1, 'candidate selection resolves tenant service-level lineage when shipments.service_level stores governed tier');
  RETURN NEXT is(v_lineage_stop_payload #>> '{metadata,service_level}', 'standard', 'candidate stop payload preserves governed shipment service tier');
  RETURN NEXT is(v_lineage_stop_payload #>> '{metadata,service_level_key}', v_lineage_key, 'candidate stop payload carries catalog service-level key lineage');
  RETURN NEXT is(v_lineage_stop_payload #>> '{metadata,service_offering_id}', v_lineage_offering::text, 'candidate stop payload carries selected service-offering lineage');

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_route_plan_wave_builder_v1();

SELECT * FROM finish();
ROLLBACK;
