-- Migration: UI access policy request RPC
BEGIN;
SELECT pg_advisory_lock(hashtext('202601041130_ui_access_policy_request_rpc'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_request_access_policy_change_v1(
  p_value JSONB,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL,
  p_change_reason TEXT DEFAULT NULL,
  p_effective_from TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  settings_version_id UUID,
  domain_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.assert_capability_v1('access_policy.request', p_scope_type, p_scope_id);

  RETURN QUERY
  SELECT *
    FROM public.request_settings_change_v1(
      p_category := 'access_control_policy',
      p_scope_type := p_scope_type,
      p_scope_id := p_scope_id,
      p_value := p_value,
      p_change_reason := p_change_reason,
      p_effective_from := COALESCE(p_effective_from, now())
    );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_request_access_policy_change_v1(JSONB, TEXT, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_request_access_policy_change_v1(JSONB, TEXT, UUID, TEXT, TIMESTAMPTZ) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601041130_ui_access_policy_request_rpc'));
COMMIT;
