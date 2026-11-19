-- pgTAP: Console V2 navigation must expose operator-safe domain labels.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

WITH items AS (
  SELECT item.value
  FROM public.settings s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
  WHERE s.category = 'ui_navigation'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM items
    WHERE COALESCE(value->>'route', value->>'href', '') = '/catalog/lookups'
      AND value->>'label' = 'Reference data'
  ),
  'global Console V2 navigation labels the lookup catalog as Reference data'
);

WITH items AS (
  SELECT item.value
  FROM public.settings s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
  WHERE s.category = 'ui_navigation'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM items
    WHERE COALESCE(value->>'route', value->>'href', '') = '/platform/access'
      AND value->>'label' = 'Access control'
  ),
  'global Console V2 navigation labels the RBAC/policy page as Access control'
);

WITH scoped_items AS (
  SELECT s.id AS settings_id, item.value
  FROM public.settings s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
  WHERE s.category = 'ui_navigation'
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM scoped_items
    WHERE (
      COALESCE(value->>'route', value->>'href', '') = '/catalog/lookups'
      AND value->>'label' IN ('Lookups', 'Lookups & enums')
    )
    OR (
      COALESCE(value->>'route', value->>'href', '') = '/platform/access'
      AND value->>'label' IN ('Access & RLS', 'RBAC roles')
    )
  ),
  'no scoped Console V2 navigation rows retain raw lookup/RBAC labels'
);

WITH scoped_navigation AS (
  SELECT s.id AS settings_id, s.cached_value
  FROM public.settings s
  WHERE s.category = 'ui_navigation'
    AND COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM scoped_navigation nav
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(nav.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE COALESCE(item.value->>'route', item.value->>'href', '') = '/platform/onboarding-readiness'
        AND item.value->>'label' = 'Onboarding readiness'
    )
  ),
  'every Console V2 navigation scope exposes onboarding readiness through the Platform section'
);

SELECT * FROM finish();

ROLLBACK;
