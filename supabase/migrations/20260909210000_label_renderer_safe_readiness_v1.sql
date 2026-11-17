BEGIN;
CREATE OR REPLACE FUNCTION public.ui_label_renderer_readiness_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Label renderer readiness access denied' USING ERRCODE = '42501';
  END IF;
  IF public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Label renderer readiness access denied' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.resolve_settings_scope_context_v1('tenant', p_organization_id);
  PERFORM public.assert_capability_v1('settings.read', 'tenant', p_organization_id);
  BEGIN
    PERFORM public.resolve_label_renderer_invoke_config_v1(p_organization_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('configured', false);
  END;
  RETURN jsonb_build_object('configured', true);
END;
$function$;
CREATE OR REPLACE FUNCTION api.ui_label_renderer_readiness_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_label_renderer_readiness_v1(p_organization_id);
$function$;
REVOKE ALL ON FUNCTION public.ui_label_renderer_readiness_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_label_renderer_readiness_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_label_renderer_readiness_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_label_renderer_readiness_v1(uuid) TO authenticated;
COMMENT ON FUNCTION public.ui_label_renderer_readiness_v1(uuid) IS
  'Authorized effective configuration readiness only; no secrets, provider metadata or outbound health probe.';
NOTIFY pgrst, 'reload schema';
COMMIT;
