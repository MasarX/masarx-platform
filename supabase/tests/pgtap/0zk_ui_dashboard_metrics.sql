BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

SELECT has_function('public', 'ui_dashboard_metrics_v1', ARRAY['text[]']);
SELECT has_function('api', 'ui_dashboard_metrics_v1', ARRAY['text[]']);
SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_dashboard_metrics_v1(text[])', 'EXECUTE'),
  'anonymous callers cannot execute the dashboard facade'
);
SELECT is(api.ui_dashboard_metrics_v1(ARRAY[]::text[]), '{"metrics":[]}'::jsonb,
  'an empty resource list returns an empty metrics list');
SELECT throws_ok(
  $$SELECT api.ui_dashboard_metrics_v1(array_fill('shipments'::text, ARRAY[33]))$$,
  '22023', 'Too many dashboard resources in a single request', 'rejects oversized dashboard requests'
);
CREATE FUNCTION pg_temp.test_dashboard_tenant_total()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  tenant_id uuid := gen_random_uuid();
  foreign_tenant_id uuid := gen_random_uuid();
  client_id uuid := gen_random_uuid();
  foreign_client_id uuid := gen_random_uuid();
  actor_id uuid := gen_random_uuid();
  policy jsonb;
  policy_version integer;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES
    (tenant_id, 'Dashboard Fixture Tenant', 'dashboard-test-' || tenant_id),
    (foreign_tenant_id, 'Other Dashboard Fixture Tenant', 'dashboard-test-' || foreign_tenant_id);
  INSERT INTO public.clients (id, organization_id, name, slug, status) VALUES
    (client_id, tenant_id, 'Dashboard Fixture Client', 'dashboard-test-' || client_id, 'active'),
    (foreign_client_id, foreign_tenant_id, 'Other Dashboard Fixture Client', 'dashboard-test-' || foreign_client_id, 'active');
  INSERT INTO public.shipments (organization_id, client_id, service_type, tracking_number, status, box_count) VALUES
    (tenant_id, client_id, 'delivery', 'DASHBOARD-OWN-' || left(tenant_id::text, 8), 'pending', 1),
    (foreign_tenant_id, foreign_client_id, 'delivery', 'DASHBOARD-OTHER-' || left(foreign_tenant_id::text, 8), 'pending', 1);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
    VALUES (actor_id, tenant_id, 'dashboard-test-' || actor_id || '@example.test',
      'Dashboard Fixture Reader', 'ops_admin', 'active', 'tenant');

  SELECT p.policy INTO STRICT policy FROM public.resolve_access_control_policy_v1('tenant', tenant_id, FALSE) p;
  SELECT version INTO STRICT policy_version FROM public.schema_registry
    WHERE category = 'access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
  policy := jsonb_set(policy, '{roles}', policy->'roles' || jsonb_build_array(
    jsonb_build_object('key', 'dashboard_fixture_reader', 'capability_keys', jsonb_build_array('shipments.read'))));
  policy := jsonb_set(policy, '{assignments}', COALESCE(policy->'assignments', '{}'::jsonb) || jsonb_build_object(
    'user_id', COALESCE(policy#>'{assignments,user_id}', '{}'::jsonb) ||
      jsonb_build_object(actor_id::text, jsonb_build_array('dashboard_fixture_reader'))));
  PERFORM public.upsert_settings_value_v1(
    'access_control_policy', 'tenant', tenant_id, policy, policy_version, 'Rollback-only dashboard fixture');
  PERFORM set_config('request.jwt.claim.sub', actor_id::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', actor_id, 'role', 'authenticated', 'organization_id', tenant_id)::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.ui_dashboard_metrics_v1(ARRAY['shipments']),
    '{"metrics":[{"resource":"shipments","total":1}]}'::jsonb,
    'dashboard metrics count the caller tenant shipment and exclude the foreign tenant shipment');
  EXECUTE 'RESET ROLE';
END;
$test$;

SELECT * FROM pg_temp.test_dashboard_tenant_total();
SELECT * FROM finish();
ROLLBACK;
