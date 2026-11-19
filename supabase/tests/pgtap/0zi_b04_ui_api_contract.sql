-- pgTAP: B04 zone/basket api contract + ui registry binding

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(35);

SELECT has_view('api', 'zones', 'api.zones exists');
SELECT has_view('api', 'zone_districts', 'api.zone_districts exists');
SELECT has_view('api', 'baskets', 'api.baskets exists');
SELECT has_view('api', 'basket_items', 'api.basket_items exists');
SELECT has_view('api', 'basket_transitions', 'api.basket_transitions exists');

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api'
      AND c.relname = 'zones'
      AND c.relkind = 'v'
      AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'api.zones is security_invoker'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api'
      AND c.relname = 'zone_districts'
      AND c.relkind = 'v'
      AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'api.zone_districts is security_invoker'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api'
      AND c.relname = 'baskets'
      AND c.relkind = 'v'
      AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'api.baskets is security_invoker'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api'
      AND c.relname = 'basket_items'
      AND c.relkind = 'v'
      AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'api.basket_items is security_invoker'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api'
      AND c.relname = 'basket_transitions'
      AND c.relkind = 'v'
      AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'api.basket_transitions is security_invoker'
);

SELECT ok(has_table_privilege('authenticated', 'api.zones', 'SELECT'), 'authenticated can SELECT api.zones');
SELECT ok(has_table_privilege('authenticated', 'api.zone_districts', 'SELECT'), 'authenticated can SELECT api.zone_districts');
SELECT ok(has_table_privilege('authenticated', 'api.baskets', 'SELECT'), 'authenticated can SELECT api.baskets');
SELECT ok(has_table_privilege('authenticated', 'api.basket_items', 'SELECT'), 'authenticated can SELECT api.basket_items');
SELECT ok(has_table_privilege('authenticated', 'api.basket_transitions', 'SELECT'), 'authenticated can SELECT api.basket_transitions');

SELECT ok(has_table_privilege('authenticated', 'api.zones', 'INSERT'), 'authenticated can INSERT api.zones');
SELECT ok(has_table_privilege('authenticated', 'api.zone_districts', 'INSERT'), 'authenticated can INSERT api.zone_districts');
SELECT ok(NOT has_table_privilege('authenticated', 'api.baskets', 'INSERT'), 'authenticated cannot INSERT api.baskets directly');
SELECT ok(NOT has_table_privilege('authenticated', 'api.basket_items', 'INSERT'), 'authenticated cannot INSERT api.basket_items directly');

SELECT ok(has_table_privilege('authenticated', 'api.zones', 'UPDATE'), 'authenticated can UPDATE api.zones');
SELECT ok(has_table_privilege('authenticated', 'api.zone_districts', 'UPDATE'), 'authenticated can UPDATE api.zone_districts');
SELECT ok(NOT has_table_privilege('authenticated', 'api.baskets', 'UPDATE'), 'authenticated cannot UPDATE api.baskets directly');
SELECT ok(NOT has_table_privilege('authenticated', 'api.basket_items', 'UPDATE'), 'authenticated cannot UPDATE api.basket_items directly');

SELECT ok(has_table_privilege('authenticated', 'api.zones', 'DELETE'), 'authenticated can DELETE api.zones');
SELECT ok(has_table_privilege('authenticated', 'api.zone_districts', 'DELETE'), 'authenticated can DELETE api.zone_districts');
SELECT ok(NOT has_table_privilege('authenticated', 'api.baskets', 'DELETE'), 'authenticated cannot DELETE api.baskets directly');
SELECT ok(NOT has_table_privilege('authenticated', 'api.basket_items', 'DELETE'), 'authenticated cannot DELETE api.basket_items directly');

SELECT ok(NOT has_table_privilege('authenticated', 'api.basket_transitions', 'INSERT'), 'authenticated cannot INSERT api.basket_transitions');
SELECT ok(NOT has_table_privilege('authenticated', 'api.basket_transitions', 'UPDATE'), 'authenticated cannot UPDATE api.basket_transitions');
SELECT ok(NOT has_table_privilege('authenticated', 'api.basket_transitions', 'DELETE'), 'authenticated cannot DELETE api.basket_transitions');

SELECT is(
  (
    SELECT resource->>'relation'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND resource->>'key' = 'zones'
    LIMIT 1
  ),
  'api.zones',
  'ui_read_registry routes zones through api.zones'
);

SELECT is(
  (
    SELECT resource->>'relation'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND resource->>'key' = 'zone_districts'
    LIMIT 1
  ),
  'api.zone_districts',
  'ui_read_registry routes zone_districts through api.zone_districts'
);

SELECT is(
  (
    SELECT resource->>'relation'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND resource->>'key' = 'baskets'
    LIMIT 1
  ),
  'api.baskets',
  'ui_read_registry routes baskets through api.baskets'
);

SELECT is(
  (
    SELECT resource->>'relation'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND resource->>'key' = 'basket_items'
    LIMIT 1
  ),
  'api.basket_items',
  'ui_read_registry routes basket_items through api.basket_items'
);

SELECT is(
  (
    SELECT resource->>'relation'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND resource->>'key' = 'basket_transitions'
    LIMIT 1
  ),
  'api.basket_transitions',
  'ui_read_registry routes basket_transitions through api.basket_transitions'
);

SELECT * FROM finish();

ROLLBACK;
