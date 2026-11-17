-- Plan: B04 UC061 Portal/Console discoverability closeout
-- pgTAP: B04 UC061 ui_navigation discoverability v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

CREATE OR REPLACE FUNCTION pg_temp.test_b04_uc061_ui_navigation_discoverability_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_navigation JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_registry JSONB := NULL;
  v_console_navigation JSONB := NULL;
  v_portal_navigation JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_navigation
    FROM public.settings
   WHERE category = 'ui_navigation'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT ok(
    v_navigation#>'{apps,console,sections}' @> jsonb_build_array(
      jsonb_build_object(
        'id', 'operations',
        'items', jsonb_build_array(
          jsonb_build_object('id', 'console-zones', 'href', '/console/resources/zones', 'resource', 'zones'),
          jsonb_build_object('id', 'console-zone-districts', 'href', '/console/resources/zone_districts', 'resource', 'zone_districts'),
          jsonb_build_object('id', 'console-baskets', 'href', '/console/resources/baskets', 'resource', 'baskets'),
          jsonb_build_object('id', 'console-basket-items', 'href', '/console/resources/basket_items', 'resource', 'basket_items'),
          jsonb_build_object('id', 'console-basket-transitions', 'href', '/console/resources/basket_transitions', 'resource', 'basket_transitions')
        )
      )
    ),
    'ui_navigation global console settings include B04 zone and basket routes'
  );

  RETURN NEXT ok(
    v_navigation#>'{apps,portal,sections}' @> jsonb_build_array(
      jsonb_build_object(
        'id', 'operations',
        'items', jsonb_build_array(
          jsonb_build_object('id', 'portal-zones', 'href', '/portal/resources/zones', 'resource', 'zones'),
          jsonb_build_object('id', 'portal-zone-districts', 'href', '/portal/resources/zone_districts', 'resource', 'zone_districts'),
          jsonb_build_object('id', 'portal-baskets', 'href', '/portal/resources/baskets', 'resource', 'baskets'),
          jsonb_build_object('id', 'portal-basket-items', 'href', '/portal/resources/basket_items', 'resource', 'basket_items'),
          jsonb_build_object('id', 'portal-basket-transitions', 'href', '/portal/resources/basket_transitions', 'resource', 'basket_transitions')
        )
      )
    ),
    'ui_navigation global portal settings include B04 zone and basket routes'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
      FROM public.settings
      WHERE category = 'ui_navigation'
        AND COALESCE(cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
        AND NOT (
          cached_value#>'{apps,console,sections}' @> jsonb_build_array(
            jsonb_build_object(
              'id', 'operations',
              'items', jsonb_build_array(
                jsonb_build_object('id', 'console-zones', 'href', '/console/resources/zones', 'resource', 'zones'),
                jsonb_build_object('id', 'console-zone-districts', 'href', '/console/resources/zone_districts', 'resource', 'zone_districts'),
                jsonb_build_object('id', 'console-baskets', 'href', '/console/resources/baskets', 'resource', 'baskets'),
                jsonb_build_object('id', 'console-basket-items', 'href', '/console/resources/basket_items', 'resource', 'basket_items'),
                jsonb_build_object('id', 'console-basket-transitions', 'href', '/console/resources/basket_transitions', 'resource', 'basket_transitions')
              )
            )
          )
        )
    ),
    'all scoped console ui_navigation rows include B04 zone and basket routes'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
      FROM public.settings
      WHERE category = 'ui_navigation'
        AND COALESCE(cached_value#>'{apps,portal,sections}', '[]'::jsonb) <> '[]'::jsonb
        AND NOT (
          cached_value#>'{apps,portal,sections}' @> jsonb_build_array(
            jsonb_build_object(
              'id', 'operations',
              'items', jsonb_build_array(
                jsonb_build_object('id', 'portal-zones', 'href', '/portal/resources/zones', 'resource', 'zones'),
                jsonb_build_object('id', 'portal-zone-districts', 'href', '/portal/resources/zone_districts', 'resource', 'zone_districts'),
                jsonb_build_object('id', 'portal-baskets', 'href', '/portal/resources/baskets', 'resource', 'baskets'),
                jsonb_build_object('id', 'portal-basket-items', 'href', '/portal/resources/basket_items', 'resource', 'basket_items'),
                jsonb_build_object('id', 'portal-basket-transitions', 'href', '/portal/resources/basket_transitions', 'resource', 'basket_transitions')
              )
            )
          )
        )
    ),
    'all scoped portal ui_navigation rows include B04 zone and basket routes'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B04 Discoverability Org', 'b04-discoverability-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_user,
    v_org,
    'b04-discoverability-' || left(v_user::text, 8) || '@example.com',
    'B04 Discoverability User',
    'ops_admin',
    'tenant'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_registry := public.ui_read_registry_v1();
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'zones'
    ),
    'ui_read_registry_v1 returns zones to an authenticated tenant user'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'zone_districts'
    ),
    'ui_read_registry_v1 returns zone_districts to an authenticated tenant user'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'baskets'
    ),
    'ui_read_registry_v1 returns baskets to an authenticated tenant user'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'basket_items'
    ),
    'ui_read_registry_v1 returns basket_items to an authenticated tenant user'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'basket_transitions'
    ),
    'ui_read_registry_v1 returns basket_transitions to an authenticated tenant user'
  );

  v_console_navigation := public.ui_navigation_v1('console');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_console_navigation->'sections', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' IN (
          'zones',
          'zone_districts',
          'baskets',
          'basket_items',
          'basket_transitions'
        )
      GROUP BY section.value->>'id'
      HAVING COUNT(DISTINCT item.value->>'resource') = 5
    ),
    'ui_navigation_v1(console) returns all B04 zone and basket routes to an authenticated tenant user'
  );

  v_portal_navigation := public.ui_navigation_v1('portal');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_portal_navigation->'sections', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' IN (
          'zones',
          'zone_districts',
          'baskets',
          'basket_items',
          'basket_transitions'
        )
      GROUP BY section.value->>'id'
      HAVING COUNT(DISTINCT item.value->>'resource') = 5
    ),
    'ui_navigation_v1(portal) returns all B04 zone and basket routes to an authenticated tenant user'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_b04_uc061_ui_navigation_discoverability_v1();

SELECT * FROM finish();

ROLLBACK;
