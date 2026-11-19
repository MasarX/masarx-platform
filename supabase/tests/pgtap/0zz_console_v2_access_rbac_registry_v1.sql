-- pgTAP: Console V2 Access Control RBAC resources are registered through
-- backend-backed, security-invoker projections instead of unknown/raw tables.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(19);

SELECT ok(
  (
    SELECT bool_and(resource ? 'key')
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' IN (
       'rbac_roles',
       'rbac_role_summary',
       'rbac_role_permissions',
       'rbac_user_role_assignments',
       'rbac_role_templates'
     )
  ),
  'global read registry carries all RBAC Access Control resources'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'rbac_roles'
  ),
  'public.v_rbac_role_summary',
  'rbac_roles reads the canonical role summary projection'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'rbac_role_summary'
  ),
  'public.v_rbac_role_summary',
  'rbac_role_summary reads the canonical role summary projection'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'rbac_role_permissions'
  ),
  'public.v_rbac_role_permission_directory',
  'rbac_role_permissions reads the role-permission directory projection'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'rbac_user_role_assignments'
  ),
  'public.v_rbac_user_role_assignment_directory',
  'rbac_user_role_assignments reads the user-role assignment directory projection'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'rbac_role_templates'
  ),
  'public.v_rbac_role_template_directory',
  'rbac_role_templates reads the role-template directory projection'
);

SELECT is(
  (
    SELECT resource->>'capability_read'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'rbac_roles'
  ),
  'access_policy.read',
  'RBAC role reads are gated by access_policy.read'
);

SELECT is(
  (
    SELECT resource->>'capability_write'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'rbac_roles'
  ),
  'access_policy.approve',
  'RBAC role writes are gated by access_policy.approve'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' IN (
       'rbac_roles',
       'rbac_role_summary',
       'rbac_role_permissions',
       'rbac_user_role_assignments',
       'rbac_role_templates'
     )
       AND COALESCE((resource->>'allow_view_relation')::boolean, false) IS DISTINCT FROM true
  ),
  'all RBAC registry entries explicitly allow security-invoker view relations'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_rbac_role_summary'::regclass),
  '{security_invoker=true}',
  'v_rbac_role_summary remains security_invoker'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_rbac_role_permission_directory'::regclass),
  '{security_invoker=true}',
  'v_rbac_role_permission_directory is security_invoker'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_rbac_user_role_assignment_directory'::regclass),
  '{security_invoker=true}',
  'v_rbac_user_role_assignment_directory is security_invoker'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_rbac_role_template_directory'::regclass),
  '{security_invoker=true}',
  'v_rbac_role_template_directory is security_invoker'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND EXISTS (
         SELECT wanted.key
           FROM (VALUES
             ('rbac_roles'),
             ('rbac_role_summary'),
             ('rbac_role_permissions'),
             ('rbac_user_role_assignments'),
             ('rbac_role_templates')
           ) AS wanted(key)
          WHERE NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
             WHERE resource->>'key' = wanted.key
               AND resource->>'capability_read' = 'access_policy.read'
               AND COALESCE((resource->>'allow_view_relation')::boolean, false)
          )
       )
  ),
  'all scoped read registries expose RBAC resources with access_policy.read'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'b313cf84-6843-4b3e-8f13-a203ca715bcf'::uuid,
  'Console V2 RBAC Registry Org',
  'console-v2-rbac-registry-org'
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
VALUES (
  'b79c0884-f290-45ea-9fbc-4f61c44cdf26'::uuid,
  'b313cf84-6843-4b3e-8f13-a203ca715bcf'::uuid,
  'console-v2-rbac-registry@example.test',
  'Console V2 RBAC Registry Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', 'b79c0884-f290-45ea-9fbc-4f61c44cdf26', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'b79c0884-f290-45ea-9fbc-4f61c44cdf26',
    'role', 'authenticated',
    'email', 'console-v2-rbac-registry@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('rbac_roles', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'rbac_roles lists through ui_list_resource_v1'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('rbac_role_summary', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'rbac_role_summary lists through ui_list_resource_v1'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('rbac_role_permissions', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'rbac_role_permissions lists through ui_list_resource_v1'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('rbac_user_role_assignments', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'rbac_user_role_assignments lists through ui_list_resource_v1'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('rbac_role_templates', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'rbac_role_templates lists through ui_list_resource_v1'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
