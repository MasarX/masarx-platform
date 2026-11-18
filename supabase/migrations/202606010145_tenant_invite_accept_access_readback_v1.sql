-- Tenant invite acceptance and access readback.
--
-- Authenticated invite users accept the invite by completing the hosted auth
-- callback. Console and FieldOps both hydrate access from backend identity
-- reads, so the acceptance transition belongs in the backend identity seam.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606010145_tenant_invite_accept_access_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.tenant_user_invite_accept_v1(
  p_user_id UUID DEFAULT NULL::uuid
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_auth_user_id UUID := auth.uid();
  v_target_user_id UUID := COALESCE(p_user_id, v_auth_user_id);
  v_user public.users%ROWTYPE;
  v_role_keys TEXT[];
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
BEGIN
  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_accept_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_accept_v1 requires user_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_target_user_id <> v_auth_user_id AND NOT public.request_role_is_service_v1() THEN
    RAISE EXCEPTION 'tenant_user_invite_accept_v1 cannot accept another user invite'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_user
    FROM public.users
   WHERE id = v_target_user_id
   FOR UPDATE;

  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_accept_v1 user % not found', v_target_user_id
      USING ERRCODE = '23503';
  END IF;

  IF v_user.status IS DISTINCT FROM 'invited' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'accepted', false,
      'user_id', v_user.id,
      'organization_id', v_user.organization_id,
      'email', v_user.email,
      'status', v_user.status,
      'access_scope_type', v_user.access_scope_type,
      'access_scope_id', v_user.access_scope_id
    );
  END IF;

  SELECT COALESCE(array_agg(DISTINCT r.key ORDER BY r.key), ARRAY[]::text[])
    INTO v_role_keys
    FROM public.rbac_user_role_assignments a
    JOIN public.rbac_roles r ON r.id = a.role_id
   WHERE a.organization_id = v_user.organization_id
     AND a.user_id = v_user.id
     AND a.revoked_at IS NULL
     AND COALESCE(r.is_active, TRUE) IS TRUE;

  UPDATE public.users
     SET status = 'active',
         last_login_at = now(),
         updated_at = now()
   WHERE id = v_user.id
   RETURNING * INTO v_user;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system,
    correlation_id, settings_resolution_id
  ) VALUES (
    v_decision_id, v_user.organization_id,
    'users.invite', 'user', v_user.id,
    'tenant_user_invite_accept_v1', 'accepted',
    jsonb_strip_nulls(jsonb_build_object(
      'user_id', v_user.id,
      'email', v_user.email,
      'accepted_from_status', 'invited',
      'accepted_to_status', v_user.status,
      'role_keys', COALESCE(v_role_keys, ARRAY[]::text[]),
      'access_scope_type', v_user.access_scope_type,
      'access_scope_id', v_user.access_scope_id
    )),
    'tenant_user_invite_accept_v1', v_correlation_id, NULL
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload,
    correlation_id, status
  ) VALUES (
    v_user.organization_id, 'user.invite_accepted', 'user', v_user.id,
    jsonb_strip_nulls(jsonb_build_object(
      'email', v_user.email,
      'role_keys', COALESCE(v_role_keys, ARRAY[]::text[]),
      'access_scope_type', v_user.access_scope_type,
      'access_scope_id', v_user.access_scope_id
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'accepted', true,
    'user_id', v_user.id,
    'organization_id', v_user.organization_id,
    'email', v_user.email,
    'status', v_user.status,
    'access_scope_type', v_user.access_scope_type,
    'access_scope_id', v_user.access_scope_id,
    'role_keys', COALESCE(v_role_keys, ARRAY[]::text[]),
    'correlation_id', v_correlation_id,
    'decision_id', v_decision_id
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_me_v1()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID;
  v_user RECORD;
  v_org RECORD;
  v_scope_type TEXT;
  v_policy_scope_id UUID;
  v_identity_scope_id UUID;
  v_scope_label TEXT;
  v_policy JSONB;
  v_resolution_id UUID;
  v_roles TEXT[];
  v_caps TEXT[];
  v_acceptance JSONB;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_me_v1 requires authenticated user';
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = v_user_id;
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'ui_me_v1 requires a Console user profile';
  END IF;

  IF v_user.status = 'invited' THEN
    v_acceptance := public.tenant_user_invite_accept_v1(v_user_id);
    SELECT * INTO v_user FROM public.users WHERE id = v_user_id;
  END IF;

  SELECT * INTO v_org FROM public.organizations WHERE id = v_user.organization_id;
  IF v_org.id IS NULL THEN
    RAISE EXCEPTION 'ui_me_v1 requires an organization profile';
  END IF;

  v_scope_type := public.current_user_scope_type();
  v_policy_scope_id := public.current_user_scope_id();
  v_identity_scope_id := CASE
    WHEN v_scope_type IN ('platform', 'tenant') THEN NULL
    ELSE v_user.access_scope_id
  END;

  SELECT policy, settings_resolution_id
    INTO v_policy, v_resolution_id
    FROM public.resolve_access_control_policy_v1(v_scope_type, v_policy_scope_id, TRUE)
    LIMIT 1;

  v_roles := public.resolve_role_keys_v1(v_policy, v_user_id, v_user.user_type);
  v_caps := public.resolve_capabilities_v1(v_policy, v_roles);

  IF v_scope_type = 'tenant' THEN
    v_scope_label := v_org.name;
  ELSIF v_scope_type = 'client' THEN
    SELECT name INTO v_scope_label FROM public.clients WHERE id = v_identity_scope_id;
  ELSIF v_scope_type = 'sender' THEN
    SELECT name INTO v_scope_label FROM public.senders WHERE id = v_identity_scope_id;
  ELSE
    v_scope_label := NULL;
  END IF;

  RETURN jsonb_build_object(
    'user', jsonb_build_object(
      'id', v_user.id,
      'email', v_user.email,
      'name', v_user.full_name,
      'user_type', v_user.user_type,
      'organization_id', v_user.organization_id,
      'access_scope_type', v_scope_type,
      'access_scope_id', v_identity_scope_id,
      'status', v_user.status
    ),
    'org', jsonb_build_object(
      'id', v_org.id,
      'name', v_org.name
    ),
    'access_scope', jsonb_build_object(
      'scope_type', v_scope_type,
      'scope_id', v_identity_scope_id,
      'scope_label', v_scope_label
    ),
    'locale', COALESCE(v_org.locale, 'en-US'),
    'timezone', COALESCE(v_org.timezone, 'UTC'),
    'capabilities', COALESCE(v_caps, ARRAY[]::text[]),
    'settings_resolution_id', v_resolution_id,
    'invite_acceptance', COALESCE(v_acceptance, jsonb_build_object('accepted', false))
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_list_user_security_actions_v1(
  p_target_user_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_target_org UUID;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_rows JSONB := '[]'::jsonb;
  v_total BIGINT := 0;
BEGIN
  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_list_user_security_actions_v1 requires target user id'
      USING ERRCODE = '23502';
  END IF;

  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  SELECT u.organization_id
    INTO v_target_org
    FROM public.users u
   WHERE u.id = p_target_user_id;

  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'ui_list_user_security_actions_v1 user % not found', p_target_user_id
      USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('users.read', v_scope_type, v_scope_id);

  IF NOT public.is_platform_user()
     AND COALESCE(v_scope_id, public.current_user_org_id()) IS DISTINCT FROM v_target_org THEN
    RAISE EXCEPTION 'ui_list_user_security_actions_v1 target user % outside tenant scope', p_target_user_id
      USING ERRCODE = '42501';
  END IF;

  WITH decision_scope AS (
    SELECT dl.*
      FROM public.decision_log dl
     WHERE dl.organization_id = v_target_org
       AND dl.decision_point IN (
         'grant_user_role_v1',
         'revoke_user_role_v1',
         'revoke_session_v1',
         'suspend_user_v1',
         'reactivate_user_v1',
         'force_password_reset_v1',
         'tenant_user_invite_apply_v1',
         'tenant_user_invite_accept_v1'
       )
       AND (
         (dl.resource_type = 'user' AND dl.resource_id = p_target_user_id)
         OR dl.decision_inputs->>'target_user_id' = p_target_user_id::text
         OR dl.decision_inputs->>'user_id' = p_target_user_id::text
       )
  )
  SELECT COUNT(*) INTO v_total FROM decision_scope;

  WITH decision_scope AS (
    SELECT dl.*
      FROM public.decision_log dl
     WHERE dl.organization_id = v_target_org
       AND dl.decision_point IN (
         'grant_user_role_v1',
         'revoke_user_role_v1',
         'revoke_session_v1',
         'suspend_user_v1',
         'reactivate_user_v1',
         'force_password_reset_v1',
         'tenant_user_invite_apply_v1',
         'tenant_user_invite_accept_v1'
       )
       AND (
         (dl.resource_type = 'user' AND dl.resource_id = p_target_user_id)
         OR dl.decision_inputs->>'target_user_id' = p_target_user_id::text
         OR dl.decision_inputs->>'user_id' = p_target_user_id::text
       )
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.timestamp DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        dl.id,
        dl.organization_id,
        dl.timestamp,
        dl.decision_category,
        dl.decision_point,
        dl.decision_outcome,
        dl.decision_reason,
        dl.decision_inputs,
        dl.resource_type,
        dl.resource_id,
        dl.correlation_id,
        dl.settings_resolution_id,
        dl.performed_by_system,
        dl.decision_inputs->>'password_reset_intent_id' AS password_reset_intent_id,
        dl.decision_inputs->>'role_key' AS role_key,
        dl.decision_inputs->>'session_id' AS session_id,
        dl.decision_inputs->>'reason' AS action_reason,
        COALESCE(dl.decision_inputs->>'email', dl.decision_inputs->>'invite_email') AS invite_email,
        dl.decision_inputs->>'invite_email_sent' AS invite_email_sent,
        dl.decision_inputs->>'send_invite_email_requested' AS send_invite_email_requested,
        dl.decision_inputs->>'invite_redirect_to' AS invite_redirect_to,
        dl.decision_inputs->>'accepted_from_status' AS accepted_from_status,
        dl.decision_inputs->>'accepted_to_status' AS accepted_to_status
      FROM decision_scope dl
      ORDER BY dl.timestamp DESC
      LIMIT v_limit
    ) AS row_data;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'limit', v_limit,
    'offset', 0,
    'page', 0,
    'page_size', v_limit
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.tenant_user_invite_accept_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_user_invite_accept_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.tenant_user_invite_accept_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_me_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_me_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_me_v1() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.tenant_user_invite_accept_v1(
  p_user_id UUID DEFAULT NULL::uuid
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO api, public, pg_temp
AS $function$
  SELECT public.tenant_user_invite_accept_v1($1);
$function$;

CREATE OR REPLACE FUNCTION api.ui_list_user_security_actions_v1(
  p_target_user_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO api, public, pg_temp
AS $function$
  SELECT public.ui_list_user_security_actions_v1($1, $2);
$function$;

REVOKE ALL ON FUNCTION api.tenant_user_invite_accept_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.tenant_user_invite_accept_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.tenant_user_invite_accept_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

COMMENT ON FUNCTION public.tenant_user_invite_accept_v1(UUID)
  IS 'Accepts the current authenticated tenant invite exactly once, activating the user and writing Console/Mobile access readback evidence.';
COMMENT ON FUNCTION public.ui_me_v1()
  IS 'Console identity RPC. Activates invited tenant users on authenticated invite acceptance and returns backend access scope/capability readback.';
COMMENT ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER)
  IS 'Console V2 drawer security-action evidence for user lifecycle decisions, including tenant invite creation, resend, and acceptance.';

SELECT pg_advisory_unlock(hashtext('202606010145_tenant_invite_accept_access_readback_v1'));
COMMIT;
