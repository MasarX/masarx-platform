BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value#>'{apps,console,sections}') AS section
        WHERE section->>'id' = 'operations'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'console-customer-shipment-changes'
              AND item->>'href' = '/console/operations/customer-shipment-changes'
          )
      )
  ),
  'ui_navigation console includes customer shipment changes route'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value#>'{apps,console,sections}') AS section
        WHERE section->>'id' = 'operations'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'console-public-tracking-requests'
              AND item->>'href' = '/console/operations/public-tracking-requests'
          )
      )
  ),
  'ui_navigation console includes public tracking requests route'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value#>'{apps,portal,sections}') AS section
        WHERE section->>'id' = 'operations'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'portal-customer-shipment-changes'
              AND item->>'href' = '/portal/operations/customer-shipment-changes'
          )
      )
  ),
  'ui_navigation portal includes customer shipment changes route'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value#>'{apps,portal,sections}') AS section
        WHERE section->>'id' = 'operations'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'portal-public-tracking-requests'
              AND item->>'href' = '/portal/operations/public-tracking-requests'
          )
      )
  ),
  'ui_navigation portal includes public tracking requests route'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND COALESCE(cached_value#>'{apps,portal,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value#>'{apps,portal,sections}') AS section
        WHERE section->>'id' = 'operations'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'portal-customer-shipment-changes'
              AND item->>'href' = '/portal/operations/customer-shipment-changes'
          )
      )
  ),
  'all scoped portal ui_navigation rows include customer shipment changes route'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND COALESCE(cached_value#>'{apps,portal,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value#>'{apps,portal,sections}') AS section
        WHERE section->>'id' = 'operations'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'portal-public-tracking-requests'
              AND item->>'href' = '/portal/operations/public-tracking-requests'
          )
      )
  ),
  'all scoped portal ui_navigation rows include public tracking requests route'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND COALESCE(cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value#>'{apps,console,sections}') AS section
        WHERE section->>'id' = 'operations'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'console-customer-shipment-changes'
              AND item->>'href' = '/console/operations/customer-shipment-changes'
          )
      )
  ),
  'all scoped console ui_navigation rows include customer shipment changes route'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND COALESCE(cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value#>'{apps,console,sections}') AS section
        WHERE section->>'id' = 'operations'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'console-public-tracking-requests'
              AND item->>'href' = '/console/operations/public-tracking-requests'
          )
      )
  ),
  'all scoped console ui_navigation rows include public tracking requests route'
);

SELECT finish();

ROLLBACK;
