BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

CREATE FUNCTION pg_temp.check_driver_delivery_kpis()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  tenant_id uuid := gen_random_uuid();
  other_tenant_id uuid := gen_random_uuid();
  actor_id uuid := gen_random_uuid();
  driver_id uuid := gen_random_uuid();
  empty_driver_id uuid := gen_random_uuid();
  other_driver_id uuid := gen_random_uuid();
  client_id uuid := gen_random_uuid();
  sender_id uuid := gen_random_uuid();
  route_run_id uuid := gen_random_uuid();
  first_shipment uuid := gen_random_uuid();
  second_shipment uuid := gen_random_uuid();
  completed_at timestamptz := date_trunc('day', statement_timestamp(), 'UTC');
  source_view regclass;
  sample record;
  listed jsonb;
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug)
  VALUES (tenant_id, 'Synthetic fleet tenant', 'fleet-' || tenant_id),
         (other_tenant_id, 'Synthetic other fleet', 'fleet-' || other_tenant_id);
  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (actor_id, tenant_id, actor_id || '@example.test', 'Synthetic fleet reader', 'ops_admin', 'active', 'tenant'),
         (driver_id, tenant_id, driver_id || '@example.test', 'Synthetic delivery driver', 'driver', 'active', 'tenant'),
         (empty_driver_id, tenant_id, empty_driver_id || '@example.test', 'Synthetic empty driver', 'driver', 'active', 'tenant'),
         (other_driver_id, other_tenant_id, other_driver_id || '@example.test', 'Synthetic other driver', 'driver', 'active', 'tenant');
  PERFORM public.provision_rbac_roles_from_templates_v1(tenant_id, ARRAY['ops_admin'], actor_id);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id)
  SELECT tenant_id, actor_id, id, actor_id FROM public.rbac_roles
  WHERE organization_id = tenant_id AND key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.driver_profiles (organization_id, user_id, driver_code, status, metadata)
  VALUES (tenant_id, driver_id, driver_id::text, 'active', '{"deliveries_today":"ignored"}'),
         (tenant_id, empty_driver_id, empty_driver_id::text, 'active', '{}'),
         (other_tenant_id, other_driver_id, other_driver_id::text, 'active', '{}');
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (client_id, tenant_id, 'Synthetic fleet client', 'fleet-client-' || client_id, 'active');
  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (sender_id, client_id, 'Synthetic sender', 'Synthetic sender', true, 'active');
  INSERT INTO public.shipments
    (id, organization_id, client_id, sender_id, service_type, tracking_number, status, box_count, delivered_at)
  VALUES (first_shipment, tenant_id, client_id, sender_id, 'delivery', first_shipment::text, 'delivered', 1, completed_at),
         (second_shipment, tenant_id, client_id, sender_id, 'delivery', second_shipment::text, 'delivered', 1, completed_at);
  INSERT INTO public.route_runs (id, organization_id, driver_user_id)
  VALUES (route_run_id, tenant_id, driver_id);
  INSERT INTO public.route_run_assignments
    (organization_id, route_run_id, driver_user_id, assignment_mode, assignment_status, assigned_at)
  VALUES (tenant_id, route_run_id, driver_id, 'internal_driver', 'accepted', completed_at - interval '1 day');
  INSERT INTO public.route_stops
    (organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order, planned_window_end_at, created_at)
  VALUES (tenant_id, route_run_id, client_id, first_shipment, 'delivery', 1,
          completed_at + interval '1 hour', completed_at - interval '1 hour'),
         (tenant_id, route_run_id, client_id, second_shipment, 'delivery', 2,
          completed_at - interval '15 minutes', completed_at - interval '1 hour');
  INSERT INTO public.feedback_events (organization_id, client_id, shipment_id, rating)
  VALUES (tenant_id, client_id, first_shipment, 5),
         (tenant_id, client_id, second_shipment, 3);

  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', actor_id)::text, true);
  PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;

  FOREACH source_view IN ARRAY ARRAY['public.v_driver_directory'::regclass, 'public.driver_profile_summary_v1'::regclass] LOOP
    EXECUTE format('SELECT deliveries_today, deliveries_week, on_time_pct, customer_rating FROM %s WHERE user_id = $1',
      source_view) INTO STRICT sample USING driver_id;
    RETURN NEXT is(sample.deliveries_today, 2, source_view || ' counts completed deliveries today');
    RETURN NEXT is(sample.deliveries_week, 2, source_view || ' counts completed deliveries this week');
    RETURN NEXT is(sample.on_time_pct, 0.5::numeric, source_view || ' derives the on-time ratio from planned windows');
    RETURN NEXT is(sample.customer_rating, 4::numeric, source_view || ' derives ratings from matched shipment feedback');
    EXECUTE format('SELECT deliveries_today, deliveries_week, on_time_pct, customer_rating FROM %s WHERE user_id = $1',
      source_view) INTO STRICT sample USING empty_driver_id;
    RETURN NEXT ok(sample.deliveries_today IS NULL AND sample.deliveries_week IS NULL AND sample.on_time_pct IS NULL
      AND sample.customer_rating IS NULL, source_view || ' returns NULL without delivery evidence');
    EXECUTE format('SELECT count(*) AS visible FROM %s WHERE user_id = $1', source_view)
      INTO sample USING other_driver_id;
    RETURN NEXT is(sample.visible, 0::bigint, source_view || ' excludes drivers from another tenant');
  END LOOP;

  listed := api.ui_list_resource_v1('driver_directory', '{}'::jsonb, 20, 0, NULL);
  RETURN NEXT is((
    SELECT value->>'customer_rating' FROM jsonb_array_elements(listed->'items')
    WHERE value->>'user_id' = driver_id::text
  )::numeric, 4::numeric, 'the scoped fleet list exposes the derived rating through the executor');
END;
$test$;

SELECT * FROM pg_temp.check_driver_delivery_kpis();
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
