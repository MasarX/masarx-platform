-- Plan: PLAN-202601-ladder-phase6-remaining-ladder-hardcoding-ssot / Step: S04
-- Migration: resolve_webhook_ingest_policy() delegates to registry-driven settings resolution
-- Purpose:
--   - Remove hardcoded ladder ordering (UNION priorities) from resolve_webhook_ingest_policy().
--   - Delegate ladder traversal to resolve_settings_row() (backed by scope registry SSOT).

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_webhook_ingest_policy(
  p_webhook_source_id UUID
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  policy JSONB,
  policy_version INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_source_scope_type TEXT;
  v_source_table REGCLASS;
  v_source_id_column TEXT;
  v_sql TEXT;
  v_rows INT;
BEGIN
  SELECT r.scope_type, r.entity_table, r.id_column
    INTO v_source_scope_type, v_source_table, v_source_id_column
    FROM public.scope_type_registry r
   WHERE r.entity_table = 'webhook_sources'::regclass
     AND r.is_enabled = TRUE
   ORDER BY COALESCE(r.ladder_rank, 0) DESC, r.scope_type ASC
   LIMIT 1;

  IF v_source_scope_type IS NULL OR v_source_table IS NULL THEN
    RAISE EXCEPTION 'scope_type_registry missing active scope for entity_table=webhook_sources'
      USING ERRCODE = '23514';
  END IF;

  -- Preserve the legacy contract: non-existent webhook_source_id is an error.
  v_sql := format('SELECT 1 FROM %s WHERE %I = $1 LIMIT 1', v_source_table::text, v_source_id_column);
  EXECUTE v_sql USING p_webhook_source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook source % not found', p_webhook_source_id
      USING ERRCODE = '23503';
  END IF;

  RETURN QUERY
  SELECT r.settings_id,
         r.settings_version_id,
         r.scope_type,
         r.scope_id,
         r.value AS policy,
         r.version AS policy_version
    FROM public.resolve_settings_row('webhook_ingest_policy', v_source_scope_type, p_webhook_source_id) AS r;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'No webhook_ingest_policy found for webhook_source_id=%', p_webhook_source_id
      USING ERRCODE = '23514';
  END IF;
END;
$function$;

COMMIT;
