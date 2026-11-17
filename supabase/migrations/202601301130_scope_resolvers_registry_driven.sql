-- Plan: PLAN-202601-ladder-phase6-remaining-ladder-hardcoding-ssot / Step: S04
-- Migration: Registry-driven scope ladder resolvers (no hardcoded scope branches)
-- Purpose:
--   - Remove hardcoded ladder order and scope-type branches from core resolvers.
--   - Centralize ladder behavior in scope_type_registry + scope_type_aliases + scope_ladder_edges (SSOT).
--   - De-hardcode settings_category_registry.allowed_scopes defaults by sourcing from scope registry.
--
-- Notes:
--   - These functions are SECURITY DEFINER and rely on registry rows, not code branches.
--   - CREATE OR REPLACE preserves existing grants/ownership for existing functions.

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Default allowed scopes (dynamic; no hardcoded arrays)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.default_allowed_scopes_v1()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_agg(r.scope_type ORDER BY r.ladder_rank, r.scope_type),
    '[]'::jsonb
  )
  FROM public.scope_type_registry r
  WHERE r.is_enabled = TRUE
    AND r.ladder_rank IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.default_allowed_scopes_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.default_allowed_scopes_v1() TO service_role;

ALTER TABLE public.settings_category_registry
  ALTER COLUMN allowed_scopes SET DEFAULT public.default_allowed_scopes_v1();

-------------------------------------------------------------------------------
-- 2) Scope type normalization helpers (SSOT)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_root_scope_type_key_v1()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_root TEXT;
BEGIN
  SELECT r.scope_type
    INTO v_root
    FROM public.scope_type_registry r
   WHERE r.entity_table IS NULL
     AND r.is_enabled = TRUE
   ORDER BY COALESCE(r.ladder_rank, 0) ASC, r.scope_type ASC
   LIMIT 1;

  IF v_root IS NULL THEN
    RAISE EXCEPTION 'scope_type_registry missing root scope_type (entity_table IS NULL)' USING ERRCODE = '23514';
  END IF;

  RETURN v_root;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_root_scope_type_key_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_root_scope_type_key_v1() TO service_role;

CREATE OR REPLACE FUNCTION public.normalize_scope_type_v1(
  p_scope_type TEXT,
  p_fallback_to_root BOOLEAN DEFAULT TRUE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_raw TEXT := NULLIF(LOWER(BTRIM(p_scope_type)), '');
  v_scope_type TEXT;
BEGIN
  IF v_raw IS NULL THEN
    RETURN public.get_root_scope_type_key_v1();
  END IF;

  SELECT r.scope_type
    INTO v_scope_type
    FROM public.scope_type_registry r
   WHERE r.scope_type = v_raw
     AND r.is_enabled = TRUE
   LIMIT 1;

  IF v_scope_type IS NULL THEN
    SELECT r.scope_type
      INTO v_scope_type
      FROM public.scope_type_aliases a
      JOIN public.scope_type_registry r
        ON r.scope_type = a.scope_type
     WHERE a.alias = v_raw
       AND r.is_enabled = TRUE
     LIMIT 1;
  END IF;

  IF v_scope_type IS NOT NULL THEN
    RETURN v_scope_type;
  END IF;

  IF p_fallback_to_root THEN
    RETURN public.get_root_scope_type_key_v1();
  END IF;

  RAISE EXCEPTION 'Unknown scope_type: %', v_raw USING ERRCODE = '23514';
END;
$function$;

REVOKE ALL ON FUNCTION public.normalize_scope_type_v1(TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_scope_type_v1(TEXT, BOOLEAN) TO service_role;

-------------------------------------------------------------------------------
-- 3) Scope path resolver (row-driven ladder traversal)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_scope_path_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, TRUE);
  v_scopes JSONB := '{}'::jsonb;
  v_queue JSONB := '[]'::jsonb;
  v_item JSONB;
  v_curr_scope_type TEXT;
  v_curr_scope_id UUID;
  rec RECORD;
  v_parent_id UUID;
  v_sql TEXT;
BEGIN
  -- Root (or missing scope_id) collapses to root-only path.
  IF v_scope_type = v_root OR p_scope_id IS NULL THEN
    RETURN jsonb_build_array(jsonb_build_object('scope_type', v_root, 'scope_id', NULL));
  END IF;

  -- Seed with the requested scope.
  v_scopes := v_scopes || jsonb_build_object(v_scope_type, p_scope_id::text);
  v_queue := v_queue || jsonb_build_array(jsonb_build_object('scope_type', v_scope_type, 'scope_id', p_scope_id));

  WHILE jsonb_array_length(v_queue) > 0 LOOP
    v_item := v_queue->0;
    v_queue := v_queue - 0;

    v_curr_scope_type := v_item->>'scope_type';
    v_curr_scope_id := (v_item->>'scope_id')::uuid;

    IF v_curr_scope_id IS NULL THEN
      CONTINUE;
    END IF;

    FOR rec IN
      SELECT e.parent_scope_type, e.child_table, e.child_id_column, e.child_parent_column
        FROM public.scope_ladder_edges e
       WHERE e.child_scope_type = v_curr_scope_type
         AND e.is_enabled = TRUE
       ORDER BY e.parent_scope_type, e.child_parent_column
    LOOP
      v_parent_id := NULL;
      v_sql := format(
        'SELECT %I FROM %s WHERE %I = $1 LIMIT 1',
        rec.child_parent_column,
        rec.child_table::text,
        rec.child_id_column
      );

      BEGIN
        EXECUTE v_sql INTO v_parent_id USING v_curr_scope_id;
      EXCEPTION
        WHEN undefined_column OR undefined_table THEN
          v_parent_id := NULL;
      END;

      IF v_parent_id IS NULL THEN
        CONTINUE;
      END IF;

      IF v_scopes ? rec.parent_scope_type THEN
        IF (v_scopes->>rec.parent_scope_type)::uuid IS DISTINCT FROM v_parent_id THEN
          RAISE EXCEPTION
            'Scope ladder mismatch: scope_type=% has conflicting parent % (% vs %)',
            v_curr_scope_type,
            rec.parent_scope_type,
            (v_scopes->>rec.parent_scope_type),
            v_parent_id::text
            USING ERRCODE = '23514';
        END IF;
      ELSE
        v_scopes := v_scopes || jsonb_build_object(rec.parent_scope_type, v_parent_id::text);
        v_queue := v_queue || jsonb_build_array(jsonb_build_object('scope_type', rec.parent_scope_type, 'scope_id', v_parent_id));
      END IF;
    END LOOP;
  END LOOP;

  -- Always include root.
  v_scopes := v_scopes || jsonb_build_object(v_root, NULL);

  RETURN (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'scope_type', r.scope_type,
          'scope_id', (v_scopes->>r.scope_type)::uuid
        )
        ORDER BY COALESCE(r.ladder_rank, -1) DESC, r.scope_type
      ),
      '[]'::jsonb
    )
    FROM public.scope_type_registry r
    WHERE v_scopes ? r.scope_type
      AND r.is_enabled = TRUE
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_scope_path_v1(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_scope_path_v1(TEXT, UUID) TO service_role;

-------------------------------------------------------------------------------
-- 4) Organization id resolution for logging (derived via ladder)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_organization_id_for_scope_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, TRUE);
  v_tenant_scope_type TEXT;
  v_path JSONB;
  v_org_id UUID;
BEGIN
  IF p_scope_id IS NULL OR v_scope_type = v_root THEN
    RETURN NULL;
  END IF;

  SELECT r.scope_type
    INTO v_tenant_scope_type
    FROM public.scope_type_registry r
   WHERE r.entity_table = 'organizations'::regclass
     AND r.is_enabled = TRUE
   ORDER BY COALESCE(r.ladder_rank, 0) ASC, r.scope_type ASC
   LIMIT 1;

  IF v_tenant_scope_type IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_scope_type = v_tenant_scope_type THEN
    RETURN p_scope_id;
  END IF;

  v_path := public.resolve_scope_path_v1(v_scope_type, p_scope_id);

  SELECT (e.elem->>'scope_id')::uuid
    INTO v_org_id
    FROM jsonb_array_elements(v_path) AS e(elem)
   WHERE e.elem->>'scope_type' = v_tenant_scope_type
   LIMIT 1;

  RETURN v_org_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_organization_id_for_scope_v1(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_organization_id_for_scope_v1(TEXT, UUID) TO service_role;

-------------------------------------------------------------------------------
-- 5) validate_settings_scope (dynamic scope validation)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_settings_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  scope_valid BOOLEAN := false;
  v_allowed_scopes JSONB;
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_scope_type TEXT := public.normalize_scope_type_v1(NEW.scope_type, FALSE);
  v_entity_table REGCLASS;
  v_id_column TEXT;
  v_sql TEXT;
BEGIN
  IF NEW.scope_type IS DISTINCT FROM v_scope_type THEN
    RAISE EXCEPTION 'scope_type must be canonical: % (got %)', v_scope_type, NEW.scope_type
      USING ERRCODE = '23514';
  END IF;

  -- Category governance (optional): restrict which scopes may exist for a category.
  SELECT scr.allowed_scopes
    INTO v_allowed_scopes
    FROM public.settings_category_registry scr
   WHERE scr.category = NEW.category
   LIMIT 1;

  IF v_allowed_scopes IS NOT NULL AND jsonb_typeof(v_allowed_scopes) = 'array' THEN
    IF NOT (v_allowed_scopes ? v_scope_type) THEN
      RAISE EXCEPTION 'Scope "%" is not allowed for category "%"', v_scope_type, NEW.category
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT r.entity_table, r.id_column
    INTO v_entity_table, v_id_column
    FROM public.scope_type_registry r
   WHERE r.scope_type = v_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  IF v_scope_type = v_root OR v_entity_table IS NULL THEN
    IF NEW.scope_id IS NULL THEN
      scope_valid := true;
    END IF;
  ELSE
    IF NEW.scope_id IS NULL THEN
      RAISE EXCEPTION 'Invalid scope %/% for % record %', v_scope_type, NEW.scope_id, TG_TABLE_NAME, NEW.id
        USING ERRCODE = '23514';
    END IF;

    v_sql := format('SELECT 1 FROM %s WHERE %I = $1 LIMIT 1', v_entity_table::text, v_id_column);
    EXECUTE v_sql USING NEW.scope_id;
    scope_valid := FOUND;
  END IF;

  IF NOT scope_valid THEN
    RAISE EXCEPTION 'Invalid scope %/% for % record %', v_scope_type, NEW.scope_id, TG_TABLE_NAME, NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'settings' THEN
    PERFORM 1
      FROM public.settings_versions sv
     WHERE sv.id = NEW.settings_version_id
       AND sv.scope_type = NEW.scope_type
       AND sv.scope_hash = NEW.scope_hash;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings row % references version % with mismatched scope', NEW.id, NEW.settings_version_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-------------------------------------------------------------------------------
-- 6) resolve_settings (dynamic ladder traversal)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_settings(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, TRUE);
  v_value JSONB;
  v_safe_missing TEXT := NULL;
  v_scope_path JSONB;
BEGIN
  IF p_category IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT scr.safe_missing_behavior
    INTO v_safe_missing
    FROM public.settings_category_registry scr
   WHERE scr.category = p_category
   LIMIT 1;

  IF v_scope_type = v_root OR p_scope_id IS NULL THEN
    SELECT s.cached_value
      INTO v_value
      FROM public.settings s
     WHERE s.category = p_category
       AND s.scope_type = v_root
       AND s.scope_id IS NULL
     ORDER BY s.last_updated DESC
     LIMIT 1;

    IF v_value IS NULL AND v_safe_missing = 'hard_fail' THEN
      RAISE EXCEPTION 'Missing required global settings for category: %', p_category USING ERRCODE = '23514';
    END IF;

    RETURN v_value;
  END IF;

  SELECT s.cached_value
    INTO v_value
    FROM public.settings s
   WHERE s.category = p_category
     AND s.scope_type = v_scope_type
     AND s.scope_id IS NOT DISTINCT FROM p_scope_id
   ORDER BY s.last_updated DESC
   LIMIT 1;

  IF v_value IS NOT NULL THEN
    RETURN v_value;
  END IF;

  v_scope_path := public.resolve_scope_path_v1(v_scope_type, p_scope_id);

  SELECT s.cached_value
    INTO v_value
    FROM jsonb_array_elements(v_scope_path) WITH ORDINALITY AS e(elem, ord)
    JOIN LATERAL (
      SELECT (e.elem->>'scope_type')::text AS scope_type,
             (e.elem->>'scope_id')::uuid AS scope_id
    ) p ON TRUE
    JOIN public.settings s
      ON s.category = p_category
     AND s.scope_type = p.scope_type
     AND s.scope_id IS NOT DISTINCT FROM p.scope_id
   ORDER BY e.ord
   LIMIT 1;

  IF v_value IS NULL AND v_safe_missing = 'hard_fail' THEN
    RAISE EXCEPTION 'Missing required global settings for category: %', p_category USING ERRCODE = '23514';
  END IF;

  RETURN v_value;
END;
$function$;

-------------------------------------------------------------------------------
-- 7) resolve_settings_row (dynamic ladder traversal + SSOT logging)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_settings_row(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID
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
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, TRUE);
  v_scope_path JSONB;
  v_safe_missing TEXT := NULL;
  v_log_org_id UUID := NULL;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN;
  END IF;

  SELECT scr.safe_missing_behavior
    INTO v_safe_missing
    FROM public.settings_category_registry scr
   WHERE scr.category = p_category
   LIMIT 1;

  v_scope_path := public.resolve_scope_path_v1(v_scope_type, p_scope_id);

  RETURN QUERY
  SELECT s.id,
         s.settings_version_id,
         s.scope_type,
         s.scope_id,
         s.cached_value,
         sv.version,
         v_scope_path
    FROM jsonb_array_elements(v_scope_path) WITH ORDINALITY AS e(elem, ord)
    JOIN LATERAL (
      SELECT (e.elem->>'scope_type')::text AS scope_type,
             (e.elem->>'scope_id')::uuid AS scope_id
    ) p ON TRUE
    JOIN public.settings s
      ON s.category = p_category
     AND s.scope_type = p.scope_type
     AND s.scope_id IS NOT DISTINCT FROM p.scope_id
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   ORDER BY e.ord, s.id
   LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  -- Missing: apply safe_missing_behavior for registered categories (SSOT).
  IF v_safe_missing IS NULL OR v_safe_missing = 'return_null' THEN
    RETURN;
  END IF;

  -- Attempt to record provenance for missing settings (non-blocking).
  v_log_org_id := public.resolve_organization_id_for_scope_v1(v_scope_type, p_scope_id);

  IF v_log_org_id IS NOT NULL THEN
    BEGIN
      PERFORM public.log_settings_resolution(
        p_organization_id := v_log_org_id,
        p_category := p_category,
        p_winning_scope_type := 'missing',
        p_winning_scope_id := NULL,
        p_winning_settings_id := NULL,
        p_winning_settings_version_id := NULL,
        p_winning_version := NULL,
        p_scope_path := v_scope_path,
        p_inputs := jsonb_build_object(
          'requested_scope_type', v_scope_type,
          'requested_scope_id', p_scope_id,
          'safe_missing_behavior', v_safe_missing
        ),
        p_merge_notes := NULL
      );
    EXCEPTION
      WHEN others THEN
        NULL;
    END;
  END IF;

  IF v_safe_missing = 'hard_fail' THEN
    RAISE EXCEPTION 'Missing required settings for category: %', p_category USING ERRCODE = '23514';
  END IF;

  RETURN;
END;
$function$;

-------------------------------------------------------------------------------
-- 8) resolve_settings_merged (dynamic ladder merge order)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_settings_merged(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, TRUE);
  v_value JSONB := '{}'::jsonb;
  v_row JSONB;
  v_scope_path JSONB;
  rec RECORD;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN NULL;
  END IF;

  v_scope_path := public.resolve_scope_path_v1(v_scope_type, p_scope_id);

  -- Merge order: lowest precedence -> highest precedence (root/global first).
  FOR rec IN
    SELECT (e.elem->>'scope_type')::text AS scope_type,
           (e.elem->>'scope_id')::uuid AS scope_id,
           e.ord
      FROM jsonb_array_elements(v_scope_path) WITH ORDINALITY AS e(elem, ord)
     ORDER BY e.ord DESC
  LOOP
    SELECT s.cached_value
      INTO v_row
      FROM public.settings s
     WHERE s.category = p_category
       AND s.scope_type = rec.scope_type
       AND s.scope_id IS NOT DISTINCT FROM rec.scope_id
     ORDER BY s.last_updated DESC NULLS LAST
     LIMIT 1;

    IF v_row IS NOT NULL THEN
      v_value := public.deep_merge_jsonb(v_value, v_row);
    END IF;
  END LOOP;

  RETURN v_value;
END;
$function$;

COMMIT;

