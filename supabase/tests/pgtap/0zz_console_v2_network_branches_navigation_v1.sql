-- pgTAP: Console V2 live navigation exposes network branches.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

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
    WHERE COALESCE(value->>'route', value->>'href', '') = '/network/branches'
      AND value->>'label' = 'Branches'
      AND value->>'capability' = 'branches.read'
      AND value->>'icon' = 'building'
  ),
  'global Console V2 navigation exposes Branches through the network section'
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
      WHERE COALESCE(item.value->>'route', item.value->>'href', '') = '/network/branches'
        AND item.value->>'label' = 'Branches'
        AND item.value->>'capability' = 'branches.read'
    )
  ),
  'every Console V2 navigation scope exposes Branches as a capability-gated network route'
);

WITH branch_counts AS (
  SELECT s.id AS settings_id, count(*) AS branch_count
  FROM public.settings s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
  WHERE s.category = 'ui_navigation'
    AND COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
    AND COALESCE(item.value->>'route', item.value->>'href', '') = '/network/branches'
  GROUP BY s.id
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM branch_counts
    WHERE branch_count <> 1
  ),
  'Console V2 navigation scopes contain exactly one Branches route'
);

SELECT * FROM finish();

ROLLBACK;
