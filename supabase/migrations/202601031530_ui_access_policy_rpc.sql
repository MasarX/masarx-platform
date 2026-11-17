-- Migration: UI access policy RPC
BEGIN;
SELECT pg_advisory_lock(hashtext('202601031530_ui_access_policy_rpc'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_access_policy_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), public.current_user_scope_type(), 'global'));
  v_scope_id UUID := COALESCE(p_scope_id, public.current_user_scope_id());
  v_policy JSONB;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_scope_path JSONB;
  v_resolution_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_access_policy_v1 requires authenticated user';
  END IF;

  SELECT policy, settings_id, settings_version_id, scope_path, settings_resolution_id, scope_type, scope_id
    INTO v_policy, v_settings_id, v_settings_version_id, v_scope_path, v_resolution_id, v_scope_type, v_scope_id
    FROM public.resolve_access_control_policy_v1(v_scope_type, v_scope_id, TRUE)
    LIMIT 1;

  IF v_policy IS NULL THEN
    RAISE EXCEPTION 'ui_access_policy_v1 policy not found';
  END IF;

  PERFORM public.assert_capability_v1('access_policy.read', v_scope_type, v_scope_id);

  RETURN jsonb_build_object(
    'policy', v_policy,
    'settings_resolution_id', v_resolution_id,
    'settings_id', v_settings_id,
    'settings_version_id', v_settings_version_id,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'scope_path', v_scope_path
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_access_policy_v1(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_access_policy_v1(TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601031530_ui_access_policy_rpc'));
COMMIT;
