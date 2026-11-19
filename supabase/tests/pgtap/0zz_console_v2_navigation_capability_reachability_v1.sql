-- pgTAP: Console V2 navigation must be discoverable for operators whose
-- lifecycle modules allow read/review access.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

WITH nav_items AS (
  SELECT item.item
    FROM jsonb_array_elements(
           COALESCE(
             public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}',
             '[]'::jsonb
           )
         ) AS section(section)
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.section->'items', '[]'::jsonb)) AS item(item)
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM nav_items
     WHERE COALESCE(item->>'route', item->>'href') = '/integrations/mapping'
       AND item->>'capability' = 'mappings.read'
  ),
  'Mapping Studio navigation is reachable with mappings.read'
);

WITH nav_items AS (
  SELECT item.item
    FROM jsonb_array_elements(
           COALESCE(
             public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}',
             '[]'::jsonb
           )
         ) AS section(section)
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.section->'items', '[]'::jsonb)) AS item(item)
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM nav_items
     WHERE COALESCE(item->>'route', item->>'href') = '/platform/organizations'
       AND item->>'capability' = 'organizations.read'
       AND item->'capabilities' ? 'organizations.read'
       AND item->'capabilities' ? 'tenant_signup_requests.read'
  ),
  'Organizations navigation accepts organization readers or tenant signup reviewers'
);

SELECT * FROM finish();

ROLLBACK;
