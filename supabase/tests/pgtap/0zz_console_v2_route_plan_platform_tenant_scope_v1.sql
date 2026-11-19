-- pgTAP: Console V2 route-plan creation honors platform active-tenant scope

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_route_plan_platform_tenant_scope_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_platform_home_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_platform_user UUID := gen_random_uuid();
  v_spoofed_user UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_plan RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'ui_create_route_plan_v1',
    ARRAY['jsonb'],
    'public.ui_create_route_plan_v1(jsonb) exists'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_create_route_plan_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_create_route_plan_v1'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Plan Platform Scope Org', 'route-plan-platform-scope-' || left(v_org::text, 8));

  INSERT INTO public.organizations (id, name, slug)
  VALUES (
    v_platform_home_org,
    'Route Plan Platform Home Org',
    'route-plan-platform-home-' || left(v_platform_home_org::text, 8)
  );

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'rpps-' || lower(left(v_org::text, 6)), 'Route Plan Platform Scope Branch');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Route Plan Platform Scope Client', 'route-plan-platform-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_platform_user,
    v_platform_home_org,
    'route-plan-platform-' || left(v_platform_user::text, 8) || '@example.com',
    'Route Plan Platform Operator',
    'super_admin',
    'platform',
    NULL
  );

  INSERT INTO public.shipments (
    id, organization_id, client_id, tracking_number, status, service_type, created_at, updated_at
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    'RPPS-' || upper(left(v_shipment::text, 8)),
    'pending',
    'delivery',
    now(),
    now()
  );

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_plan
    FROM api.ui_create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'requested_by_user_id', v_spoofed_user,
        'branch_id', v_branch,
        'planned_date', '2026-05-07',
        'idempotency_key', 'pgtap-route-plan-platform-scope',
        'inputs', jsonb_build_object(
          'stops', jsonb_build_array(
            jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment, 'stop_kind', 'delivery', 'sequence_order', 1)
          )
        ),
        'metadata', jsonb_build_object('source', 'console_v2.route_plans.create')
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_plan.created IS TRUE, 'platform user can create a route_plan for the active tenant organization');
  RETURN NEXT is(
    (SELECT organization_id::text FROM public.route_plans WHERE id = v_plan.route_plan_id),
    v_org::text,
    'platform route-plan create uses the active tenant organization_id from input'
  );
  RETURN NEXT is(
    (SELECT requested_by_user_id::text FROM public.route_plans WHERE id = v_plan.route_plan_id),
    v_platform_user::text,
    'platform route-plan create derives requested_by_user_id from auth.uid'
  );

  BEGIN
    PERFORM api.ui_create_route_plan_v1(
      jsonb_build_object(
        'branch_id', v_branch,
        'planned_date', '2026-05-08',
        'idempotency_key', 'pgtap-route-plan-platform-scope-missing-org',
        'inputs', jsonb_build_object('stops', jsonb_build_array())
      )
    );
    RETURN NEXT fail('platform route-plan create without organization_id fails closed');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('platform route-plan create without organization_id fails closed');
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_route_plan_platform_tenant_scope_v1();

SELECT * FROM finish();
ROLLBACK;
