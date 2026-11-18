-- Test Suite: Mobile shell policy pack (device/navigation/map/communication/address/safety)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(67);

SELECT has_function('public', 'resolve_device_policy', ARRAY['jsonb'], 'resolve_device_policy exists');
SELECT has_function('public', 'resolve_navigation_policy', ARRAY['jsonb'], 'resolve_navigation_policy exists');
SELECT has_function('public', 'resolve_map_policy', ARRAY['jsonb'], 'resolve_map_policy exists');
SELECT has_function('public', 'resolve_communication_policy', ARRAY['jsonb'], 'resolve_communication_policy exists');
SELECT has_function('public', 'resolve_address_policy', ARRAY['jsonb'], 'resolve_address_policy exists');
SELECT has_function('public', 'resolve_driver_safety_policy', ARRAY['jsonb'], 'resolve_driver_safety_policy exists');
SELECT has_function('public', 'resolve_ux_safety_policy', ARRAY['jsonb'], 'resolve_ux_safety_policy exists');

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_device_policy' AND p.prosecdef
  ),
  'resolve_device_policy is SECURITY DEFINER'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_navigation_policy' AND p.prosecdef
  ),
  'resolve_navigation_policy is SECURITY DEFINER'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_map_policy' AND p.prosecdef
  ),
  'resolve_map_policy is SECURITY DEFINER'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_communication_policy' AND p.prosecdef
  ),
  'resolve_communication_policy is SECURITY DEFINER'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_address_policy' AND p.prosecdef
  ),
  'resolve_address_policy is SECURITY DEFINER'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_driver_safety_policy' AND p.prosecdef
  ),
  'resolve_driver_safety_policy is SECURITY DEFINER'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_ux_safety_policy' AND p.prosecdef
  ),
  'resolve_ux_safety_policy is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'device_policy' AND requires_schema AND requires_global_default AND safe_missing_behavior = 'hard_fail'
  ),
  'device_policy category registered'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'navigation_policy' AND requires_schema AND requires_global_default AND safe_missing_behavior = 'hard_fail'
  ),
  'navigation_policy category registered'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'map_policy' AND requires_schema AND requires_global_default AND safe_missing_behavior = 'hard_fail'
  ),
  'map_policy category registered'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'communication_policy' AND requires_schema AND requires_global_default AND safe_missing_behavior = 'hard_fail'
  ),
  'communication_policy category registered'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'address_policy' AND requires_schema AND requires_global_default AND safe_missing_behavior = 'hard_fail'
  ),
  'address_policy category registered'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'driver_safety_policy' AND requires_schema AND requires_global_default AND safe_missing_behavior = 'hard_fail'
  ),
  'driver_safety_policy category registered'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'ux_safety_policy' AND requires_schema AND requires_global_default AND safe_missing_behavior = 'hard_fail'
  ),
  'ux_safety_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'device_policy' AND allowed_scopes::text LIKE '%resource%'
  ),
  'device_policy allows resource scope'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'navigation_policy' AND allowed_scopes::text LIKE '%resource%'
  ),
  'navigation_policy allows resource scope'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'map_policy' AND allowed_scopes::text LIKE '%resource%'
  ),
  'map_policy allows resource scope'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'communication_policy' AND allowed_scopes::text LIKE '%resource%'
  ),
  'communication_policy allows resource scope'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'address_policy' AND allowed_scopes::text LIKE '%resource%'
  ),
  'address_policy allows resource scope'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'driver_safety_policy' AND allowed_scopes::text LIKE '%resource%'
  ),
  'driver_safety_policy allows resource scope'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'ux_safety_policy' AND allowed_scopes::text LIKE '%resource%'
  ),
  'ux_safety_policy allows resource scope'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'device_policy' AND version = 1 AND is_active),
  'device_policy schema active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'navigation_policy' AND version = 1 AND is_active),
  'navigation_policy schema active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'map_policy' AND version = 1 AND is_active),
  'map_policy schema active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'communication_policy' AND version = 1 AND is_active),
  'communication_policy schema active'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'communication_policy'
       AND version = 1
       AND is_active
       AND schema #> '{properties,support_contacts}' IS NOT NULL
  ),
  'communication_policy schema includes support_contacts'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'address_policy' AND version = 1 AND is_active),
  'address_policy schema active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'driver_safety_policy' AND version = 1 AND is_active),
  'driver_safety_policy schema active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'ux_safety_policy' AND version = 1 AND is_active),
  'ux_safety_policy schema active'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'device_policy' AND scope_type = 'global' AND scope_id IS NULL AND version = 1),
  'device_policy global default exists'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'navigation_policy' AND scope_type = 'global' AND scope_id IS NULL AND version = 1),
  'navigation_policy global default exists'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND effective_until IS NULL
  ),
  'map_policy active global default exists'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'communication_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'communication_policy global default exists'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions
     WHERE category = 'communication_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND COALESCE(value->'support_contacts', '[]'::jsonb) = '[]'::jsonb
  ),
  'communication_policy global default seeds empty support_contacts'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'address_policy' AND scope_type = 'global' AND scope_id IS NULL AND version = 1),
  'address_policy global default exists'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'driver_safety_policy' AND scope_type = 'global' AND scope_id IS NULL AND version = 1),
  'driver_safety_policy global default exists'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'ux_safety_policy' AND scope_type = 'global' AND scope_id IS NULL AND version = 1),
  'ux_safety_policy global default exists'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'device_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'device_policy settings cache seeded'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'navigation_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'navigation_policy settings cache seeded'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'map_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'map_policy settings cache seeded'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'communication_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'communication_policy settings cache seeded'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'communication_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND COALESCE(cached_value->'support_contacts', '[]'::jsonb) = '[]'::jsonb
  ),
  'communication_policy cache keeps empty support_contacts default'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'address_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'address_policy settings cache seeded'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'driver_safety_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'driver_safety_policy settings cache seeded'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'ux_safety_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'ux_safety_policy settings cache seeded'
);

SELECT ok(has_function_privilege('authenticated', 'public.resolve_device_policy(jsonb)', 'EXECUTE'), 'authenticated can execute resolve_device_policy');
SELECT ok(has_function_privilege('authenticated', 'public.resolve_navigation_policy(jsonb)', 'EXECUTE'), 'authenticated can execute resolve_navigation_policy');
SELECT ok(has_function_privilege('authenticated', 'public.resolve_map_policy(jsonb)', 'EXECUTE'), 'authenticated can execute resolve_map_policy');
SELECT ok(has_function_privilege('authenticated', 'public.resolve_communication_policy(jsonb)', 'EXECUTE'), 'authenticated can execute resolve_communication_policy');
SELECT is(
  COALESCE(
    jsonb_typeof(
      COALESCE(
        (SELECT value->'support_contacts' FROM public.resolve_communication_policy('{}'::jsonb) LIMIT 1),
        '[]'::jsonb
      )
    ),
    'null'
  ),
  'array',
  'resolve_communication_policy returns support_contacts as an array'
);
SELECT ok(has_function_privilege('authenticated', 'public.resolve_address_policy(jsonb)', 'EXECUTE'), 'authenticated can execute resolve_address_policy');
SELECT ok(has_function_privilege('authenticated', 'public.resolve_driver_safety_policy(jsonb)', 'EXECUTE'), 'authenticated can execute resolve_driver_safety_policy');
SELECT ok(has_function_privilege('authenticated', 'public.resolve_ux_safety_policy(jsonb)', 'EXECUTE'), 'authenticated can execute resolve_ux_safety_policy');

SELECT ok(NOT has_function_privilege('anon', 'public.resolve_device_policy(jsonb)', 'EXECUTE'), 'anon cannot execute resolve_device_policy');
SELECT ok(NOT has_function_privilege('anon', 'public.resolve_navigation_policy(jsonb)', 'EXECUTE'), 'anon cannot execute resolve_navigation_policy');
SELECT ok(NOT has_function_privilege('anon', 'public.resolve_map_policy(jsonb)', 'EXECUTE'), 'anon cannot execute resolve_map_policy');
SELECT ok(NOT has_function_privilege('anon', 'public.resolve_communication_policy(jsonb)', 'EXECUTE'), 'anon cannot execute resolve_communication_policy');
SELECT ok(NOT has_function_privilege('anon', 'public.resolve_address_policy(jsonb)', 'EXECUTE'), 'anon cannot execute resolve_address_policy');
SELECT ok(NOT has_function_privilege('anon', 'public.resolve_driver_safety_policy(jsonb)', 'EXECUTE'), 'anon cannot execute resolve_driver_safety_policy');
SELECT ok(NOT has_function_privilege('anon', 'public.resolve_ux_safety_policy(jsonb)', 'EXECUTE'), 'anon cannot execute resolve_ux_safety_policy');

SELECT finish();

ROLLBACK;
