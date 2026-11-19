-- pgTAP: Console V2 Organizations tenant-review navigation is platform-scoped.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'd4af602b-755b-4bb2-8140-5b6435be1e89'::uuid,
  'Console V2 Navigation Scope Org',
  'console-v2-navigation-scope-d4af602b'
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
  'fe3ad914-249f-45a6-b91c-65c255c0a24d'::uuid,
  'd4af602b-755b-4bb2-8140-5b6435be1e89'::uuid,
  'console-v2-nav-platform@example.test',
  'Console V2 Navigation Platform Reviewer',
  'super_admin',
  'platform',
  NULL,
  'active'
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
  'a85e63b1-4dc8-4026-a2b3-118565d3fa33'::uuid,
  'd4af602b-755b-4bb2-8140-5b6435be1e89'::uuid,
  'console-v2-nav-account-manager@example.test',
  'Console V2 Navigation Account Manager',
  'account_manager',
  'tenant',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
     WHERE s.category = 'ui_navigation'
       AND COALESCE(item->>'route', item->>'href') IN ('/platform/organizations', '/console/organizations/requests')
  ),
  'active ui_navigation settings include the Organizations tenant-review route'
);

SELECT is(
  (
    SELECT COUNT(*)::int
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
     WHERE s.category = 'ui_navigation'
       AND COALESCE(item->>'route', item->>'href') IN ('/platform/organizations', '/console/organizations/requests')
       AND COALESCE(item->>'required_scope_type', '') <> 'platform'
  ),
  0,
  'all active Organizations tenant-review nav items require platform scope'
);

SELECT is(
  (
    SELECT COUNT(*)::int
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
     WHERE s.category = 'ui_navigation'
       AND COALESCE(item->>'route', item->>'href') IN ('/platform/organizations', '/console/organizations/requests')
       AND NOT (
         COALESCE(item->'capabilities', '[]'::jsonb) @> to_jsonb('organizations.read'::text)
         AND COALESCE(item->'capabilities', '[]'::jsonb) @> to_jsonb('tenant_signup_requests.read'::text)
       )
  ),
  0,
  'Organizations tenant-review nav items preserve both organization and signup-request read reachability'
);

SELECT set_config('request.jwt.claim.sub', 'fe3ad914-249f-45a6-b91c-65c255c0a24d', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'fe3ad914-249f-45a6-b91c-65c255c0a24d',
    'role', 'authenticated',
    'email', 'console-v2-nav-platform@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_navigation_v1('console')->'sections') section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
     WHERE COALESCE(item->>'route', item->>'href') IN ('/platform/organizations', '/console/organizations/requests')
       AND item->>'required_scope_type' = 'platform'
  ),
  'platform reviewer ui_navigation_v1 payload carries platform-scope requirement'
);

RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'a85e63b1-4dc8-4026-a2b3-118565d3fa33', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'a85e63b1-4dc8-4026-a2b3-118565d3fa33',
    'role', 'authenticated',
    'email', 'console-v2-nav-account-manager@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_navigation_v1('console')->'sections') section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
     WHERE COALESCE(item->>'route', item->>'href') IN ('/platform/organizations', '/console/organizations/requests')
       AND item->>'required_scope_type' = 'platform'
  ),
  'tenant account-manager ui_navigation_v1 payload carries the same platform-scope requirement for frontend denial'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
