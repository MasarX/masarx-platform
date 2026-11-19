-- pgTAP: COD entries resolve settlement branch context from canonical route-run lineage.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-0000000c0e01';
  v_branch UUID := '00000000-0000-0000-0000-0000000c0e02';
  v_driver UUID := '00000000-0000-0000-0000-0000000c0e03';
  v_client UUID := '00000000-0000-0000-0000-0000000c0e04';
  v_sender UUID := '00000000-0000-0000-0000-0000000c0e05';
  v_shipment UUID := '00000000-0000-0000-0000-0000000c0e06';
  v_route_run UUID := '00000000-0000-0000-0000-0000000c0e07';
  v_route_stop UUID := '00000000-0000-0000-0000-0000000c0e08';
  v_action UUID := '00000000-0000-0000-0000-0000000c0e09';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'COD Route Branch Context Org', 'cod-route-branch-context-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'cod-rbc', 'COD Route Branch Context Branch', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (v_driver, v_org, 'cod-route-branch-driver@example.com', 'COD Route Branch Driver', 'driver', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'COD Route Branch Client', 'cod-route-branch-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'COD Route Branch Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:cod-route-branch-context-fixture-bootstrap');

  INSERT INTO public.shipments (
    id, organization_id, client_id, sender_id, service_type, tracking_number,
    status, cod_amount, cod_currency, branch_id, driver_user_id
  )
  VALUES (
    v_shipment, v_org, v_client, v_sender, 'delivery', 'PGTAP-COD-ROUTE-BRANCH',
    'delivered', 125.00, 'SAR', NULL, v_driver
  );

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, metadata)
  VALUES (v_route_run, v_org, v_branch, v_driver, 'completed', current_date, jsonb_build_object('source', 'pgtap/cod-route-branch-context'))
  ;

  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, sequence_order, metadata)
  VALUES (v_route_stop, v_org, v_route_run, v_client, v_shipment, 1, jsonb_build_object('source', 'pgtap/cod-route-branch-context'))
  ;

  INSERT INTO public.shipment_actions (
    id, shipment_id, organization_id, client_id, action_type, action_category,
    canonical_status, action_data, timestamp, created_at, performed_by_system
  )
  VALUES (
    v_action, v_shipment, v_org, v_client, 'status_change', 'operational',
    'delivered',
    jsonb_build_object(
      'route_stop_id', v_route_stop,
      'route_run_id', v_route_run,
      'delivery_completion', jsonb_build_object(
        'route_stop_id', v_route_stop,
        'route_run_id', v_route_run,
        'payment_collection', jsonb_build_object(
          'outcome', 'collected',
          'method', 'cash',
          'expected_amount', 125.00,
          'collected_amount', 125.00,
          'currency', 'SAR'
        )
      )
    ),
    now(), now(), 'pgtap.cod_route_branch_context'
  );
END $$;

SELECT is(
  (SELECT metadata->>'branch_id' FROM public.cod_entries WHERE id = '00000000-0000-0000-0000-0000000c0e09'),
  '00000000-0000-0000-0000-0000000c0e02',
  'cod_entries resolves missing shipment branch from linked route_run.branch_id'
);

SELECT is(
  (SELECT metadata->>'driver_user_id' FROM public.cod_entries WHERE id = '00000000-0000-0000-0000-0000000c0e09'),
  '00000000-0000-0000-0000-0000000c0e03',
  'cod_entries preserves driver context for settlement start'
);

SELECT is(
  (SELECT metadata->>'settlement_context_ready' FROM public.cod_entries WHERE id = '00000000-0000-0000-0000-0000000c0e09'),
  'true',
  'cod_entries marks settlement context ready when route branch and driver exist'
);

SELECT is(
  (SELECT metadata->>'status' FROM public.cod_entries WHERE id = '00000000-0000-0000-0000-0000000c0e09'),
  'collected',
  'cod_entries keeps existing payment status projection unchanged'
);

SELECT * FROM finish();

ROLLBACK;
