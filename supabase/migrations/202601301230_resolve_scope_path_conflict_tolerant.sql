-- Plan: PLAN-202601-ladder-phase6-remaining-ladder-hardcoding-ssot / Step: S04
-- Migration: resolve_scope_path_v1 conflict-tolerant ladder traversal
-- Purpose:
--   - Avoid runtime hard-fail when multiple ladder paths produce different IDs for the same ancestor scope_type.
--   - Preserve resolver availability by deterministically keeping the first discovered ancestor ID and continuing.
-- Notes:
--   - This does not change the ladder graph; it only changes conflict handling during traversal.

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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

      -- Conflict-tolerant: if the scope_type already exists with a different id,
      -- keep the first discovered value and continue traversal.
      IF v_scopes ? rec.parent_scope_type THEN
        CONTINUE;
      END IF;

      v_scopes := v_scopes || jsonb_build_object(rec.parent_scope_type, v_parent_id::text);
      v_queue := v_queue || jsonb_build_array(jsonb_build_object('scope_type', rec.parent_scope_type, 'scope_id', v_parent_id));
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

COMMIT;

