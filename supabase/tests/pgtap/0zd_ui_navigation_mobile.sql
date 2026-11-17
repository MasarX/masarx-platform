-- pgTAP: ui_navigation apps.mobile defaults (Field Ops v1)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'apps'
      AND (cached_value->'apps') ? 'mobile'
  ),
  'ui_navigation includes apps.mobile'
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
        FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
        WHERE section->>'id' = 'tasks'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'resource' = 'tasks'
          )
      )
  ),
  'ui_navigation mobile includes tasks item'
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
        FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
        WHERE section->>'id' = 'tools'
      )
  ),
  'ui_navigation mobile includes tools section'
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
        FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
        WHERE section->>'id' = 'tools'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'mobile-outbox'
              AND item->>'href' = '/mobile/outbox'
          )
      )
  ),
  'ui_navigation mobile includes outbox route'
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
        FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
        WHERE section->>'id' = 'tools'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'mobile-scan'
              AND item->>'href' = '/mobile/scan'
          )
      )
  ),
  'ui_navigation mobile includes scan route'
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
        FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
        WHERE section->>'id' = 'tools'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'mobile-location'
              AND item->>'href' = '/mobile/location'
          )
      )
  ),
  'ui_navigation mobile includes location route'
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
        FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
        WHERE section->>'id' = 'tools'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'mobile-diagnostics'
              AND item->>'href' = '/mobile/diagnostics'
          )
      )
  ),
  'ui_navigation mobile includes diagnostics route'
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
        FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
        WHERE section->>'id' = 'tools'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'mobile-more'
              AND item->>'href' = '/mobile/more'
          )
      )
  ),
  'ui_navigation mobile includes more route'
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
        FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
        WHERE section->>'id' = 'tools'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'mobile-route'
              AND item->>'href' = '/mobile/route'
          )
      )
  ),
  'ui_navigation mobile includes route screen'
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
        FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
        WHERE section->>'id' = 'tools'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
            WHERE item->>'id' = 'mobile-settlements'
              AND item->>'href' = '/mobile/settlements'
          )
      )
  ),
  'ui_navigation mobile includes settlements route'
);

SELECT finish();

ROLLBACK;
