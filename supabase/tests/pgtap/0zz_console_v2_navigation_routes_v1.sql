-- Console V2 navigation registry route coverage.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

WITH console_items AS (
  SELECT section->>'id' AS section_id,
         item->>'id' AS item_id,
         COALESCE(item->>'route', item->>'href') AS path
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
)
SELECT ok(
  EXISTS (SELECT 1 FROM console_items WHERE section_id = 'platform' AND item_id = 'platform-commands' AND path = '/platform/commands'),
  'global Console V2 navigation exposes Platform Commands'
);

WITH console_items AS (
  SELECT section->>'id' AS section_id,
         item->>'id' AS item_id,
         COALESCE(item->>'route', item->>'href') AS path
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
)
SELECT ok(
  EXISTS (SELECT 1 FROM console_items WHERE section_id = 'finance' AND item_id = 'finance-billing' AND path = '/finance/billing'),
  'global Console V2 navigation exposes Finance Billing'
);

WITH console_items AS (
  SELECT section->>'id' AS section_id,
         item->>'id' AS item_id,
         COALESCE(item->>'route', item->>'href') AS path
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
)
SELECT ok(
  EXISTS (SELECT 1 FROM console_items WHERE section_id = 'integrations' AND item_id = 'integrations-plugin-studio' AND path = '/integrations/plugin-studio'),
  'global Console V2 navigation exposes Integration Plugin Studio'
);

WITH console_items AS (
  SELECT section->>'id' AS section_id,
         item->>'id' AS item_id,
         COALESCE(item->>'route', item->>'href') AS path
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
)
SELECT ok(
  EXISTS (SELECT 1 FROM console_items WHERE section_id = 'network' AND item_id = 'network-zones' AND path = '/network/zones'),
  'global Console V2 navigation exposes Network Zones'
);

WITH console_items AS (
  SELECT section->>'id' AS section_id,
         item->>'id' AS item_id,
         COALESCE(item->>'route', item->>'href') AS path
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
)
SELECT ok(
  EXISTS (SELECT 1 FROM console_items WHERE section_id = 'support' AND item_id = 'support-cases' AND path = '/support/cases'),
  'global Console V2 navigation exposes Support cases'
);

WITH console_items AS (
  SELECT section->>'id' AS section_id,
         item->>'id' AS item_id,
         COALESCE(item->>'route', item->>'href') AS path,
         item->>'capability' AS capability
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM console_items
     WHERE section_id = 'customers'
       AND item_id = 'customers-clients'
       AND path = '/customers/clients'
       AND capability = 'clients.read'
  ),
  'global Console V2 navigation exposes Customers Clients'
);

WITH console_items AS (
  SELECT section->>'id' AS section_id,
         item->>'id' AS item_id,
         COALESCE(item->>'route', item->>'href') AS path,
         item->>'capability' AS capability
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM console_items
     WHERE section_id = 'customers'
       AND item_id = 'customers-senders'
       AND path = '/customers/senders'
       AND capability = 'senders.read'
  ),
  'global Console V2 navigation exposes Customers Senders'
);

WITH console_items AS (
  SELECT section->>'id' AS section_id,
         item->>'id' AS item_id,
         COALESCE(item->>'route', item->>'href') AS path,
         item->>'capability' AS capability
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM console_items
     WHERE section_id = 'customers'
       AND item_id = 'customers-recipients'
       AND path = '/customers/recipients'
       AND capability = 'recipients.read'
  ),
  'global Console V2 navigation exposes Customers Recipients'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) AS section
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
          WHERE section->>'id' = 'platform'
            AND item->>'id' = 'platform-commands'
            AND COALESCE(item->>'route', item->>'href') = '/platform/commands'
       )
  ),
  'all Console V2 navigation scopes expose Platform Commands'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) AS section
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
          WHERE section->>'id' = 'customers'
            AND item->>'id' = 'customers-recipients'
            AND COALESCE(item->>'route', item->>'href') = '/customers/recipients'
            AND item->>'capability' = 'recipients.read'
       )
  ),
  'all Console V2 navigation scopes expose Recipients through Customers'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE item->>'id' = 'platform-commands'
       AND COALESCE(item->>'route', item->>'href') <> '/platform/commands'
  ),
  'Platform Commands navigation does not point at legacy console command routes'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE item->>'id' IN ('finance-billing', 'integrations-plugin-studio', 'network-zones', 'support-cases')
       AND COALESCE(item->>'route', item->>'href') LIKE '/console/%'
  ),
  'newly aligned Console V2 navigation entries avoid legacy /console routes'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) AS section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE s.category = 'ui_navigation'
       AND (
         COALESCE(item->>'id', item->>'key') IN (
           'clients',
           'senders',
           'recipients',
           'customers-clients',
           'customers-senders',
           'customers-recipients'
         )
         OR COALESCE(item->>'route', item->>'href') IN (
           '/customers/clients',
           '/customers/senders',
           '/customers/recipients',
           '/console/resources/clients',
           '/console/resources/senders',
           '/console/resources/recipients'
         )
       )
       AND COALESCE(item->>'route', item->>'href') LIKE '/console/resources/%'
  ),
  'customer navigation entries avoid legacy raw resource routes in every scope'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(s.cached_value#>'{apps,console,sections}') AS section
      CROSS JOIN LATERAL jsonb_array_elements(section->'items') AS item
     WHERE s.category = 'ui_navigation'
       AND (COALESCE(item->>'route', item->>'href', item->>'path') = '/integrations/rules'
            OR item->>'resource' = 'webhook_rules')
  ),
  'Console navigation omits retired routing rules in every scope'
);

SELECT * FROM finish();

ROLLBACK;
