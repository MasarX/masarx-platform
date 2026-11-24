BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE FUNCTION public.privileged_session_allowed_v1()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN auth.jwt()->>'role' IS DISTINCT FROM 'authenticated' THEN true
    WHEN auth.jwt()->>'aal' = 'aal2' THEN true
    ELSE NOT (
      coalesce(public.is_platform_user(), false)
      OR coalesce(public.user_has_permission_v1('finance.read'), false)
      OR coalesce(public.user_has_permission_v1('finance.write'), false)
      OR coalesce(public.user_has_capability_v1('finance.read'), false)
      OR coalesce(public.user_has_capability_v1('finance.write'), false)
      OR coalesce(public.user_has_capability_v1('integration_plugins.write'), false)
    )
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.privileged_session_allowed_v1() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.privileged_session_allowed_v1() TO authenticated;

-- Anonymous requests can run the hook without acquiring access to public.
CREATE SCHEMA request_guard;
REVOKE ALL ON SCHEMA request_guard FROM PUBLIC;
GRANT USAGE ON SCHEMA request_guard TO anon, authenticated, service_role;

CREATE FUNCTION request_guard.enforce_privileged_session_v1()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN;
  END IF;
  -- This self-only RPC activates a pending account before the user can enroll.
  IF current_setting('request.path', true) = '/rpc/tenant_user_invite_accept_v1'
     AND current_setting('request.method', true) = 'POST' THEN
    RETURN;
  END IF;
  IF NOT public.privileged_session_allowed_v1() THEN
    RAISE EXCEPTION 'mfa_required' USING ERRCODE = 'PT403';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION request_guard.enforce_privileged_session_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_guard.enforce_privileged_session_v1() TO anon, authenticated, service_role;

-- Restrictive checks also apply when these tables are queried outside PostgREST.
CREATE POLICY privileged_session_assurance ON public.bank_accounts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.privileged_session_allowed_v1()));

CREATE POLICY privileged_session_assurance ON public.provider_auth_configs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.privileged_session_allowed_v1()));

CREATE POLICY privileged_session_assurance ON public.rbac_role_permissions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.privileged_session_allowed_v1()));

-- PostgREST also checks assurance before entering an RPC with owner privileges.
ALTER ROLE authenticator SET pgrst.db_pre_request = 'request_guard.enforce_privileged_session_v1';
NOTIFY pgrst, 'reload config';

COMMIT;
