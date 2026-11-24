BEGIN;
SET LOCAL lock_timeout = '10s';

-- Anonymous requests can run the hook without acquiring access to public.
CREATE SCHEMA request_guard;
REVOKE ALL ON SCHEMA request_guard FROM PUBLIC;
GRANT USAGE ON SCHEMA request_guard TO anon, authenticated, service_role,
  edge_webhook_role, edge_api_caller_role, edge_api_gateway_role,
  edge_label_renderer_role, edge_marketing_role;

INSERT INTO public.feature_flags (name, description, scope_type, enabled)
VALUES ('privileged_session_assurance', 'Require authenticator verification on privileged Data API sessions', 'global', false);

CREATE FUNCTION request_guard.privileged_session_allowed_v1()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN claims->>'role' = 'service_role' THEN true
    WHEN claims->>'aal' = 'aal2' THEN true
    WHEN NOT EXISTS (
      SELECT 1 FROM public.feature_flags
      WHERE name = 'privileged_session_assurance' AND scope_type = 'global'
        AND scope_id IS NULL AND enabled
    ) THEN true
    ELSE NOT (
      coalesce(public.is_platform_user(), false)
      OR coalesce(public.user_has_permission_v1('finance.read'), false)
      OR coalesce(public.user_has_permission_v1('finance.write'), false)
      OR coalesce(public.user_has_capability_v1('finance.read'), false)
      OR coalesce(public.user_has_capability_v1('finance.write'), false)
      OR coalesce(public.user_has_capability_v1('integration_plugins.write'), false)
    )
  END
  FROM (SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb AS claims) AS request;
$$;

REVOKE EXECUTE ON FUNCTION request_guard.privileged_session_allowed_v1() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION request_guard.privileged_session_allowed_v1() TO authenticated, ui_rpc_executor;

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
  IF NOT request_guard.privileged_session_allowed_v1() THEN
    RAISE EXCEPTION 'mfa_required' USING ERRCODE = 'PT403';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION request_guard.enforce_privileged_session_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_guard.enforce_privileged_session_v1() TO anon, authenticated, service_role,
  edge_webhook_role, edge_api_caller_role, edge_api_gateway_role,
  edge_label_renderer_role, edge_marketing_role;

-- Restrictive checks also apply when these tables are queried outside PostgREST.
CREATE POLICY privileged_session_assurance ON public.bank_accounts
  AS RESTRICTIVE FOR ALL TO authenticated, ui_rpc_executor
  USING ((SELECT request_guard.privileged_session_allowed_v1()));

CREATE POLICY privileged_session_assurance ON public.provider_auth_configs
  AS RESTRICTIVE FOR ALL TO authenticated, ui_rpc_executor
  USING ((SELECT request_guard.privileged_session_allowed_v1()));

CREATE POLICY privileged_session_assurance ON public.rbac_role_permissions
  AS RESTRICTIVE FOR ALL TO authenticated, ui_rpc_executor
  USING ((SELECT request_guard.privileged_session_allowed_v1()));

-- Extend the sealed executor plan with the one function referenced by the policies.
DO $receipt$
DECLARE
  prior_seal text;
  prior_before jsonb;
  prior_after jsonb;
  allowed_dependency jsonb := jsonb_build_array(jsonb_build_object(
    'object_kind', 'function', 'object_id', 'request_guard.privileged_session_allowed_v1()'::regprocedure::oid,
    'privilege', 'EXECUTE', 'column_name', NULL));
  current_plan jsonb;
  expected_after jsonb;
  digest text;
BEGIN
  LOCK TABLE public.marketplace_review_readback_state_v1 IN EXCLUSIVE MODE;
  IF (SELECT relowner FROM pg_class WHERE oid = 'public.marketplace_review_readback_state_v1'::regclass)
      IS DISTINCT FROM current_user::regrole::oid THEN
    RAISE EXCEPTION 'Session assurance receipt extension requires the existing receipt owner' USING ERRCODE = '42501';
  END IF;
  prior_seal := obj_description('public.marketplace_review_readback_state_v1'::regclass, 'pg_class');
  SELECT encode(sha256(convert_to(jsonb_object_agg(key, value ORDER BY key)::text, 'UTF8')), 'hex')
    INTO digest FROM public.marketplace_review_readback_state_v1;
  IF prior_seal IS DISTINCT FROM 'marketplace_review_readback_state_v1:sha256:' || digest THEN
    RAISE EXCEPTION 'Marketplace predecessor receipt integrity mismatch';
  END IF;
  SELECT value INTO STRICT prior_before FROM public.marketplace_review_readback_state_v1 WHERE key = 'plan_before';
  SELECT value INTO STRICT prior_after FROM public.marketplace_review_readback_state_v1 WHERE key = 'plan_after';
  SELECT jsonb_agg(to_jsonb(p) ORDER BY object_kind, object_id, privilege, column_name)
    INTO current_plan FROM public.ui_rpc_executor_privilege_plan_v1() AS p;
  SELECT jsonb_agg(entry ORDER BY entry->>'object_kind', (entry->>'object_id')::oid,
    entry->>'privilege', entry->>'column_name') INTO expected_after
  FROM jsonb_array_elements(prior_after || allowed_dependency) AS plan(entry);
  IF current_plan IS DISTINCT FROM expected_after THEN
    RAISE EXCEPTION 'Unexpected executor plan after installing session assurance policies';
  END IF;

  INSERT INTO public.marketplace_review_readback_state_v1(key, value) VALUES (
    'privileged_session_assurance_extension_v1',
    jsonb_build_object('predecessor_seal', prior_seal, 'plan_before', prior_before,
      'plan_after', prior_after, 'added', allowed_dependency)
  );
  UPDATE public.marketplace_review_readback_state_v1 SET value = (
    SELECT jsonb_agg(entry ORDER BY entry->>'object_kind', (entry->>'object_id')::oid,
      entry->>'privilege', entry->>'column_name')
    FROM jsonb_array_elements(value || allowed_dependency) AS plan(entry)
  ) WHERE key IN ('plan_before', 'plan_after');
  SELECT encode(sha256(convert_to(jsonb_object_agg(key, value ORDER BY key)::text, 'UTF8')), 'hex')
    INTO digest FROM public.marketplace_review_readback_state_v1;
  EXECUTE format('COMMENT ON TABLE public.marketplace_review_readback_state_v1 IS %L',
    'marketplace_review_readback_state_v1:sha256:' || digest);
END;
$receipt$;

-- PostgREST also checks assurance before entering an RPC with owner privileges.
ALTER ROLE authenticator SET pgrst.db_pre_request = 'request_guard.enforce_privileged_session_v1';
NOTIFY pgrst, 'reload config';

COMMIT;
