BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

CREATE FUNCTION pg_temp.test_route_assignment_policy_onboarding()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  v_org uuid := gen_random_uuid();
  v_supplier uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_sender uuid := gen_random_uuid();
  v_branch uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_shipment uuid;
  v_route uuid;
  v_context jsonb;
  v_result jsonb;
  v_onboarding jsonb := public.resolve_saas_onboarding_policy_v1();
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Capacity onboarding tenant', 'capacity-tenant-' || v_org::text),
    (v_supplier, 'Capacity onboarding supplier', 'capacity-supplier-' || v_supplier::text);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Capacity onboarding client', 'capacity-client-' || v_client::text, 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Capacity onboarding sender', 'Capacity onboarding sender', 'active');

  RETURN NEXT ok((
    SELECT bool_and(public.onboarding_policy_bool_v1(
      v_onboarding, ARRAY['materialize_defaults', scope_type, 'strict_required_coverage'], TRUE
    ))
      FROM (VALUES ('tenant'), ('client'), ('sender')) AS scopes(scope_type)
  ), 'onboarding succeeds with strict coverage for all three scopes');

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1 FROM public.settings
       WHERE category = 'route_assignment_policy'
         AND (scope_type, scope_id) IN (('tenant', v_org), ('client', v_client), ('sender', v_sender))
    ) AND NOT EXISTS (
      SELECT 1 FROM public.settings_versions
       WHERE category = 'route_assignment_policy'
         AND (scope_type, scope_id) IN (('tenant', v_org), ('client', v_client), ('sender', v_sender))
    ),
    'onboarding creates no route assignment settings or versions at tenant, client or sender scope'
  );

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'capacity', 'Capacity onboarding branch', 'Asia/Riyadh');

  INSERT INTO public.shipments (organization_id, client_id, sender_id, tracking_number, service_type, status)
  VALUES (v_org, v_client, v_sender, 'UC079-ONBOARDING', 'delivery', 'pending')
  RETURNING id INTO v_shipment;

  INSERT INTO public.marketplace_requests (
    id, requester_organization_id, request_kind_key, status, release_state,
    title, request_details, private_pool, metadata, decision_metadata
  )
  VALUES (
    v_request, v_org, 'capacity_block', 'published', 'private_pool',
    'Capacity onboarding request', '{}'::jsonb, jsonb_build_array(v_supplier), '{}'::jsonb, '{}'::jsonb
  );

  SELECT route_run_id INTO STRICT v_route
    FROM public.create_route_run_v1(jsonb_build_object(
      'organization_id', v_org,
      'branch_id', v_branch,
      'metadata', jsonb_build_object('alternate_capacity', jsonb_build_object(
        'demand_class', 'express', 'marketplace_request_id', v_request
      )),
      'stops', jsonb_build_array(jsonb_build_object(
        'client_id', v_client, 'shipment_id', v_shipment, 'stop_kind', 'delivery'
      ))
    ));

  v_context := jsonb_build_object(
    'organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender, 'resource_id', v_branch
  );
  RETURN NEXT is(
    (SELECT value#>'{alternate_capacity,enabled}' FROM public.route_assignment_policy_resolve_v1(v_context)),
    'false'::jsonb,
    'the new route resolves to disabled automatic capacity by default'
  );
  RETURN NEXT throws_ok(
    format('SELECT public.route_run_resolve_alternate_capacity_v1(%L::uuid)', v_route),
    '23514',
    format('route_run_resolve_alternate_capacity_v1 alternate capacity is disabled for route_run %s', v_route),
    'the route cannot select an otherwise eligible supplier without an opt-in'
  );

  PERFORM public.upsert_settings_value_v1(
    'route_assignment_policy', 'tenant', v_org, '{"alternate_capacity":{"enabled":true}}'::jsonb,
    1, 'Opt in after onboarding the route client and sender'
  );

  v_result := public.route_run_resolve_alternate_capacity_v1(v_route);
  RETURN NEXT is(
    jsonb_build_array(
      v_result->'policy_scope_type', v_result->'policy_scope_id',
      v_result#>'{metadata,enabled}', v_result#>'{partner,partner_id}'
    ),
    jsonb_build_array('tenant', v_org, true, v_supplier),
    'the existing route client and sender inherit the later tenant opt-in'
  );
  RETURN;
END;
$test$;

SELECT * FROM pg_temp.test_route_assignment_policy_onboarding();
SELECT * FROM finish();
ROLLBACK;
