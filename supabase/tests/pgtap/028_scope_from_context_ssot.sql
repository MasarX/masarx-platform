-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S95
-- Test Suite: SSOT scope selection from context (id-less fallback is ladder-driven)

BEGIN;

SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

-- Setup: add an id-less scope type for this category without changing system root scope.
DO $$
BEGIN
  INSERT INTO public.scope_type_registry (
    scope_type, description, entity_table, id_column, context_keys, is_enabled, ladder_rank
  )
  VALUES (
    'pgtap_idless',
    'pgTAP id-less scope (entity_table IS NULL)',
    NULL,
    'id',
    '[]'::jsonb,
    TRUE,
    999
  )
  ON CONFLICT (scope_type) DO UPDATE
  SET description = EXCLUDED.description,
      entity_table = NULL,
      context_keys = EXCLUDED.context_keys,
      is_enabled = TRUE,
      ladder_rank = EXCLUDED.ladder_rank;

  INSERT INTO public.settings_category_registry (category, requires_schema, allowed_scopes)
  VALUES (
    'pgtap_scope_from_context',
    FALSE,
    jsonb_build_array('source','sender','client','tenant','pgtap_idless')
  )
  ON CONFLICT (category) DO UPDATE
  SET requires_schema = FALSE,
      allowed_scopes = EXCLUDED.allowed_scopes,
      updated_at = now();
END;
$$;

-- 1) Id-less fallback comes from the ladder (not hardcoded to "global")
SELECT is(
  (
    SELECT r.scope_type
    FROM public.resolve_scope_from_context('pgtap_scope_from_context', '{}'::jsonb) r
    LIMIT 1
  ),
  'pgtap_idless',
  'resolve_scope_from_context uses ladder-derived id-less fallback'
);

-- 2) Context selects id-full scope using registry keys; id-less scopes are skipped generically.
-- Use an existing tenant id to keep this scope-resolution test isolated from onboarding triggers.

SELECT is(
  (
    SELECT r.scope_type
    FROM public.resolve_scope_from_context(
      'pgtap_scope_from_context',
      jsonb_build_object(
        (
          SELECT jsonb_array_elements_text(str.context_keys)
          FROM public.scope_type_registry str
          WHERE str.entity_table = 'public.organizations'::regclass
            AND str.is_enabled = TRUE
          LIMIT 1
        ),
        (
          SELECT o.id::text
          FROM public.organizations o
          ORDER BY o.id
          LIMIT 1
        )
      )
    ) r
    LIMIT 1
  ),
  (
    SELECT str.scope_type
    FROM public.scope_type_registry str
    WHERE str.entity_table = 'public.organizations'::regclass
      AND str.is_enabled = TRUE
    LIMIT 1
  ),
  'resolve_scope_from_context selects tenant scope via scope_type_registry.context_keys'
);

-- 3) No duplication: resolve_settings_row_from_context delegates to resolve_scope_from_context.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_settings_row_from_context'
      AND p.prosrc LIKE '%resolve_scope_from_context%'
  ),
  'resolve_settings_row_from_context delegates to resolve_scope_from_context'
);

-- 4) No duplication: resolve_settings_merged_from_context delegates to resolve_scope_from_context.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_settings_merged_from_context'
      AND p.prosrc LIKE '%resolve_scope_from_context%'
  ),
  'resolve_settings_merged_from_context delegates to resolve_scope_from_context'
);

SELECT * FROM finish();

ROLLBACK;
