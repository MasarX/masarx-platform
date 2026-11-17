-- Migration: Keep policy scope separate from frontend identity scope.
BEGIN;

SELECT pg_advisory_lock(hashtext('202608161610_b3_command_scope_identity_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_me_v1 requires authenticated user';
  END IF;

  SELECT * INTO v_user
    FROM public.users
   WHERE id = v_user_id;
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'ui_me_v1 requires a Console user profile';
  END IF;
  IF lower(COALESCE(v_user.status, '')) <> 'active' THEN
    RAISE EXCEPTION 'ui_me_v1 requires an active Console user profile';
  END IF;

  SELECT * INTO v_org
    FROM public.organizations
   WHERE id = v_user.organization_id;
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
    SELECT name INTO v_scope_label
      FROM public.clients
     WHERE id = v_identity_scope_id;
  ELSIF v_scope_type = 'sender' THEN
    SELECT name INTO v_scope_label
      FROM public.senders
     WHERE id = v_identity_scope_id;
  ELSE
    v_scope_label := NULL;
  END IF;

  RETURN jsonb_build_object(
    'user', jsonb_build_object(
      'id', v_user.id,
      'email', v_user.email,
      'name', v_user.full_name,
      'user_type', v_user.user_type
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
    'settings_resolution_id', v_resolution_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_me_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_me_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_me_v1() TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_me_v1()
  IS 'Console identity RPC. Hydration fails closed for non-active users; policy resolution uses the effective policy scope id, while the frontend identity scope id mirrors users.access_scope_id and remains null for platform and tenant identities.';

SELECT pg_advisory_unlock(hashtext('202608161610_b3_command_scope_identity_guard_v1'));

COMMIT;
