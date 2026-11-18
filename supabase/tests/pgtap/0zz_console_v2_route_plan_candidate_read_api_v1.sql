-- pgTAP: Console V2 route-plan candidate read API v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_route_plan_candidate_read_api_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '0df679dd-6f41-4b27-8a7b-dac5fb8d3a53'::uuid;
  v_spoofed_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_zone UUID := gen_random_uuid();
  v_standard_level UUID := gen_random_uuid();
  v_ship_due UUID := gen_random_uuid();
  v_first_tenant_ship UUID := '7065299a-02bd-49a4-b037-1972b71eefa0'::uuid;
  v_branch_only_ship UUID := gen_random_uuid();
  v_ship_future UUID := gen_random_uuid();
  v_candidate_count INT := 0;
  v_candidate_ids UUID[] := '{}'::uuid[];
  v_candidate_trackings TEXT[] := '{}'::text[];
  v_candidate_source TEXT := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'ui_route_plan_delivery_wave_candidates_v1',
    ARRAY['jsonb'],
    'public.ui_route_plan_delivery_wave_candidates_v1(jsonb) exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_route_plan_delivery_wave_candidates_v1',
    ARRAY['jsonb'],
    'api.ui_route_plan_delivery_wave_candidates_v1(jsonb) exists'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_route_plan_delivery_wave_candidates_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_route_plan_delivery_wave_candidates_v1'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Plan Candidate Org', 'route-plan-candidate-' || left(v_org::text, 8))
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        slug = EXCLUDED.slug;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'rpcand', 'Route Plan Candidate Branch');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Route Plan Candidate Client', 'route-plan-candidate-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'route-plan-candidate-' || left(v_user::text, 8) || '@example.com',
    'Route Plan Candidate Ops',
    'ops_admin',
    'tenant',
    NULL
  );

  INSERT INTO public.zones (id, organization_id, name, slug)
  VALUES (v_zone, v_org, 'Route Plan Candidate Zone', 'route-plan-candidate-zone-' || left(v_zone::text, 8));

  INSERT INTO public.branch_zones (branch_id, zone_id, priority)
  VALUES (v_branch, v_zone, 10);

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES (v_standard_level, v_org, 'standard', 'Standard', TRUE)
  ON CONFLICT (organization_id, key) DO UPDATE
    SET name = EXCLUDED.name,
        is_active = EXCLUDED.is_active
  RETURNING id INTO v_standard_level;

  INSERT INTO public.service_offerings (service_level_id, branch_id, zone_id, effective_from, is_active, priority)
  VALUES (v_standard_level, v_branch, v_zone, '2026-01-01T00:00:00Z', TRUE, 10);

  INSERT INTO public.service_offerings (service_level_id, branch_id, zone_id, effective_from, is_active, priority)
  VALUES (v_standard_level, v_branch, NULL, '2026-01-01T00:00:00Z', TRUE, 20);

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
    jsonb_build_object('max_stops', 50),
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
    v_branch,
    NULL,
    v_standard_level,
    '2026-01-01T00:00:00Z',
    jsonb_build_object('max_stops', 50),
    TRUE,
    20
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    tracking_number,
    status,
    service_type,
    service_level,
    branch_id,
    zone_id,
    promised_delivery_date,
    promised_window_start_at,
    promised_window_end_at,
    priority_score,
    metadata,
    created_at,
    updated_at
  )
  VALUES
    (
      v_ship_due,
      v_org,
      v_client,
      'RPCAND-DUE',
      'created',
      'delivery',
      'standard',
      v_branch,
      v_zone,
      DATE '2026-05-07',
      '2026-05-07T08:00:00Z',
      '2026-05-07T10:00:00Z',
      80,
      '{}'::jsonb,
      now(),
      now()
    ),
    (
      v_first_tenant_ship,
      v_org,
      v_client,
      '26007QJTZ',
      'pending',
      'delivery',
      NULL,
      NULL,
      NULL,
      DATE '2026-05-07',
      '2026-05-07T09:00:00Z',
      '2026-05-07T11:00:00Z',
      95,
      jsonb_build_object(
        'service_offering_branch_id', v_branch::text,
        'service_offering_zone_id', v_zone::text,
        'service_level_key', 'standard'
      ),
      now(),
      now()
    ),
    (
      v_branch_only_ship,
      v_org,
      v_client,
      'RPCAND-BRANCH',
      'pending',
      'delivery',
      NULL,
      NULL,
      NULL,
      DATE '2026-05-07',
      '2026-05-07T09:30:00Z',
      '2026-05-07T11:30:00Z',
      94,
      jsonb_build_object(
        'service_offering_branch_id', v_branch::text,
        'service_level_key', 'standard'
      ),
      now(),
      now()
    ),
    (
      v_ship_future,
      v_org,
      v_client,
      'RPCAND-FUTURE',
      'created',
      'delivery',
      'standard',
      v_branch,
      v_zone,
      DATE '2026-05-09',
      '2026-05-09T08:00:00Z',
      '2026-05-09T10:00:00Z',
      90,
      '{}'::jsonb,
      now(),
      now()
    );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT
    COUNT(*)::int,
    COALESCE(array_agg(c.shipment_id ORDER BY c.sequence_order), '{}'::uuid[]),
    COALESCE(array_agg(c.tracking_number ORDER BY c.sequence_order), '{}'::text[]),
    min(c.stop_payload #>> '{metadata,source}')
    INTO v_candidate_count, v_candidate_ids, v_candidate_trackings, v_candidate_source
  FROM api.ui_route_plan_delivery_wave_candidates_v1(
    jsonb_build_object(
      'organization_id', v_spoofed_org,
      'branch_id', v_branch,
      'planned_date', '2026-05-07'
    )
  ) AS c;

  RETURN NEXT is(v_candidate_count, 3, 'candidate read returns only eligible due shipments');
  RETURN NEXT ok(
    v_candidate_ids @> ARRAY[v_ship_due, v_first_tenant_ship, v_branch_only_ship]::uuid[],
    'candidate read ignores spoofed organization_id and uses tenant context'
  );
  RETURN NEXT ok(
    v_candidate_trackings @> ARRAY['26007QJTZ']::text[],
    'candidate read includes first-tenant pending shipment from service-offering lineage'
  );
  RETURN NEXT ok(
    v_candidate_trackings @> ARRAY['RPCAND-BRANCH']::text[],
    'candidate read includes branch-level service-offering shipments before zone projection'
  );
  RETURN NEXT is(v_candidate_source, 'delivery_wave_builder', 'candidate read preserves canonical stop payload source');
  SELECT COUNT(*)::int
    INTO v_candidate_count
  FROM api.ui_route_plan_delivery_wave_candidates_v1(
    jsonb_build_object(
      'planned_date', '2026-05-07'
    )
  ) AS c;
  RETURN NEXT is(
    v_candidate_count,
    3,
    'candidate read can discover eligible route-plan branches when branch_id is omitted'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_route_plan_candidate_read_api_v1();

SELECT * FROM finish();
ROLLBACK;
