-- Migration: Console V2 access-policy resolver scope guard
-- Purpose:
--   - Keep tenant-scoped Users/Access operators pinned to their own tenant
--     when resolving access policy through browser-facing API wrappers.
--   - Preserve platform operators' intentional cross-tenant policy reach.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605271610_console_v2_access_policy_scope_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.access_policy_scope_is_visible_to_current_user_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_auth_user_id UUID := auth.uid();
  v_requested_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), 'global'));
  v_requested_scope_id UUID := p_scope_id;
  v_caller_scope_type TEXT;
  v_caller_scope_id UUID;
  v_caller_org_id UUID;
  v_target_org_id UUID;
  v_target_client_id UUID;
BEGIN
  -- Service-role and internal contexts have no end-user JWT and keep their
  -- existing resolver reach. Authenticated browser/API callers are checked.
  IF v_auth_user_id IS NULL THEN
    RETURN TRUE;
  END IF;

  IF v_requested_scope_type = 'platform' THEN
    v_requested_scope_type := 'global';
    v_requested_scope_id := NULL;
  ELSIF v_requested_scope_type = 'organization' THEN
    v_requested_scope_type := 'tenant';
  END IF;

  v_caller_scope_type := public.current_user_scope_type();
  v_caller_scope_id := public.current_user_scope_id();
  v_caller_org_id := public.current_user_org_id();

  IF v_caller_scope_type IS NULL OR v_caller_org_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_caller_scope_type = 'platform' THEN
    RETURN TRUE;
  END IF;

  IF v_requested_scope_type = 'global' THEN
    RETURN FALSE;
  END IF;

  IF v_requested_scope_type = 'tenant' THEN
    RETURN v_requested_scope_id IS NOT DISTINCT FROM v_caller_org_id;
  END IF;

  IF v_requested_scope_type = 'client' THEN
    SELECT c.organization_id
      INTO v_target_org_id
      FROM public.clients c
     WHERE c.id = v_requested_scope_id;

    IF v_target_org_id IS DISTINCT FROM v_caller_org_id THEN
      RETURN FALSE;
    END IF;

    IF v_caller_scope_type = 'tenant' THEN
      RETURN TRUE;
    END IF;

    IF v_caller_scope_type = 'client' THEN
      RETURN v_requested_scope_id IS NOT DISTINCT FROM v_caller_scope_id;
    END IF;

    RETURN FALSE;
  END IF;

  IF v_requested_scope_type = 'sender' THEN
    SELECT c.organization_id, s.client_id
      INTO v_target_org_id, v_target_client_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_requested_scope_id;

    IF v_target_org_id IS DISTINCT FROM v_caller_org_id THEN
      RETURN FALSE;
    END IF;

    IF v_caller_scope_type = 'tenant' THEN
      RETURN TRUE;
    END IF;

    IF v_caller_scope_type = 'client' THEN
      RETURN v_target_client_id IS NOT DISTINCT FROM v_caller_scope_id;
    END IF;

    IF v_caller_scope_type = 'sender' THEN
      RETURN v_requested_scope_id IS NOT DISTINCT FROM v_caller_scope_id;
    END IF;

    RETURN FALSE;
  END IF;

  IF v_requested_scope_type = 'source' THEN
    SELECT ws.organization_id
      INTO v_target_org_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_requested_scope_id;

    IF v_target_org_id IS DISTINCT FROM v_caller_org_id THEN
      RETURN FALSE;
    END IF;

    RETURN v_caller_scope_type = 'tenant'
      OR (
        v_caller_scope_type = 'source'
        AND v_requested_scope_id IS NOT DISTINCT FROM v_caller_scope_id
      );
  END IF;

  RETURN FALSE;
END;
$function$;

REVOKE ALL ON FUNCTION public.access_policy_scope_is_visible_to_current_user_v1(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.access_policy_scope_is_visible_to_current_user_v1(TEXT, UUID) TO authenticated, service_role;
COMMENT ON FUNCTION public.access_policy_scope_is_visible_to_current_user_v1(TEXT, UUID) IS
  'Returns true when the authenticated caller may resolve access_control_policy for the requested scope. Tenant/client/sender/source users are pinned to their own organization/scope; platform users keep cross-tenant reach.';

CREATE OR REPLACE FUNCTION public.resolve_access_control_policy_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL,
  p_log BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  policy JSONB,
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  scope_path JSONB,
  settings_resolution_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), public.current_user_scope_type(), 'global'));
  v_scope_id UUID := COALESCE(p_scope_id, public.current_user_scope_id());
  v_row RECORD;
  v_policy JSONB;
  v_org_id UUID;
  v_resolution_id UUID := NULL;
  v_auth_user_id UUID := auth.uid();
  v_user_status TEXT;
  v_org_billing_status TEXT;
BEGIN
  IF v_scope_type = 'platform' THEN
    v_scope_type := 'global';
    v_scope_id := NULL;
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_auth_user_id IS NOT NULL THEN
    SELECT u.status, o.billing_status
      INTO v_user_status, v_org_billing_status
      FROM public.users u
      LEFT JOIN public.organizations o ON o.id = u.organization_id
     WHERE u.id = v_auth_user_id
     LIMIT 1;

    IF v_user_status IS NULL OR lower(COALESCE(v_user_status, '')) <> 'active' THEN
      RETURN;
    END IF;

    IF lower(COALESCE(v_org_billing_status, 'active')) = 'suspended' THEN
      RETURN;
    END IF;

    IF NOT public.access_policy_scope_is_visible_to_current_user_v1(v_scope_type, v_scope_id) THEN
      RETURN;
    END IF;
  END IF;

  SELECT *
    INTO v_row
    FROM public.resolve_settings_row('access_control_policy', v_scope_type, v_scope_id)
    LIMIT 1;

  IF v_row.settings_id IS NULL THEN
    RETURN;
  END IF;

  v_policy := public.resolve_settings_merged('access_control_policy', v_scope_type, v_scope_id);

  IF p_log THEN
    IF v_scope_type = 'tenant' THEN
      v_org_id := v_scope_id;
    ELSIF v_scope_type = 'client' THEN
      SELECT organization_id INTO v_org_id FROM public.clients WHERE id = v_scope_id;
    ELSIF v_scope_type = 'sender' THEN
      SELECT c.organization_id
        INTO v_org_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_scope_id;
    ELSE
      v_org_id := public.current_user_org_id();
    END IF;

    IF v_org_id IS NOT NULL THEN
      v_resolution_id := public.log_settings_resolution(
        p_organization_id := v_org_id,
        p_category := 'access_control_policy',
        p_winning_scope_type := v_row.scope_type,
        p_winning_scope_id := v_row.scope_id,
        p_winning_settings_id := v_row.settings_id,
        p_winning_settings_version_id := v_row.settings_version_id,
        p_winning_version := v_row.version,
        p_scope_path := v_row.scope_path,
        p_inputs := jsonb_build_object(
          'requested_scope_type', v_scope_type,
          'requested_scope_id', v_scope_id
        ),
        p_merge_notes := jsonb_build_object('merged', true)
      );
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_policy,
    v_row.settings_id,
    v_row.settings_version_id,
    v_row.scope_type,
    v_row.scope_id,
    v_row.scope_path,
    v_resolution_id;
END;
$function$;

COMMENT ON FUNCTION public.resolve_access_control_policy_v1(TEXT, UUID, BOOLEAN) IS
  'Resolves the effective access_control_policy settings row for the requested scope while failing closed for inactive accounts and cross-tenant browser/API scope overrides.';

SELECT pg_advisory_unlock(hashtext('202605271610_console_v2_access_policy_scope_guard_v1'));
COMMIT;
