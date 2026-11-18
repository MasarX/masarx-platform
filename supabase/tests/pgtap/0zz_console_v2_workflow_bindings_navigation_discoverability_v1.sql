-- pgTAP: Console V2 Workflows Bindings & triggers is discoverable from
-- row-driven navigation for operators with workflow write access.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_workflow_bindings_navigation_discoverability_v1()
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
        WHERE lower(COALESCE(section.value->>'id', section.value->>'label', '')) = 'workflows'
          AND COALESCE(item.value->>'route', item.value->>'href', item.value->>'path', '') = '/workflows/bindings'
          AND item.value->>'label' = 'Bindings & triggers'
          AND item.value->>'capability' = 'workflows.read'
      )
    ),
    'every Console navigation scope exposes Workflows Bindings & triggers at /workflows/bindings'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Workflow Bindings Navigation Org', 'workflow-bindings-nav-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_user,
    v_org,
    'workflow-bindings-nav-' || left(v_user::text, 8) || '@example.com',
    'Workflow Bindings Navigation User',
    'ops_admin',
    'tenant'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_navigation := public.ui_navigation_v1('console');

  RETURN QUERY
  WITH nav_items AS (
    SELECT section.value AS section_value, item.value AS item_value
    FROM jsonb_array_elements(COALESCE(v_navigation#>'{sections}', '[]'::jsonb)) AS section(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
  )
  SELECT ok(
    EXISTS (
      SELECT 1
      FROM nav_items
      WHERE lower(COALESCE(section_value->>'id', section_value->>'label', '')) = 'workflows'
        AND COALESCE(item_value->>'route', item_value->>'href', item_value->>'path', '') = '/workflows/bindings'
        AND item_value->>'label' = 'Bindings & triggers'
    ),
    'ui_navigation_v1(console) returns Bindings & triggers under Workflows'
  );

  RETURN QUERY
  WITH nav_items AS (
    SELECT item.value
    FROM jsonb_array_elements(COALESCE(v_navigation#>'{sections}', '[]'::jsonb)) AS section(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
  )
  SELECT is(
    (
      SELECT count(*)::integer
      FROM nav_items
      WHERE COALESCE(value->>'route', value->>'href', value->>'path', '') = '/workflows/bindings'
    ),
    1,
    'ui_navigation_v1(console) returns exactly one Workflows Bindings & triggers route'
  );
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_workflow_bindings_navigation_discoverability_v1();

SELECT * FROM finish();

ROLLBACK;
