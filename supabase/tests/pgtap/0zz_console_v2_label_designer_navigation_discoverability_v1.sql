-- pgTAP: Console V2 Label Designer is discoverable through the canonical
-- Platform workbench and legacy/raw label resource rows do not win navigation.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_label_designer_navigation_discoverability_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_navigation JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN QUERY
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
    WHERE COALESCE(value->>'route', value->>'href', value->>'path', '') IN (
            '/console/resources/labels',
            '/console/resources/label_jobs',
            '/console/resources/label_sections',
            '/console/resources/label_design_tokens',
            '/console/resources/label_template_validation',
            '/console/labels/designer'
          )
  ),
  'scoped Console navigation does not expose legacy/raw label resource routes'
);

  RETURN QUERY
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
      WHERE COALESCE(item.value->>'route', item.value->>'href', item.value->>'path', '') = '/platform/labels'
        AND item.value->>'label' = 'Label Designer & templates'
        AND item.value->>'capability' = 'labels.read'
    )
  ),
  'every Console navigation scope exposes Label Designer & templates at /platform/labels'
);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Label Designer Navigation Org', 'label-designer-nav-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_user,
    v_org,
    'label-designer-nav-' || left(v_user::text, 8) || '@example.com',
    'Label Designer Navigation User',
    'ops_admin',
    'tenant'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_navigation := public.ui_navigation_v1('console');

  RETURN QUERY
  WITH nav_items AS (
  SELECT item.value
  FROM jsonb_array_elements(COALESCE(v_navigation#>'{sections}', '[]'::jsonb)) AS section(value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM nav_items
    WHERE COALESCE(value->>'route', value->>'href', value->>'path', '') = '/platform/labels'
      AND value->>'label' = 'Label Designer & templates'
  ),
  'ui_navigation_v1(console) returns Label Designer & templates as the Platform labels workbench'
);

  RETURN QUERY
  WITH nav_items AS (
  SELECT item.value
  FROM jsonb_array_elements(COALESCE(v_navigation#>'{sections}', '[]'::jsonb)) AS section(value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM nav_items
    WHERE COALESCE(value->>'route', value->>'href', value->>'path', '') IN (
            '/console/resources/labels',
            '/console/resources/label_jobs',
            '/console/resources/label_sections',
            '/console/resources/label_design_tokens',
            '/console/resources/label_template_validation',
            '/console/labels/designer'
          )
  ),
  'ui_navigation_v1(console) does not return legacy/raw label routes'
);

END;
$function$;

SELECT * FROM pg_temp.test_console_v2_label_designer_navigation_discoverability_v1();

SELECT * FROM finish();

ROLLBACK;
