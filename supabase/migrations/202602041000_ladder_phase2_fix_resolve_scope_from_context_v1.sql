-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: Phase 2 fix - resolve_scope_from_context without ladder_key (v1)
-- Purpose:
--   - Fix preview/CI failures where an older resolve_scope_from_context referenced a non-existent
--     settings_category_registry.ladder_key column.
--   - Keep scope-from-context selection fully row-driven via:
--       * settings_category_registry.allowed_scopes
--       * scope_type_registry.context_keys + ladder_rank
--   - Ensure reused preview DBs get the corrected function via an append-only fixup migration.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041000_ladder_phase2_fix_resolve_scope_from_context_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) resolve_scope_from_context: registry-driven id-less semantics (no "global")
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_scope_from_context(
  p_category TEXT,
  p_context JSONB
)
RETURNS TABLE (
  scope_type TEXT,
  scope_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_type TEXT;
  v_scope_id UUID := NULL;
  v_allowed_scopes JSONB;
  rec RECORD;
  v_key TEXT;
  v_raw TEXT;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RAISE EXCEPTION 'resolve_scope_from_context requires category' USING ERRCODE = '23514';
  END IF;

  SELECT scr.allowed_scopes
    INTO v_allowed_scopes
    FROM public.settings_category_registry scr
   WHERE scr.category = p_category
   LIMIT 1;

  IF v_allowed_scopes IS NULL OR jsonb_typeof(v_allowed_scopes) <> 'array' THEN
    SELECT public.default_allowed_scopes_v1()
      INTO v_allowed_scopes;
  END IF;

  IF v_allowed_scopes IS NULL OR jsonb_typeof(v_allowed_scopes) <> 'array' THEN
    RAISE EXCEPTION 'settings_category_registry missing allowed_scopes for category %', p_category USING ERRCODE = '23514';
  END IF;

  -- Fallback: lowest-precedence id-less scope among allowed scopes (registry-driven).
  SELECT r.scope_type
    INTO v_scope_type
    FROM jsonb_array_elements_text(v_allowed_scopes) AS x(scope_type)
    JOIN public.scope_type_registry r
      ON r.scope_type = x.scope_type
     AND r.is_enabled = TRUE
   WHERE r.entity_table IS NULL
   ORDER BY COALESCE(r.ladder_rank, 0) ASC, r.scope_type ASC
   LIMIT 1;

  IF v_scope_type IS NULL THEN
    RAISE EXCEPTION 'allowed_scopes missing id-less scope_type for category %', p_category
      USING ERRCODE = '23514';
  END IF;

  v_scope_id := NULL;

  IF p_context IS NOT NULL AND jsonb_typeof(p_context) = 'object' THEN
    <<outer>>
    FOR rec IN
      SELECT r.scope_type, r.context_keys, r.entity_table, r.ladder_rank
        FROM jsonb_array_elements_text(v_allowed_scopes) AS x(scope_type)
        JOIN public.scope_type_registry r
          ON r.scope_type = x.scope_type
         AND r.is_enabled = TRUE
       ORDER BY COALESCE(r.ladder_rank, 0) DESC, r.scope_type DESC
    LOOP
      -- Context selects id-full scopes only; id-less scopes are skipped generically.
      IF rec.entity_table IS NULL THEN
        CONTINUE;
      END IF;

      IF rec.context_keys IS NULL OR jsonb_typeof(rec.context_keys) <> 'array' THEN
        CONTINUE;
      END IF;

      FOR v_key IN
        SELECT jsonb_array_elements_text(rec.context_keys)
      LOOP
        v_raw := NULLIF(p_context->>v_key, '');
        IF v_raw IS NULL THEN
          CONTINUE;
        END IF;

        BEGIN
          v_scope_id := v_raw::uuid;
          v_scope_type := rec.scope_type;
          EXIT outer;
        EXCEPTION
          WHEN others THEN
            v_scope_id := NULL;
        END;
      END LOOP;
    END LOOP;
  END IF;

  scope_type := v_scope_type;
  scope_id := v_scope_id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.resolve_scope_from_context(TEXT, JSONB)
  IS 'Resolve the most-specific (scope_type, scope_id) from context using settings_category_registry.allowed_scopes + scope_type_registry.context_keys (id-less via entity_table IS NULL).';

-- ---------------------------------------------------------------------------
-- 2) resolve_settings_row_from_context: delegate to resolve_scope_from_context
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_settings_row_from_context(
  p_category TEXT,
  p_context JSONB
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_type TEXT;
  v_scope_id UUID;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN;
  END IF;

  SELECT r.scope_type, r.scope_id
    INTO v_scope_type, v_scope_id
    FROM public.resolve_scope_from_context(p_category, p_context) r
   LIMIT 1;

  RETURN QUERY
  SELECT * FROM public.resolve_settings_row(p_category, v_scope_type, v_scope_id) LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.resolve_settings_row_from_context(TEXT, JSONB)
  IS 'Resolve a settings row via ladder using SSOT resolve_scope_from_context (id-less via scope_type_registry.entity_table IS NULL).';

-- ---------------------------------------------------------------------------
-- 3) resolve_settings_merged_from_context: delegate to resolve_scope_from_context
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_settings_merged_from_context(
  p_category TEXT,
  p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_type TEXT;
  v_scope_id UUID;
  v_value JSONB;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN NULL;
  END IF;

  SELECT r.scope_type, r.scope_id
    INTO v_scope_type, v_scope_id
    FROM public.resolve_scope_from_context(p_category, p_context) r
   LIMIT 1;

  SELECT public.resolve_settings_merged(p_category, v_scope_type, v_scope_id)
    INTO v_value;

  RETURN v_value;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202602041000_ladder_phase2_fix_resolve_scope_from_context_v1'));
COMMIT;

