-- Test Suite: Mobile UI policies (visibility + diagnostics)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(27);

SELECT has_function(
  'public',
  'resolve_mobile_visibility_policy',
  ARRAY['jsonb'],
  'resolve_mobile_visibility_policy exists'
);
SELECT has_function(
  'public',
  'resolve_mobile_diagnostics_policy',
  ARRAY['jsonb'],
  'resolve_mobile_diagnostics_policy exists'
);
SELECT has_function(
  'public',
  'resolve_mobile_push_policy',
  ARRAY['jsonb'],
  'resolve_mobile_push_policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_mobile_visibility_policy'
      AND p.prosecdef
  ),
  'resolve_mobile_visibility_policy is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_mobile_diagnostics_policy'
      AND p.prosecdef
  ),
  'resolve_mobile_diagnostics_policy is SECURITY DEFINER'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_mobile_push_policy'
      AND p.prosecdef
  ),
  'resolve_mobile_push_policy is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'mobile_visibility_policy'
      AND requires_schema
      AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
  ),
  'mobile_visibility_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'mobile_diagnostics_policy'
      AND requires_schema
      AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
  ),
  'mobile_diagnostics_policy category registered'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'mobile_push_policy'
      AND requires_schema
      AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
  ),
  'mobile_push_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'mobile_visibility_policy'
      AND allowed_scopes::text LIKE '%resource%'
  ),
  'mobile_visibility_policy allows resource scope'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'mobile_diagnostics_policy'
      AND allowed_scopes::text LIKE '%resource%'
  ),
  'mobile_diagnostics_policy allows resource scope'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'mobile_push_policy'
      AND allowed_scopes::text LIKE '%resource%'
  ),
  'mobile_push_policy allows resource scope'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'mobile_visibility_policy'
      AND version = 1
      AND is_active
  ),
  'mobile_visibility_policy schema active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'mobile_diagnostics_policy'
      AND version = 1
      AND is_active
  ),
  'mobile_diagnostics_policy schema active'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'mobile_push_policy'
      AND version = 1
      AND is_active
  ),
  'mobile_push_policy schema active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'mobile_visibility_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND version = 1
  ),
  'mobile_visibility_policy global default exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'mobile_diagnostics_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND version = 1
  ),
  'mobile_diagnostics_policy global default exists'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'mobile_push_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND version = 1
  ),
  'mobile_push_policy global default exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'mobile_visibility_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'default_visibility'
  ),
  'mobile_visibility_policy settings cache seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'mobile_diagnostics_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'enabled'
  ),
  'mobile_diagnostics_policy settings cache seeded'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'mobile_push_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'enabled'
  ),
  'mobile_push_policy settings cache seeded'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.resolve_mobile_visibility_policy(jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute resolve_mobile_visibility_policy'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.resolve_mobile_diagnostics_policy(jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute resolve_mobile_diagnostics_policy'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.resolve_mobile_push_policy(jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute resolve_mobile_push_policy'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.resolve_mobile_visibility_policy(jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute resolve_mobile_visibility_policy'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.resolve_mobile_diagnostics_policy(jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute resolve_mobile_diagnostics_policy'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.resolve_mobile_push_policy(jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute resolve_mobile_push_policy'
);

SELECT finish();

ROLLBACK;
