-- pgTAP: Console V2 fleet lifecycle views require scoped ui_read_registry
-- coverage for every related fleet resource the operator pages read.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(16);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('driver_directory'),
      ('driver_application_directory'),
      ('driver_documents'),
      ('driver_compliance_events'),
      ('drivers'),
      ('hubs'),
      ('fleet_user_options'),
      ('vehicle_directory'),
      ('vehicle_assignments'),
      ('vehicle_documents'),
      ('vehicle_types'),
      ('vehicle_events'),
      ('vehicle_maintenance_directory')
    ) AS required(resource_key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
      WHERE r.value->>'key' = required.resource_key
    )
  ),
  'global ui_read_registry exposes every resource needed by the fleet lifecycle screens'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_read_registry'
      AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
      AND EXISTS (
        SELECT 1
        FROM (VALUES
          ('driver_directory'),
          ('driver_application_directory'),
          ('driver_documents'),
          ('driver_compliance_events'),
          ('drivers'),
          ('hubs'),
          ('fleet_user_options'),
          ('vehicle_directory'),
          ('vehicle_assignments'),
          ('vehicle_documents'),
          ('vehicle_types'),
          ('vehicle_events'),
          ('vehicle_maintenance_directory')
        ) AS required(resource_key)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) sr(value)
          WHERE sr.value->>'key' = required.resource_key
        )
      )
  ),
  'scoped ui_read_registry rows include every related fleet lifecycle resource'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('driver_directory', 'public.v_driver_directory', 'fleet.read'),
      ('driver_application_directory', 'public.v_driver_application_directory', 'fleet.read'),
      ('driver_documents', 'public.driver_documents', 'fleet.read'),
      ('driver_compliance_events', 'public.driver_compliance_events', 'fleet.read'),
      ('drivers', 'public.driver_profile_picker_v1', 'fleet.read'),
      ('hubs', 'public.hubs', 'fleet.read'),
      ('fleet_user_options', 'public.users', 'fleet.write'),
      ('vehicle_directory', 'public.v_vehicle_directory', 'fleet.read'),
      ('vehicle_assignments', 'public.v_vehicle_assignment_directory', 'fleet.read'),
      ('vehicle_documents', 'public.vehicle_documents', 'fleet.read'),
      ('vehicle_types', 'public.v_vehicle_type_directory', 'fleet.read'),
      ('vehicle_events', 'public.v_vehicle_event_directory', 'fleet.read'),
      ('vehicle_maintenance_directory', 'public.v_vehicle_maintenance_directory', 'fleet.read')
    ) AS expected(resource_key, relation_name, capability_read)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
      WHERE r.value->>'key' = expected.resource_key
        AND r.value->>'relation' = expected.relation_name
        AND r.value->>'capability_read' = expected.capability_read
    )
  ),
  'fleet lifecycle registry resources use exact canonical relations and capability gates'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.value->'filters', '[]'::jsonb)) f(value)
    WHERE r.value->>'key' IN (
      'driver_documents',
      'driver_compliance_events',
      'vehicle_assignments',
      'vehicle_documents',
      'vehicle_types',
      'vehicle_events'
    )
      AND f.value->>'column' IN ('driver_id', 'kind', 'occurred_at_created_at')
  ),
  'fleet registry filters avoid legacy frontend aliases that do not exist on live relations'
);

SELECT ok(
  public.resolve_settings_merged('ui_navigation', 'platform', NULL::uuid)#>'{apps,console,sections}'
    @> jsonb_build_array(
      jsonb_build_object(
        'id', 'operations',
        'items', jsonb_build_array(
          jsonb_build_object('id', 'operate-fleet-drivers', 'route', '/operate/fleet/drivers', 'resource', 'drivers'),
          jsonb_build_object('id', 'operate-fleet-vehicles', 'route', '/operate/fleet/vehicles', 'resource', 'vehicle_directory'),
          jsonb_build_object('id', 'operate-fleet-driver-applications', 'route', '/operate/fleet/driver-applications', 'resource', 'driver_application_directory')
        )
      )
    ),
  'global ui_navigation exposes Console V2 fleet workbench routes'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_navigation'
      AND COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT (
        s.cached_value#>'{apps,console,sections}'
          @> jsonb_build_array(
            jsonb_build_object(
              'id', 'operations',
              'items', jsonb_build_array(
                jsonb_build_object('id', 'operate-fleet-drivers', 'route', '/operate/fleet/drivers', 'resource', 'drivers'),
                jsonb_build_object('id', 'operate-fleet-vehicles', 'route', '/operate/fleet/vehicles', 'resource', 'vehicle_directory'),
                jsonb_build_object('id', 'operate-fleet-driver-applications', 'route', '/operate/fleet/driver-applications', 'resource', 'driver_application_directory')
              )
            )
          )
      )
  ),
  'scoped ui_navigation rows expose Console V2 fleet workbench routes'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'Console V2 Fleet Registry Org',
  'console-v2-fleet-registry-ac65f701'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES
(
  '253d3fab-d32d-4669-8ca1-27978cb95f04'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'console-v2-fleet-registry@example.test',
  'Console V2 Fleet Registry Manager',
  'fleet_manager',
  'tenant',
  NULL,
  'active'
),
(
  '293441e4-67fc-4f76-93a4-36a9f029cf9e'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'console-v2-fleet-registry-denied@example.test',
  'Console V2 Fleet Registry Denied',
  'client_admin',
  'tenant',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT public.provision_rbac_roles_from_templates_v1(
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  ARRAY['fleet_manager'],
  '253d3fab-d32d-4669-8ca1-27978cb95f04'::uuid
);

INSERT INTO public.rbac_user_role_assignments (
  organization_id,
  user_id,
  role_id,
  assigned_by_user_id,
  metadata
)
SELECT
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  '253d3fab-d32d-4669-8ca1-27978cb95f04'::uuid,
  r.id,
  '253d3fab-d32d-4669-8ca1-27978cb95f04'::uuid,
  jsonb_build_object('source', 'pgtap', 'template_key', r.key)
FROM public.rbac_roles r
WHERE r.organization_id = 'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid
  AND r.key = 'fleet_manager'
ON CONFLICT DO NOTHING;

INSERT INTO public.branches (
  id,
  organization_id,
  code,
  name,
  branch_type,
  timezone,
  is_active,
  metadata
)
VALUES (
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14311'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'fleet-registry-ruh',
  'Fleet Registry Riyadh Hub',
  'warehouse',
  'Asia/Riyadh',
  TRUE,
  jsonb_build_object('source', 'pgtap')
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    metadata = EXCLUDED.metadata;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  '253d3fab-d32d-4669-8ca1-27978cb95f14'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'console-v2-fleet-driver@example.test',
  'Console V2 Fleet Driver',
  'driver',
  'tenant',
  NULL,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET full_name = EXCLUDED.full_name,
    status = EXCLUDED.status;

INSERT INTO public.driver_profiles (
  id,
  organization_id,
  user_id,
  driver_code,
  status,
  metadata
)
VALUES (
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14321'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  '253d3fab-d32d-4669-8ca1-27978cb95f14'::uuid,
  'PGTAP-FLEET-DRV',
  'active',
  jsonb_build_object('source', 'pgtap')
)
ON CONFLICT (id) DO UPDATE
SET driver_code = EXCLUDED.driver_code,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata;

INSERT INTO public.vehicle_types (
  id,
  organization_id,
  key,
  name,
  is_active,
  metadata
)
VALUES (
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14331'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'pgtap_fleet_van',
  'pgTAP Fleet Van',
  TRUE,
  jsonb_build_object(
    'capacity_kg', '750',
    'capacity_m3', '5.5',
    'fuel_type', 'diesel',
    'source', 'pgtap'
  )
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    metadata = EXCLUDED.metadata;

INSERT INTO public.vehicles (
  id,
  organization_id,
  branch_id,
  vehicle_type_id,
  status,
  plate_number,
  is_active,
  metadata
)
VALUES (
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14341'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14311'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14331'::uuid,
  'active',
  'PGTAP-501',
  TRUE,
  jsonb_build_object('source', 'pgtap')
)
ON CONFLICT (id) DO UPDATE
SET plate_number = EXCLUDED.plate_number,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata;

INSERT INTO public.vehicle_assignments (
  id,
  organization_id,
  vehicle_id,
  assigned_to_user_id,
  branch_id,
  status,
  started_at,
  metadata
)
VALUES (
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14351'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14341'::uuid,
  '253d3fab-d32d-4669-8ca1-27978cb95f14'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14311'::uuid,
  'active',
  now() - interval '1 day',
  jsonb_build_object('source', 'pgtap')
)
ON CONFLICT (id) DO UPDATE
SET assigned_to_user_id = EXCLUDED.assigned_to_user_id,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata;

INSERT INTO public.vehicle_events (
  id,
  organization_id,
  vehicle_id,
  event_type,
  occurred_at,
  odometer_km,
  actor_user_id,
  notes,
  metadata
)
VALUES (
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14361'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14341'::uuid,
  'inspection',
  now(),
  12000,
  '253d3fab-d32d-4669-8ca1-27978cb95f04'::uuid,
  'pgTAP live projection event',
  jsonb_build_object('health', 'ok', 'source', 'pgtap')
)
ON CONFLICT (id) DO UPDATE
SET event_type = EXCLUDED.event_type,
    metadata = EXCLUDED.metadata;

INSERT INTO public.vehicle_documents (
  id,
  organization_id,
  vehicle_id,
  doc_type,
  issuer,
  issued_at,
  expires_at,
  status,
  metadata
)
VALUES (
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14371'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'::uuid,
  'ac65f701-2b52-4efd-9b9f-f9e8c5f14341'::uuid,
  'registration',
  'pgTAP Fleet Authority',
  current_date - 30,
  current_date + 365,
  'submitted',
  jsonb_build_object('source', 'pgtap')
)
ON CONFLICT (id) DO UPDATE
SET issuer = EXCLUDED.issuer,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata;

-- The users RLS predicate resolves capabilities through access_control_policy.
DO $fleet_fixture$
DECLARE
  v_org CONSTANT uuid := 'ac65f701-2b52-4efd-9b9f-f9e8c5f14301';
  v_actor CONSTANT uuid := '253d3fab-d32d-4669-8ca1-27978cb95f04';
  v_policy jsonb;
  v_schema integer;
BEGIN
  SELECT policy INTO STRICT v_policy
    FROM public.resolve_access_control_policy_v1('tenant', v_org, FALSE);
  SELECT version INTO v_schema FROM public.schema_registry
   WHERE category = 'access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
  v_policy := jsonb_set(v_policy, '{roles}', v_policy->'roles' || jsonb_build_array(
    jsonb_build_object('key', 'pgtap_fleet_user_read', 'capability_keys', jsonb_build_array('users.read'))
  ));
  v_policy := jsonb_set(v_policy, '{assignments,user_id}',
    COALESCE(v_policy#>'{assignments,user_id}', '{}'::jsonb)
      || jsonb_build_object(v_actor, jsonb_build_array('pgtap_fleet_user_read')));
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org,
    v_policy, v_schema, 'Fixture capability for fleet driver labels');
END;
$fleet_fixture$;

SET LOCAL ROLE authenticated;

SELECT set_config('request.jwt.claim.sub', '253d3fab-d32d-4669-8ca1-27978cb95f04', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '253d3fab-d32d-4669-8ca1-27978cb95f04',
    'role', 'authenticated',
    'email', 'console-v2-fleet-registry@example.test'
  )::text,
  true
);

DO $driver_probe$
DECLARE
  v_resource TEXT;
  v_result JSONB;
BEGIN
  FOREACH v_resource IN ARRAY ARRAY[
    'driver_directory',
    'driver_application_directory',
    'driver_documents',
    'driver_compliance_events',
    'drivers',
    'hubs',
    'fleet_user_options',
    'vehicle_directory',
    'vehicle_assignments'
  ] LOOP
    v_result := api.ui_list_resource_v1(v_resource, '{}'::jsonb, 2, 0, NULL::jsonb);

    IF v_result->>'resource' IS DISTINCT FROM v_resource THEN
      RAISE EXCEPTION 'fleet lifecycle driver dependency read returned malformed payload for %', v_resource;
    END IF;
  END LOOP;
END;
$driver_probe$;

SELECT pass('fleet_manager can read every driver screen dependency through api.ui_list_resource_v1');

DO $vehicle_probe$
DECLARE
  v_resource TEXT;
  v_result JSONB;
BEGIN
  FOREACH v_resource IN ARRAY ARRAY[
    'vehicle_directory',
    'vehicle_types',
    'vehicle_assignments',
    'vehicle_events',
    'vehicle_documents',
    'vehicle_maintenance_directory',
    'hubs',
    'drivers'
  ] LOOP
    v_result := api.ui_list_resource_v1(v_resource, '{}'::jsonb, 2, 0, NULL::jsonb);

    IF v_result->>'resource' IS DISTINCT FROM v_resource THEN
      RAISE EXCEPTION 'fleet lifecycle vehicle dependency read returned malformed payload for %', v_resource;
    END IF;
  END LOOP;
END;
$vehicle_probe$;

SELECT pass('fleet_manager can read every vehicle screen dependency through api.ui_list_resource_v1');

WITH v_navigation AS (
  SELECT public.ui_navigation_v1('console') AS payload
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM v_navigation,
         jsonb_array_elements(COALESCE(payload->'sections', '[]'::jsonb)) AS section(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
    WHERE section.value->>'id' IN ('operations', 'operate')
      AND item.value->>'route' IN (
        '/operate/fleet/drivers',
        '/operate/fleet/vehicles',
        '/operate/fleet/driver-applications'
      )
    GROUP BY section.value->>'id'
    HAVING COUNT(DISTINCT item.value->>'route') = 3
  ),
  'ui_navigation_v1(console) returns fleet workbench routes to an authenticated fleet manager'
);

WITH v_payload AS (
  SELECT api.ui_list_resource_v1(
    'drivers',
    jsonb_build_object('id', '253d3fab-d32d-4669-8ca1-27978cb95f14'),
    5,
    0,
    NULL::jsonb
  ) AS result
),
v_rows AS (
  SELECT COALESCE(result->'rows', result->'items', '[]'::jsonb) AS rows
  FROM v_payload
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM v_rows, jsonb_array_elements(v_rows.rows) row(value)
    WHERE row.value->>'id' = '253d3fab-d32d-4669-8ca1-27978cb95f14'
      AND row.value->>'organization_id' = 'ac65f701-2b52-4efd-9b9f-f9e8c5f14301'
      AND row.value->>'vehicle_id' = 'ac65f701-2b52-4efd-9b9f-f9e8c5f14341'
      AND row.value->>'name' = 'Console V2 Fleet Driver'
  ),
  'drivers resource returns assignment-picker row shape from live API projection'
);

WITH v_payload AS (
  SELECT api.ui_list_resource_v1(
    'vehicle_assignments',
    jsonb_build_object('vehicle_id', 'ac65f701-2b52-4efd-9b9f-f9e8c5f14341'),
    5,
    0,
    NULL::jsonb
  ) AS result
),
v_rows AS (
  SELECT COALESCE(result->'rows', result->'items', '[]'::jsonb) AS rows
  FROM v_payload
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM v_rows, jsonb_array_elements(v_rows.rows) row(value)
    WHERE row.value->>'id' = 'ac65f701-2b52-4efd-9b9f-f9e8c5f14351'
      AND row.value->>'driver_user_id' = '253d3fab-d32d-4669-8ca1-27978cb95f14'
      AND row.value->>'driver_name' = 'Console V2 Fleet Driver'
  ),
  'vehicle_assignments resource returns operator-facing driver lineage from live API projection'
);

WITH v_payload AS (
  SELECT api.ui_list_resource_v1(
    'vehicle_events',
    jsonb_build_object('vehicle_id', 'ac65f701-2b52-4efd-9b9f-f9e8c5f14341'),
    5,
    0,
    NULL::jsonb
  ) AS result
),
v_rows AS (
  SELECT COALESCE(result->'rows', result->'items', '[]'::jsonb) AS rows
  FROM v_payload
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM v_rows, jsonb_array_elements(v_rows.rows) row(value)
    WHERE row.value->>'id' = 'ac65f701-2b52-4efd-9b9f-f9e8c5f14361'
      AND row.value->>'actor_name' = 'Console V2 Fleet Registry Manager'
      AND row.value->'metadata'->>'health' = 'ok'
      AND NOT (row.value ? 'payload')
  ),
  'vehicle events expose actor name and declared metadata through the safe projection'
);

WITH v_payload AS (
  SELECT api.ui_list_resource_v1(
    'vehicle_types',
    jsonb_build_object('key', 'pgtap_fleet_van'),
    5,
    0,
    NULL::jsonb
  ) AS result
),
v_rows AS (
  SELECT COALESCE(result->'rows', result->'items', '[]'::jsonb) AS rows
  FROM v_payload
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM v_rows, jsonb_array_elements(v_rows.rows) row(value)
    WHERE row.value->>'id' = 'ac65f701-2b52-4efd-9b9f-f9e8c5f14331'
      AND row.value->>'capacity_kg' = '750'
      AND row.value->>'fuel_type' = 'diesel'
  ),
  'vehicle_types resource returns top-level capacity fields from live API projection'
);

WITH v_payload AS (
  SELECT api.ui_list_resource_v1(
    'vehicle_documents',
    jsonb_build_object('vehicle_id', 'ac65f701-2b52-4efd-9b9f-f9e8c5f14341'),
    5,
    0,
    NULL::jsonb
  ) AS result
),
v_rows AS (
  SELECT COALESCE(result->'rows', result->'items', '[]'::jsonb) AS rows
  FROM v_payload
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM v_rows, jsonb_array_elements(v_rows.rows) row(value)
    WHERE row.value->>'id' = 'ac65f701-2b52-4efd-9b9f-f9e8c5f14371'
      AND row.value->>'vehicle_id' = 'ac65f701-2b52-4efd-9b9f-f9e8c5f14341'
      AND row.value->>'issuer' = 'pgTAP Fleet Authority'
      AND row.value->>'doc_type' = 'registration'
      AND row.value->>'status' = 'submitted'
  ),
  'vehicle_documents resource returns vehicle-scoped document rows through live API'
);

SELECT set_config('request.jwt.claim.sub', '293441e4-67fc-4f76-93a4-36a9f029cf9e', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '293441e4-67fc-4f76-93a4-36a9f029cf9e',
    'role', 'authenticated',
    'email', 'console-v2-fleet-registry-denied@example.test'
  )::text,
  true
);

SELECT throws_ok(
  $$ SELECT api.ui_list_resource_v1('driver_directory', '{}'::jsonb, 2, 0, NULL::jsonb) $$,
  '42501',
  NULL,
  'tenant user without fleet.read cannot read driver_directory'
);

SELECT throws_ok(
  $$ SELECT api.ui_list_resource_v1('vehicle_directory', '{}'::jsonb, 2, 0, NULL::jsonb) $$,
  '42501',
  NULL,
  'tenant user without fleet.read cannot read vehicle_directory'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
