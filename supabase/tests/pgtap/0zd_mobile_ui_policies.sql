-- Test Suite: Mobile UI policies (visibility + diagnostics)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(44);

SELECT has_function(
  'public', 'resolve_mobile_shell_policy', ARRAY['jsonb'],
  'resolve_mobile_shell_policy exists'
);

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
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'resolve_mobile_shell_policy' AND p.prosecdef
  ),
  'resolve_mobile_shell_policy is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry
          WHERE category = 'mobile_shell_policy' AND requires_schema AND requires_global_default
            AND safe_missing_behavior = 'hard_fail'),
  'mobile_shell_policy category registered'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry
          WHERE category = 'mobile_shell_policy' AND version = 1 AND is_active),
  'mobile_shell_policy schema active'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions
          WHERE category = 'mobile_shell_policy' AND scope_type = 'global' AND scope_id IS NULL
            AND value->'v2_enabled' = 'false'::jsonb),
  'mobile_shell_policy global default is disabled'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings
          WHERE category = 'mobile_shell_policy' AND scope_type = 'global' AND scope_id IS NULL
            AND cached_value->'v2_enabled' = 'false'::jsonb),
  'mobile_shell_policy settings cache seeded disabled'
);

SELECT ok(has_function_privilege('authenticated', 'public.resolve_mobile_shell_policy(jsonb)', 'EXECUTE'),
  'authenticated can execute resolve_mobile_shell_policy');
SELECT ok(NOT has_function_privilege('anon', 'public.resolve_mobile_shell_policy(jsonb)', 'EXECUTE'),
  'anon cannot execute resolve_mobile_shell_policy');

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

INSERT INTO public.organizations (id, name, slug, billing_status)
VALUES (
  'f3980000-0000-4000-8000-000000000010'::uuid,
  'FieldOps V2 policy fixture',
  'fieldops-v2-policy-f398',
  'active'
);

DO $fixture$
BEGIN
  PERFORM public.upsert_settings_value_v1(
    'mobile_shell_policy',
    'tenant',
    'f3980000-0000-4000-8000-000000000010'::uuid,
    '{"version":1,"v2_enabled":true}'::jsonb,
    1,
    'Rollback-only FieldOps V2 rollout fixture'
  );
END;
$fixture$;

SELECT is(
  (SELECT value->'v2_enabled' FROM public.resolve_mobile_shell_policy('{}'::jsonb) LIMIT 1),
  'false'::jsonb,
  'public resolver returns the fail-closed global default'
);

SELECT is(
  (SELECT value->'v2_enabled' FROM api.resolve_mobile_shell_policy('{}'::jsonb) LIMIT 1),
  'false'::jsonb,
  'api resolver returns the fail-closed global default'
);

SELECT is(
  (SELECT value->'v2_enabled' FROM public.resolve_mobile_shell_policy(
    '{"organization_id":"f3980000-0000-4000-8000-000000000010"}'::jsonb
  ) LIMIT 1),
  'true'::jsonb,
  'tenant override enables FieldOps V2 for the exact context'
);

SELECT is(
  (SELECT scope_type FROM public.resolve_mobile_shell_policy(
    '{"organization_id":"f3980000-0000-4000-8000-000000000010"}'::jsonb
  ) LIMIT 1),
  'tenant'::text,
  'tenant override is the winning scope'
);

SELECT is(
  (SELECT settings_version_id FROM api.resolve_mobile_shell_policy(
    '{"organization_id":"f3980000-0000-4000-8000-000000000010"}'::jsonb
  ) LIMIT 1),
  (SELECT settings_version_id FROM public.resolve_mobile_shell_policy(
    '{"organization_id":"f3980000-0000-4000-8000-000000000010"}'::jsonb
  ) LIMIT 1),
  'api wrapper matches the public tenant resolution'
);

SELECT is(
  (SELECT value->'v2_enabled' FROM public.resolve_mobile_shell_policy(NULL::jsonb) LIMIT 1),
  'false'::jsonb,
  'missing context remains on the fail-closed global default'
);

SELECT is(
  (SELECT value->'v2_enabled' FROM public.resolve_mobile_shell_policy('[]'::jsonb) LIMIT 1),
  'false'::jsonb,
  'non-object context remains on the fail-closed global default'
);

SELECT is(
  (SELECT value->'v2_enabled' FROM public.resolve_mobile_shell_policy(
    '{"organization_id":"malformed"}'::jsonb
  ) LIMIT 1),
  'false'::jsonb,
  'malformed scoped context remains on the fail-closed global default'
);

SELECT is(
  (SELECT to_jsonb(r) FROM api.resolve_mobile_shell_policy(
    '{"organization_id":"malformed"}'::jsonb
  ) r LIMIT 1),
  (SELECT to_jsonb(r) FROM public.resolve_mobile_shell_policy(
    '{"organization_id":"malformed"}'::jsonb
  ) r LIMIT 1),
  'api wrapper matches public fail-closed malformed-context resolution'
);

SELECT finish();

ROLLBACK;
