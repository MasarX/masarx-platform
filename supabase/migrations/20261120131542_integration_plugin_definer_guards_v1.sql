BEGIN;

CREATE OR REPLACE FUNCTION public.integration_plugin_egress_policy_preview_v1(
  p_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_winning_scope_type TEXT;
  v_winning_scope_id UUID;
  v_value JSONB;
  v_version INT;
  v_scope_path JSONB;
  v_resolution_id UUID;
  v_requested_scope_type TEXT := CASE WHEN p_organization_id IS NULL THEN public.get_root_scope_type_key_v1() ELSE 'tenant' END;
BEGIN
  IF p_organization_id IS NOT NULL THEN
    PERFORM public.assert_capability_v1('integration_plugins.read', 'tenant', p_organization_id);
  ELSE
    PERFORM public.assert_capability_v1('integration_plugins.read');
  END IF;

  SELECT settings_id, settings_version_id, scope_type, scope_id, value, version, scope_path
    INTO v_settings_id, v_settings_version_id, v_winning_scope_type, v_winning_scope_id, v_value, v_version, v_scope_path
    FROM public.resolve_settings_row(
      'integration_plugin_egress_policy',
      v_requested_scope_type,
      p_organization_id
    )
   LIMIT 1;

  IF v_value IS NULL THEN
    v_value := public.integration_plugin_resolve_policy_v1(
      'integration_plugin_egress_policy',
      p_organization_id
    );
  END IF;

  IF v_value IS NULL OR v_value = '{}'::jsonb THEN
    RAISE EXCEPTION 'integration_plugin_egress_policy_preview_v1 settings not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_organization_id IS NOT NULL THEN
    v_resolution_id := public.log_settings_resolution(
      p_organization_id := p_organization_id,
      p_category := 'integration_plugin_egress_policy',
      p_winning_scope_type := v_winning_scope_type,
      p_winning_scope_id := v_winning_scope_id,
      p_winning_settings_id := v_settings_id,
      p_winning_settings_version_id := v_settings_version_id,
      p_winning_version := v_version,
      p_scope_path := v_scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'scope_type', v_requested_scope_type,
        'scope_id', p_organization_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'category', 'integration_plugin_egress_policy',
    'scope_type', v_winning_scope_type,
    'scope_id', v_winning_scope_id,
    'settings_id', v_settings_id,
    'settings_version_id', v_settings_version_id,
    'settings_resolution_id', v_resolution_id,
    'scope_path', COALESCE(v_scope_path, '[]'::jsonb),
    'value', v_value
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.integration_plugin_egress_policy_preview_v1(UUID)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.integration_plugin_set_binding_runtime_enabled_v1(UUID, BOOLEAN, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

COMMIT;
