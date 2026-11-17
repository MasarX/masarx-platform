-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S03
-- Migration: label designer read RPC for label_media_catalog
-- Purpose:
--   - Expose a safe, org-scoped, authenticated read API for label_media_catalog.
BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.label_designer_get_label_media_catalog(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_check JSONB;
  v_value JSONB;
BEGIN
  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  v_value := public.resolve_settings_merged('label_media_catalog', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_get_label_media_catalog(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_label_media_catalog(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_get_label_media_catalog(TEXT, UUID) TO service_role;

COMMIT;

