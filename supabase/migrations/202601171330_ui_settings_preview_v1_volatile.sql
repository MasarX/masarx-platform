-- Migration: Mark ui_settings_preview_v1 as VOLATILE (it writes settings_resolution_log)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601171330_ui_settings_preview_v1_volatile'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_settings_preview_v1(
  p_category TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT;
  v_scope_id UUID;
  v_org_id UUID;
  v_client_id UUID;
  v_sender_id UUID;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_value JSONB;
  v_version INT;
  v_scope_path JSONB;
  v_resolution_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_settings_preview_v1 requires authenticated user';
  END IF;

  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RAISE EXCEPTION 'ui_settings_preview_v1 requires category';
  END IF;

  SELECT scope_type, scope_id, organization_id, client_id, sender_id
    INTO v_scope_type, v_scope_id, v_org_id, v_client_id, v_sender_id
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
    LIMIT 1;

  PERFORM public.assert_capability_v1('settings.read', v_scope_type, v_scope_id);

  SELECT settings_id, settings_version_id, scope_type, scope_id, value, version, scope_path
    INTO v_settings_id, v_settings_version_id, v_scope_type, v_scope_id, v_value, v_version, v_scope_path
    FROM public.resolve_settings_row(p_category, v_scope_type, v_scope_id)
    LIMIT 1;

  IF v_value IS NULL THEN
    RAISE EXCEPTION 'ui_settings_preview_v1 settings not found';
  END IF;

  v_resolution_id := public.log_settings_resolution(
    p_organization_id := v_org_id,
    p_category := p_category,
    p_winning_scope_type := v_scope_type,
    p_winning_scope_id := v_scope_id,
    p_winning_settings_id := v_settings_id,
    p_winning_settings_version_id := v_settings_version_id,
    p_winning_version := v_version,
    p_scope_path := v_scope_path,
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id
    )),
    p_merge_notes := NULL
  );

  RETURN jsonb_build_object(
    'category', p_category,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'settings_id', v_settings_id,
    'settings_version_id', v_settings_version_id,
    'settings_resolution_id', v_resolution_id,
    'scope_path', v_scope_path,
    'value', v_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_settings_preview_v1(TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_settings_preview_v1(TEXT, TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_settings_preview_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601171330_ui_settings_preview_v1_volatile'));
COMMIT;

