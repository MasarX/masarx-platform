SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

SELECT has_function('api', 'pickup_vehicle_lookup_v1', ARRAY['uuid', 'integer'], 'pickup vehicle lookup exists');
SELECT ok(has_function_privilege('authenticated', 'api.pickup_vehicle_lookup_v1(uuid, integer)', 'EXECUTE'), 'authenticated may call scoped lookup');
SELECT ok(has_function_privilege('service_role', 'api.pickup_vehicle_lookup_v1(uuid, integer)', 'EXECUTE'), 'service role may call scoped lookup');
SELECT ok(NOT has_function_privilege('anon', 'api.pickup_vehicle_lookup_v1(uuid, integer)', 'EXECUTE'), 'anonymous lookup is forbidden');

CREATE OR REPLACE FUNCTION pg_temp.test_pickup_vehicle_lookup_v1()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  own_org UUID := gen_random_uuid();
  foreign_org UUID := gen_random_uuid();
  operator_id UUID := gen_random_uuid();
  denied_id UUID := gen_random_uuid();
  client_id UUID := gen_random_uuid();
  active_vehicle UUID := gen_random_uuid();
  inactive_vehicle UUID := gen_random_uuid();
  disabled_vehicle UUID := gen_random_uuid();
  foreign_vehicle UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations(id, name, slug) VALUES
    (own_org, 'Pickup Lookup Fixture', 'pickup-lookup-' || left(own_org::text, 8)),
    (foreign_org, 'Other Pickup Lookup Fixture', 'pickup-lookup-' || left(foreign_org::text, 8));
  INSERT INTO public.users(id, organization_id, email, full_name, access_scope_type) VALUES
    (operator_id, own_org, 'pickup-' || left(operator_id::text, 8) || '@example.test', 'Fleet fixture', 'tenant'),
    (denied_id, own_org, 'pickup-' || left(denied_id::text, 8) || '@example.test', 'Denied fixture', 'tenant');
  PERFORM public.provision_rbac_roles_from_templates_v1(own_org, ARRAY['fleet_manager'], operator_id);
  INSERT INTO public.rbac_user_role_assignments(organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT own_org, operator_id, r.id, operator_id, '{"source":"pgtap"}'::jsonb
  FROM public.rbac_roles r WHERE r.organization_id = own_org AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;
  INSERT INTO public.vehicles(id, organization_id, status, is_active, plate_number) VALUES
    (active_vehicle, own_org, 'active', TRUE, 'FIXTURE-42'),
    (inactive_vehicle, own_org, 'inactive', TRUE, 'INACTIVE-42'),
    (disabled_vehicle, own_org, 'active', FALSE, 'DISABLED-42'),
    (foreign_vehicle, foreign_org, 'active', TRUE, 'OTHER-42');
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', operator_id::text,
    'organization_id', own_org::text, 'access_scope_type', 'tenant')::text, true);
  PERFORM set_config('request.jwt.claim.sub', operator_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.user_has_permission_v1('fleet.write', own_org), 'fixture operator has fleet.write');
  RETURN NEXT is((SELECT count(*) FROM api.pickup_vehicle_lookup_v1(own_org, 250)), 1::bigint, 'only own active enabled vehicle is returned');
  RETURN NEXT is((SELECT label FROM api.pickup_vehicle_lookup_v1(own_org, 250)), 'FIXTURE-42', 'vehicle choice has a readable plate label');
  RETURN NEXT is((SELECT vehicle_id::text FROM api.pickup_vehicle_lookup_v1(NULL, 250)), active_vehicle::text, 'null organization binds current tenant');
  RETURN NEXT is((SELECT count(*) FROM api.pickup_vehicle_lookup_v1(foreign_org, 250)), 0::bigint, 'explicit foreign organization cannot override current tenant');
  RETURN NEXT is((SELECT count(*) FROM api.pickup_vehicle_lookup_v1(own_org, 0)), 1::bigint, 'nonpositive limit remains bounded');
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', denied_id::text,
    'organization_id', own_org::text, 'access_scope_type', 'tenant')::text, true);
  PERFORM set_config('request.jwt.claim.sub', denied_id::text, true);
  RETURN NEXT is((SELECT count(*) FROM api.pickup_vehicle_lookup_v1(own_org, 250)), 0::bigint, 'tenant without fleet.write cannot enumerate vehicles');
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.clients(id, organization_id, name, slug, status)
  VALUES (client_id, own_org, 'Lookup Client', 'lookup-' || left(client_id::text, 8), 'active');
  UPDATE public.users SET access_scope_type = 'client', access_scope_id = client_id WHERE id = operator_id;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', operator_id::text,
    'organization_id', own_org::text, 'access_scope_type', 'client')::text, true);
  PERFORM set_config('request.jwt.claim.sub', operator_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT count(*) FROM api.pickup_vehicle_lookup_v1(own_org, 250)), 0::bigint, 'client scope cannot use tenant vehicle lookup');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is((SELECT vehicle_id::text FROM api.pickup_vehicle_lookup_v1(foreign_org, 250)), foreign_vehicle::text, 'service role retains explicit organization authority');
END;
$test$;
SELECT * FROM pg_temp.test_pickup_vehicle_lookup_v1();
SELECT * FROM finish();
ROLLBACK;
