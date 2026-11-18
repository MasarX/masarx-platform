BEGIN;
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
  v_invited_at TIMESTAMPTZ;
  v_checked_at TIMESTAMPTZ;
  v_acceptance_ttl CONSTANT INTERVAL := interval '24 hours';
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

  SELECT u.invited_at INTO v_invited_at
    FROM auth.users u
   WHERE u.id = v_user.id;

  v_checked_at := clock_timestamp();
  IF v_invited_at IS NULL
     OR v_invited_at > v_checked_at
     OR v_invited_at + v_acceptance_ttl <= v_checked_at THEN
    RAISE EXCEPTION 'tenant_user_invite:expired'
      USING ERRCODE = 'PT410';
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

COMMIT;
