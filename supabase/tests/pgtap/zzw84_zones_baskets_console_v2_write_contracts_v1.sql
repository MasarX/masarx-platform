-- pgTAP: Console V2 zones/baskets write contract closure
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(45);

SELECT has_function('public', 'zone_update_v1', ARRAY['jsonb'], 'public.zone_update_v1 is registered');
SELECT has_function('api', 'zone_update_v1', ARRAY['jsonb'], 'api.zone_update_v1 is registered');
SELECT has_function('public', 'zone_delete_v1', ARRAY['jsonb'], 'public.zone_delete_v1 is registered');
SELECT has_function('api', 'zone_delete_v1', ARRAY['jsonb'], 'api.zone_delete_v1 is registered');
SELECT has_function('public', 'basket_create_v1', ARRAY['jsonb'], 'public.basket_create_v1 is registered');
SELECT has_function('api', 'basket_create_v1', ARRAY['jsonb'], 'api.basket_create_v1 is registered');

SELECT ok(EXISTS (
  SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'decision_category'
     AND lv.value = 'zones.update'
     AND lv.status = 'active'
), 'zones.update decision category lookup is active');
SELECT ok(EXISTS (
  SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'decision_category'
     AND lv.value = 'baskets.create'
     AND lv.status = 'active'
), 'baskets.create decision category lookup is active');
SELECT ok(EXISTS (
  SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'decision_outcome'
     AND lv.value = 'created'
     AND lv.status = 'active'
), 'created decision outcome lookup is active');
SELECT ok(EXISTS (
  SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'decision_outcome'
     AND lv.value = 'updated'
     AND lv.status = 'active'
), 'updated decision outcome lookup is active');
SELECT ok(EXISTS (
  SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'decision_outcome'
     AND lv.value = 'retired'
     AND lv.status = 'active'
), 'retired decision outcome lookup is active');

SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.zone_update_v1(jsonb)')), true, 'public.zone_update_v1 is SECURITY DEFINER');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('api.zone_update_v1(jsonb)')), true, 'api.zone_update_v1 is SECURITY DEFINER');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.zone_delete_v1(jsonb)')), true, 'public.zone_delete_v1 is SECURITY DEFINER');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('api.zone_delete_v1(jsonb)')), true, 'api.zone_delete_v1 is SECURITY DEFINER');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.basket_create_v1(jsonb)')), true, 'public.basket_create_v1 is SECURITY DEFINER');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('api.basket_create_v1(jsonb)')), true, 'api.basket_create_v1 is SECURITY DEFINER');

SELECT ok(has_function_privilege('authenticated', 'api.zone_update_v1(jsonb)', 'EXECUTE'), 'authenticated can execute api.zone_update_v1');
SELECT ok(has_function_privilege('service_role', 'api.zone_update_v1(jsonb)', 'EXECUTE'), 'service_role can execute api.zone_update_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.zone_update_v1(jsonb)', 'EXECUTE'), 'anon cannot execute api.zone_update_v1');
SELECT ok(has_function_privilege('authenticated', 'api.zone_delete_v1(jsonb)', 'EXECUTE'), 'authenticated can execute api.zone_delete_v1');
SELECT ok(has_function_privilege('service_role', 'api.zone_delete_v1(jsonb)', 'EXECUTE'), 'service_role can execute api.zone_delete_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.zone_delete_v1(jsonb)', 'EXECUTE'), 'anon cannot execute api.zone_delete_v1');
SELECT ok(has_function_privilege('authenticated', 'api.basket_create_v1(jsonb)', 'EXECUTE'), 'authenticated can execute api.basket_create_v1');
SELECT ok(has_function_privilege('service_role', 'api.basket_create_v1(jsonb)', 'EXECUTE'), 'service_role can execute api.basket_create_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.basket_create_v1(jsonb)', 'EXECUTE'), 'anon cannot execute api.basket_create_v1');

SELECT ok(pg_get_functiondef(to_regprocedure('public.zone_update_v1(jsonb)')) LIKE '%assert_capability_v1(''zones.write''%', 'zone_update_v1 enforces zones.write');
SELECT ok(pg_get_functiondef(to_regprocedure('public.zone_update_v1(jsonb)')) LIKE '%zone.updated%', 'zone_update_v1 emits zone.updated domain event');
SELECT ok(pg_get_functiondef(to_regprocedure('public.zone_update_v1(jsonb)')) LIKE '%log_decision%', 'zone_update_v1 writes decision log');
SELECT ok(pg_get_functiondef(to_regprocedure('public.zone_update_v1(jsonb)')) LIKE '%only patches profile fields%', 'zone_update_v1 rejects lifecycle patch fields');
SELECT ok(pg_get_functiondef(to_regprocedure('public.zone_delete_v1(jsonb)')) LIKE '%assert_capability_v1(''zones.write''%', 'zone_delete_v1 enforces zones.write');
SELECT ok(pg_get_functiondef(to_regprocedure('public.zone_delete_v1(jsonb)')) NOT ILIKE '%DELETE FROM public.zones%', 'zone_delete_v1 does not physically delete zones');
SELECT ok(pg_get_functiondef(to_regprocedure('public.zone_delete_v1(jsonb)')) LIKE '%''lifecycle'', ''retired''%', 'zone_delete_v1 marks lifecycle retired');
SELECT ok(pg_get_functiondef(to_regprocedure('public.zone_delete_v1(jsonb)')) LIKE '%zone.retired%', 'zone_delete_v1 emits zone.retired domain event');
SELECT ok(pg_get_functiondef(to_regprocedure('public.basket_create_v1(jsonb)')) LIKE '%assert_capability_v1(''baskets.write''%', 'basket_create_v1 enforces baskets.write');
SELECT ok(pg_get_functiondef(to_regprocedure('public.basket_create_v1(jsonb)')) LIKE '%INSERT INTO public.baskets%', 'basket_create_v1 writes through public.baskets');
SELECT ok(pg_get_functiondef(to_regprocedure('public.basket_create_v1(jsonb)')) LIKE '%basket.created%', 'basket_create_v1 emits basket.created domain event');
SELECT ok(pg_get_functiondef(to_regprocedure('public.basket_create_v1(jsonb)')) LIKE '%log_decision%', 'basket_create_v1 writes decision log');

SELECT ok(pg_get_functiondef(to_regprocedure('api.zone_update_v1(jsonb)')) LIKE '%public.zone_update_v1%', 'api.zone_update_v1 delegates to public.zone_update_v1');
SELECT ok(pg_get_functiondef(to_regprocedure('api.zone_delete_v1(jsonb)')) LIKE '%public.zone_delete_v1%', 'api.zone_delete_v1 delegates to public.zone_delete_v1');
SELECT ok(pg_get_functiondef(to_regprocedure('api.basket_create_v1(jsonb)')) LIKE '%public.basket_create_v1%', 'api.basket_create_v1 delegates to public.basket_create_v1');

SELECT ok(coalesce(obj_description(to_regclass('public.basket_items'), 'pg_class'), '') LIKE '%does not mutate basket_items directly%', 'basket_items table comment records direct Console CRUD as unsupported');
SELECT ok(coalesce(obj_description(to_regprocedure('public.basket_create_v1(jsonb)'), 'pg_proc'), '') LIKE '%Basket item membership remains workflow/policy-owned%', 'basket_create_v1 comment preserves basket item policy ownership');
SELECT ok(to_regprocedure('api.basket_item_add_v1(jsonb)') IS NULL, 'no direct api.basket_item_add_v1 shortcut exists');
SELECT ok(to_regprocedure('api.basket_item_remove_v1(jsonb)') IS NULL, 'no direct api.basket_item_remove_v1 shortcut exists');

SELECT * FROM finish();
ROLLBACK;
