BEGIN;

SELECT plan(3);

WITH global_nav AS (
  SELECT public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}' AS sections
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM global_nav,
         jsonb_array_elements(COALESCE(sections, '[]'::jsonb)) AS section(value),
         jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
    WHERE section.value->>'id' = 'network'
      AND COALESCE(item.value->>'route', item.value->>'href') = '/network/partners'
      AND item.value->>'capability' = 'marketplace.read'
  ),
  'global Console ui_navigation exposes Network Partners with marketplace.read'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)
    ) AS section(value)
    WHERE s.category = 'ui_navigation'
      AND section.value->>'id' = 'network'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
        WHERE COALESCE(item.value->>'route', item.value->>'href') = '/network/partners'
          AND item.value->>'capability' = 'marketplace.read'
      )
  ),
  'all Console ui_navigation settings rows expose Network Partners'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '11e390a1-90e8-4b2f-8cdd-0101f001cf11'::uuid,
  'Partner Finance Handoff Navigation Org',
  'partner-finance-handoff-navigation'
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
  '11e390a1-90e8-4b2f-8cdd-0101f001cf12'::uuid,
  '11e390a1-90e8-4b2f-8cdd-0101f001cf11'::uuid,
  'partner-finance-handoff-navigation@example.test',
  'Partner Finance Handoff Navigation Operator',
  'ops_admin',
  'tenant',
  NULL,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    user_type = EXCLUDED.user_type,
    access_scope_type = EXCLUDED.access_scope_type,
    status = EXCLUDED.status;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11e390a1-90e8-4b2f-8cdd-0101f001cf12', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '11e390a1-90e8-4b2f-8cdd-0101f001cf12',
    'role', 'authenticated',
    'email', 'partner-finance-handoff-navigation@example.test'
  )::text,
  true
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(public.ui_navigation_v1('console')->'sections', '[]'::jsonb)) AS section(value),
         jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
    WHERE section.value->>'id' = 'network'
      AND COALESCE(item.value->>'route', item.value->>'href') = '/network/partners'
      AND item.value->>'label' = 'Partners'
  ),
  'ui_navigation_v1(console) returns Partners to authenticated marketplace readers'
);

SELECT * FROM finish();

ROLLBACK;
