-- Plan: PLAN-202601-ladder-phase6-remaining-ladder-hardcoding-ssot / Step: S04
-- Migration: Scope ladder SSOT fixup - ensure resource participates in ladder
-- Purpose:
--   - Ensure the resource scope has a configured parent edge to tenant (row-driven).
--   - Uses the canonical SSOT registry tables (no hardcoded ladder traversal).

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_resource_scope_type TEXT;
  v_tenant_scope_type TEXT;
BEGIN
  SELECT r.scope_type
    INTO v_resource_scope_type
    FROM public.scope_type_registry r
   WHERE r.entity_table = 'providers'::regclass
     AND r.is_enabled = TRUE
   ORDER BY COALESCE(r.ladder_rank, 0) DESC, r.scope_type ASC
   LIMIT 1;

  SELECT r.scope_type
    INTO v_tenant_scope_type
    FROM public.scope_type_registry r
   WHERE r.entity_table = 'organizations'::regclass
     AND r.is_enabled = TRUE
   ORDER BY COALESCE(r.ladder_rank, 0) ASC, r.scope_type ASC
   LIMIT 1;

  IF v_resource_scope_type IS NULL OR v_tenant_scope_type IS NULL THEN
    RAISE EXCEPTION 'scope_type_registry missing required scope types for resource->tenant edge'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.scope_ladder_edges (
    child_scope_type,
    parent_scope_type,
    child_table,
    child_id_column,
    child_parent_column,
    is_enabled
  )
  VALUES (
    v_resource_scope_type,
    v_tenant_scope_type,
    'providers'::regclass,
    'id',
    'organization_id',
    TRUE
  )
  ON CONFLICT (child_scope_type, parent_scope_type) DO UPDATE
  SET
    child_table = EXCLUDED.child_table,
    child_id_column = EXCLUDED.child_id_column,
    child_parent_column = EXCLUDED.child_parent_column,
    is_enabled = EXCLUDED.is_enabled,
    updated_at = now();
END;
$$;

COMMIT;

