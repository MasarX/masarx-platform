-- pgTAP: Console V2 dashboard, import jobs, and service catalog navigation
-- must be discoverable through row-driven settings and backend RBAC, not
-- frontend-only seeds or raw database table pages.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('imports.read'),
      ('imports.write'),
      ('service_offerings.read'),
      ('service_offerings.write')
    ) AS required(permission_value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'rbac_permission'
        AND lv.value = required.permission_value
        AND lv.status = 'active'
    )
  ),
  'rbac_permission lookup registry includes import and service-offering capability values'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('ops_admin', 'imports.read'),
      ('ops_admin', 'imports.write'),
      ('ops_admin', 'service_offerings.read'),
      ('ops_admin', 'service_offerings.write'),
      ('agreements_admin', 'service_offerings.read'),
      ('agreements_admin', 'service_offerings.write')
    ) AS required(template_key, permission_value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.rbac_role_templates t
      JOIN public.rbac_role_template_permissions tp ON tp.role_template_id = t.id
      JOIN public.lookup_values lv ON lv.id = tp.permission_id
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'rbac_permission'
        AND t.key = required.template_key
        AND lv.value = required.permission_value
    )
  ),
  'role templates grant import and service-offering capabilities to canonical operator roles'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '184977ea-d790-4d3f-a352-349c6504e701'::uuid,
  'Console V2 Navigation Discoverability Org',
  'console-v2-navigation-discoverability'
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug;

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
  '184977ea-d790-4d3f-a352-349c6504e702'::uuid,
  '184977ea-d790-4d3f-a352-349c6504e701'::uuid,
  'console-v2-navigation-discoverability@example.test',
  'Console V2 Navigation Discoverability Operator',
  'ops_admin',
  'tenant',
  NULL,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    full_name = EXCLUDED.full_name,
    user_type = EXCLUDED.user_type,
    access_scope_type = EXCLUDED.access_scope_type,
    status = EXCLUDED.status;

SELECT public.provision_rbac_roles_from_templates_v1(
  '184977ea-d790-4d3f-a352-349c6504e701'::uuid,
  ARRAY['ops_admin'],
  '184977ea-d790-4d3f-a352-349c6504e702'::uuid
);

INSERT INTO public.rbac_user_role_assignments (
  organization_id,
  user_id,
  role_id,
  assigned_by_user_id,
  metadata
)
SELECT
  '184977ea-d790-4d3f-a352-349c6504e701'::uuid,
  '184977ea-d790-4d3f-a352-349c6504e702'::uuid,
  r.id,
  '184977ea-d790-4d3f-a352-349c6504e702'::uuid,
  jsonb_build_object('source', 'pgtap', 'template_key', r.key)
FROM public.rbac_roles r
WHERE r.organization_id = '184977ea-d790-4d3f-a352-349c6504e701'::uuid
  AND r.key = 'ops_admin'
ON CONFLICT DO NOTHING;

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('imports.read'),
      ('imports.write'),
      ('service_offerings.read'),
      ('service_offerings.write')
    ) AS required(permission_value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.rbac_roles r
      JOIN public.rbac_role_permissions rp ON rp.role_id = r.id
      JOIN public.lookup_values lv ON lv.id = rp.permission_id
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE r.organization_id = '184977ea-d790-4d3f-a352-349c6504e701'::uuid
        AND r.key = 'ops_admin'
        AND ld.category = 'rbac_permission'
        AND lv.value = required.permission_value
    )
  ),
  'provisioned ops_admin role receives import and service-offering permissions'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_navigation'
      AND COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) section(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) item(value)
        WHERE COALESCE(item.value->>'route', item.value->>'href') = '/'
          AND item.value->>'label' = 'Dashboard'
      )
  ),
  'every Console ui_navigation settings row exposes Dashboard'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_navigation'
      AND COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) section(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) item(value)
        WHERE COALESCE(item.value->>'route', item.value->>'href') = '/catalog/service-offerings'
          AND item.value->>'label' = 'Service offerings'
          AND item.value->>'capability' = 'service_offerings.read'
          AND item.value->>'icon' = 'tag'
      )
  ),
  'every Console ui_navigation settings row exposes Service offerings as a catalog workbench'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_navigation'
      AND COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) section(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) item(value)
        WHERE COALESCE(item.value->>'route', item.value->>'href') = '/platform/imports'
          AND item.value->>'label' = 'Import jobs'
          AND item.value->>'capability' = 'imports.read'
          AND item.value->>'icon' = 'inbox'
      )
  ),
  'every Console ui_navigation settings row exposes Import jobs through imports.read'
);

WITH navigation AS (
  SELECT public.resolve_settings_merged('ui_navigation', 'platform', NULL::uuid)#>'{apps,console,sections}' AS sections
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM navigation,
         jsonb_array_elements(COALESCE(sections, '[]'::jsonb)) section(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) item(value)
    WHERE COALESCE(item.value->>'route', item.value->>'href') = '/'
      AND item.value->>'label' = 'Dashboard'
  ),
  'merged platform navigation contains Dashboard'
);

WITH navigation AS (
  SELECT public.resolve_settings_merged('ui_navigation', 'platform', NULL::uuid)#>'{apps,console,sections}' AS sections
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM navigation,
         jsonb_array_elements(COALESCE(sections, '[]'::jsonb)) section(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) item(value)
    WHERE COALESCE(item.value->>'route', item.value->>'href') = '/catalog/service-offerings'
      AND item.value->>'resource' = 'service_offering_directory'
      AND item.value->>'capability' = 'service_offerings.read'
  ),
  'merged platform navigation contains Service offerings with the canonical directory resource'
);

WITH navigation AS (
  SELECT public.resolve_settings_merged('ui_navigation', 'platform', NULL::uuid)#>'{apps,console,sections}' AS sections
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM navigation,
         jsonb_array_elements(COALESCE(sections, '[]'::jsonb)) section(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) item(value)
    WHERE COALESCE(item.value->>'route', item.value->>'href') = '/platform/imports'
      AND item.value->>'resource' = 'import_jobs'
      AND item.value->>'capability' = 'imports.read'
  ),
  'merged platform navigation contains Import jobs with read access'
);

SELECT ok(
  pg_get_functiondef('public.confirm_route_run_departure_v1(jsonb)'::regprocedure)
    LIKE '%assert_capability_v1(''tasks.complete''%',
  'canonical departure confirmation requires tasks.complete before mutation'
);

SELECT ok(
  pg_get_functiondef('public.confirm_route_run_departure_v1(jsonb)'::regprocedure)
    LIKE '%user_has_capability_v1(''routes.write''%',
  'canonical departure confirmation checks routes.write for operator route ownership'
);

SELECT ok(
  pg_get_functiondef('api.route_run_scan_out_reconciliation_v1(uuid)'::regprocedure)
    LIKE '%assert_capability_v1(%''routes.read''%',
  'browser scan-out reconciliation wrapper is read-scoped through routes.read'
);

SELECT ok(
  pg_get_functiondef('api.route_plan_validate_constraints_v1(uuid)'::regprocedure)
    LIKE '%ui_get_resource_v1(''route_plans''%'
    AND pg_get_functiondef('api.route_plan_validate_constraints_v1(uuid)'::regprocedure)
      NOT LIKE '%assert_capability_v1(%''route_plans.write''%',
  'browser route-plan constraint validation is visible-read scoped, not write gated'
);

WITH registry AS (
  SELECT public.resolve_settings_merged('ui_read_registry', 'platform', NULL::uuid)->'resources' AS resources
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM registry,
         jsonb_array_elements(COALESCE(resources, '[]'::jsonb)) resource(value)
    WHERE resource.value->>'key' = 'import_jobs'
      AND resource.value->>'relation' = 'public.import_jobs'
      AND resource.value->>'capability_read' = 'imports.read'
      AND resource.value->>'capability_write' = 'imports.write'
  ),
  'ui_read_registry exposes canonical import_jobs SSOT for Console V2'
);

WITH registry AS (
  SELECT public.resolve_settings_merged('ui_read_registry', 'platform', NULL::uuid)->'resources' AS resources
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM registry,
         jsonb_array_elements(COALESCE(resources, '[]'::jsonb)) resource(value)
    WHERE resource.value->>'key' = 'import_job_directory'
      AND resource.value->>'relation' = 'public.v_import_job_directory'
      AND resource.value->>'capability_read' = 'imports.read'
  ),
  'ui_read_registry exposes import_job_directory projection for Console V2'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_read_registry'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) resource(value)
          WHERE resource.value->>'key' = 'import_jobs'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) resource(value)
          WHERE resource.value->>'key' = 'import_job_directory'
        )
      )
  ),
  'every scoped ui_read_registry settings row exposes import job resources'
);

SET LOCAL ROLE authenticated;

SELECT set_config('request.jwt.claim.sub', '184977ea-d790-4d3f-a352-349c6504e702', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '184977ea-d790-4d3f-a352-349c6504e702',
    'role', 'authenticated',
    'email', 'console-v2-navigation-discoverability@example.test'
  )::text,
  true
);

WITH navigation AS (
  SELECT public.ui_navigation_v1('console') AS payload
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('/'),
      ('/catalog/service-offerings'),
      ('/platform/imports')
    ) AS required(route)
    WHERE NOT EXISTS (
      SELECT 1
      FROM navigation,
           jsonb_array_elements(COALESCE(payload->'sections', '[]'::jsonb)) section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) item(value)
      WHERE item.value->>'route' = required.route
    )
  ),
  'authenticated Console ui_navigation_v1 returns dashboard, service offerings, and import jobs'
);

SELECT * FROM finish();

ROLLBACK;
