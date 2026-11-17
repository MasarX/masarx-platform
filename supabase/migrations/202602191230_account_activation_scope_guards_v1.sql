-- Migration: account activation guards for scope/capability resolution
-- Purpose:
--   - Fail closed when authenticated users are suspended or belong to suspended organizations.
--   - Ensure scope helpers and access policy resolver do not grant capabilities for inactive accounts.
BEGIN;
SELECT pg_advisory_lock(hashtext('202602191230_account_activation_scope_guards_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.current_user_org_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
  WITH claims AS (
    SELECT
      auth.uid() AS uid,
      NULLIF(auth.jwt() ->> 'sub', '')::uuid AS sub
  ),
  org_from_uid AS (
    SELECT u.organization_id AS org
    FROM public.users u
    LEFT JOIN public.organizations o ON o.id = u.organization_id
    JOIN claims c ON c.uid IS NOT NULL AND u.id = c.uid
    WHERE lower(COALESCE(u.status, '')) = 'active'
      AND lower(COALESCE(o.billing_status, 'active')) <> 'suspended'
    LIMIT 1
  ),
  org_from_sub AS (
    SELECT u.organization_id AS org
    FROM public.users u
    LEFT JOIN public.organizations o ON o.id = u.organization_id
    JOIN claims c ON c.sub IS NOT NULL AND u.id = c.sub
    WHERE lower(COALESCE(u.status, '')) = 'active'
      AND lower(COALESCE(o.billing_status, 'active')) <> 'suspended'
    LIMIT 1
  )
  SELECT COALESCE(
    (SELECT org FROM org_from_uid),
    (SELECT org FROM org_from_sub)
  );
$function$;

COMMENT ON FUNCTION public.current_user_org_id() IS
  'Returns the organization_id only for active authenticated users in non-suspended organizations.';

CREATE OR REPLACE FUNCTION public.current_user_scope_type()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_scope TEXT;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF public.current_user_org_id() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.access_scope_type
    INTO v_scope
    FROM public.users u
   WHERE u.id = v_user_id;

  RETURN v_scope;
END;
$$;

COMMENT ON FUNCTION public.current_user_scope_type()
  IS 'Returns user access_scope_type for active users only; inactive/suspended accounts resolve NULL.';

CREATE OR REPLACE FUNCTION public.current_user_scope_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_org_id UUID;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_org_id := public.current_user_org_id();
  IF v_org_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.access_scope_type, u.access_scope_id, u.organization_id
    INTO v_scope_type, v_scope_id, v_org_id
    FROM public.users u
   WHERE u.id = v_user_id;

  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    RETURN v_org_id;
  END IF;

  RETURN v_scope_id;
END;
$$;

COMMENT ON FUNCTION public.current_user_scope_id()
  IS 'Returns user access_scope_id for active users; tenant scope falls back to organization_id when scope_id is NULL.';

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
AS $$
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
$$;

COMMENT ON FUNCTION public.resolve_access_control_policy_v1(TEXT, UUID, BOOLEAN)
  IS 'Resolves access control policy through the scope ladder; returns no policy for inactive users or suspended organizations.';

SELECT pg_advisory_unlock(hashtext('202602191230_account_activation_scope_guards_v1'));
COMMIT;
