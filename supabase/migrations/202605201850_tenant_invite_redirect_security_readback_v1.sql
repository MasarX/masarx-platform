-- Console V2 Users: persist and project tenant invite redirect intent so
-- hosted and no-hosted invite evidence can be read back from the drawer.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605201850_tenant_invite_redirect_security_readback_v1'));

CREATE OR REPLACE FUNCTION public.tenant_user_invite_apply_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_actor_user_id UUID := COALESCE(NULLIF(p_args->>'actor_user_id', '')::uuid, auth.uid());
  v_actor_org_id UUID;
  v_target_org_id UUID := NULLIF(p_args->>'organization_id', '')::uuid;
  v_email TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'email', '')), ''));
  v_full_name TEXT := NULLIF(btrim(COALESCE(p_args->>'full_name', '')), '');
  v_role_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'role_key', '')), ''));
  v_access_scope_type TEXT := lower(COALESCE(NULLIF(btrim(p_args->>'access_scope_type'), ''), 'tenant'));
  v_access_scope_id UUID := NULLIF(p_args->>'access_scope_id', '')::uuid;
  v_auth_user_id UUID := NULLIF(p_args->>'auth_user_id', '')::uuid;
  v_invite_email_sent BOOLEAN := COALESCE((p_args->>'invite_email_sent')::boolean, false);
  v_invite_email_requested BOOLEAN := COALESCE((p_args->>'send_invite_email_requested')::boolean, false);
  v_invite_redirect_to TEXT := NULLIF(btrim(COALESCE(p_args->>'invite_redirect_to', '')), '');
  v_preflight_only BOOLEAN := COALESCE((p_args->>'preflight_only')::boolean, false);
  v_existing_user_id UUID;
  v_existing_user_org_id UUID;
  v_target_user_id UUID;
  v_user_type TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'user_type', '')), ''));
  v_default_user_type TEXT;
  v_role_id UUID;
  v_assignment_id UUID;
  v_idempotent BOOLEAN := FALSE;
  v_status TEXT;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
BEGIN
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires actor_user_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT u.organization_id INTO v_actor_org_id
    FROM public.users u
   WHERE u.id = v_actor_user_id;

  IF v_actor_org_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 actor user % not found', v_actor_user_id
      USING ERRCODE = '23503';
  END IF;

  v_target_org_id := COALESCE(v_target_org_id, v_actor_org_id);

  IF NOT v_is_service THEN
    PERFORM public.assert_capability_v1('users.manage');
    IF v_actor_org_id IS NOT NULL
       AND v_target_org_id <> v_actor_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'tenant_user_invite_apply_v1 organization % outside tenant scope', v_target_org_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires organization_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires email'
      USING ERRCODE = '23502';
  END IF;

  IF v_role_key IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires role_key'
      USING ERRCODE = '23502';
  END IF;

  SELECT lv.value INTO v_default_user_type
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'user_type'
     AND lv.status = 'active'
   ORDER BY COALESCE(lv.is_default, FALSE) DESC, COALESCE(lv.sort_order, 0), lv.value
   LIMIT 1;

  IF v_user_type IS NULL THEN
    SELECT lv.value INTO v_user_type
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'user_type'
       AND lv.status = 'active'
       AND lv.value = v_role_key
     LIMIT 1;

    v_user_type := COALESCE(v_user_type, v_default_user_type);
  ELSIF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'user_type'
       AND lv.status = 'active'
       AND lv.value = v_user_type
  ) THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 unsupported user_type %', v_user_type
      USING ERRCODE = '23514';
  END IF;

  IF v_user_type IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 user_type lookup has no active default'
      USING ERRCODE = '23514';
  END IF;

  IF v_access_scope_type NOT IN ('platform', 'tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 unsupported access_scope_type %', v_access_scope_type
      USING ERRCODE = '23514';
  END IF;

  IF v_access_scope_type IN ('platform', 'tenant') THEN
    v_access_scope_id := NULL;
  ELSIF v_access_scope_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires access_scope_id for %', v_access_scope_type
      USING ERRCODE = '23502';
  END IF;

  SELECT u.id, u.organization_id
    INTO v_existing_user_id, v_existing_user_org_id
    FROM public.users u
   WHERE lower(u.email) = v_email
   LIMIT 1;

  IF v_existing_user_id IS NOT NULL AND v_existing_user_org_id IS DISTINCT FROM v_target_org_id THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 email % already belongs to another organization', v_email
      USING ERRCODE = '23505';
  END IF;

  IF v_existing_user_id IS NULL AND v_auth_user_id IS NOT NULL THEN
    SELECT u.id, u.organization_id
      INTO v_existing_user_id, v_existing_user_org_id
      FROM public.users u
     WHERE u.id = v_auth_user_id
     LIMIT 1;

    IF v_existing_user_id IS NOT NULL AND v_existing_user_org_id IS DISTINCT FROM v_target_org_id THEN
      RAISE EXCEPTION 'tenant_user_invite_apply_v1 auth user % already belongs to another organization', v_auth_user_id
        USING ERRCODE = '23505';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.rbac_roles r
     WHERE r.organization_id = v_target_org_id
       AND r.key = v_role_key
       AND r.is_active = TRUE
  ) AND NOT EXISTS (
    SELECT 1
      FROM public.rbac_role_templates t
     WHERE t.key = v_role_key
       AND t.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 role_key % not found or provisionable for org %', v_role_key, v_target_org_id
      USING ERRCODE = '23503';
  END IF;

  IF v_preflight_only THEN
    RETURN jsonb_build_object(
      'ok', true,
      'preflight_only', true,
      'organization_id', v_target_org_id,
      'role_key', v_role_key,
      'existing_user_id', v_existing_user_id
    );
  END IF;

  v_target_user_id := COALESCE(v_existing_user_id, v_auth_user_id);

  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires auth_user_id for a new user'
      USING ERRCODE = '23502';
  END IF;

  v_status := CASE WHEN v_invite_email_sent OR v_invite_email_requested THEN 'invited' ELSE 'active' END;
  v_full_name := COALESCE(v_full_name, v_email);

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  ) VALUES (
    v_target_user_id,
    v_target_org_id,
    v_email,
    v_full_name,
    v_user_type,
    v_status,
    v_access_scope_type,
    v_access_scope_id
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      full_name = COALESCE(NULLIF(public.users.full_name, ''), EXCLUDED.full_name)
  RETURNING id INTO v_target_user_id;

  PERFORM public.provision_rbac_roles_from_templates_v1(
    v_target_org_id,
    ARRAY[v_role_key],
    NULL
  );

  SELECT r.id INTO v_role_id
    FROM public.rbac_roles r
   WHERE r.organization_id = v_target_org_id
     AND r.key = v_role_key
   LIMIT 1;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 role_key % not found in org %', v_role_key, v_target_org_id
      USING ERRCODE = '23503';
  END IF;

  SELECT a.id INTO v_assignment_id
    FROM public.rbac_user_role_assignments a
   WHERE a.organization_id = v_target_org_id
     AND a.user_id = v_target_user_id
     AND a.role_id = v_role_id
     AND a.revoked_at IS NULL
   LIMIT 1;

  IF v_assignment_id IS NULL THEN
    INSERT INTO public.rbac_user_role_assignments (
      organization_id,
      user_id,
      role_id,
      assigned_by_user_id,
      metadata
    ) VALUES (
      v_target_org_id,
      v_target_user_id,
      v_role_id,
      v_actor_user_id,
      jsonb_strip_nulls(jsonb_build_object(
        'source', 'tenant_user_invite_apply_v1',
        'invite_email_sent', v_invite_email_sent,
        'send_invite_email_requested', v_invite_email_requested,
        'invite_redirect_to', v_invite_redirect_to
      ))
    )
    RETURNING id INTO v_assignment_id;
  ELSE
    v_idempotent := TRUE;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system,
    correlation_id, settings_resolution_id
  ) VALUES (
    v_decision_id, v_target_org_id,
    'users.invite', 'user', v_target_user_id,
    'tenant_user_invite_apply_v1',
    CASE WHEN v_idempotent THEN 'idempotent_existing_assignment' ELSE 'invited' END,
    jsonb_strip_nulls(jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'email', v_email,
      'role_key', v_role_key,
      'user_type', v_user_type,
      'access_scope_type', v_access_scope_type,
      'access_scope_id', v_access_scope_id,
      'invite_email_sent', v_invite_email_sent,
      'send_invite_email_requested', v_invite_email_requested,
      'idempotent_no_op', v_idempotent
    )) || jsonb_build_object('invite_redirect_to', v_invite_redirect_to),
    'tenant_user_invite_apply_v1', v_correlation_id, v_decision_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload,
    correlation_id, status
  ) VALUES (
    v_target_org_id, 'user.invited', 'user', v_target_user_id,
    jsonb_strip_nulls(jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'email', v_email,
      'role_key', v_role_key,
      'user_type', v_user_type,
      'invite_email_sent', v_invite_email_sent,
      'send_invite_email_requested', v_invite_email_requested,
      'idempotent_no_op', v_idempotent
    )) || jsonb_build_object('invite_redirect_to', v_invite_redirect_to),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'user_id', v_target_user_id,
    'organization_id', v_target_org_id,
    'email', v_email,
    'full_name', v_full_name,
    'user_type', v_user_type,
    'role_key', v_role_key,
    'status', v_status,
    'access_scope_type', v_access_scope_type,
    'access_scope_id', v_access_scope_id,
    'rbac_user_role_assignment_id', v_assignment_id,
    'invite_email_sent', v_invite_email_sent,
    'invite_redirect_to', v_invite_redirect_to,
    'idempotent_no_op', v_idempotent,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
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
         'tenant_user_invite_apply_v1'
       )
       AND (
         (dl.resource_type = 'user' AND dl.resource_id = p_target_user_id)
         OR dl.decision_inputs->>'target_user_id' = p_target_user_id::text
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
         'tenant_user_invite_apply_v1'
       )
       AND (
         (dl.resource_type = 'user' AND dl.resource_id = p_target_user_id)
         OR dl.decision_inputs->>'target_user_id' = p_target_user_id::text
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
        dl.decision_inputs->>'email' AS invite_email,
        dl.decision_inputs->>'invite_email_sent' AS invite_email_sent,
        dl.decision_inputs->>'send_invite_email_requested' AS send_invite_email_requested,
        dl.decision_inputs->>'invite_redirect_to' AS invite_redirect_to
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

REVOKE ALL ON FUNCTION public.tenant_user_invite_apply_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_user_invite_apply_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.tenant_user_invite_apply_v1(JSONB) FROM authenticated;
REVOKE ALL ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.tenant_user_invite_apply_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

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

REVOKE ALL ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

COMMENT ON FUNCTION public.tenant_user_invite_apply_v1(JSONB)
  IS 'Console V2 tenant user invite apply contract. Persists invite email, role, and hosted/no-hosted redirect evidence in decision_log for drawer readback.';
COMMENT ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER)
  IS 'Console V2 drawer security-action evidence for user lifecycle decisions, including tenant invite email and redirect intent.';

SELECT pg_advisory_unlock(hashtext('202605201850_tenant_invite_redirect_security_readback_v1'));
COMMIT;
