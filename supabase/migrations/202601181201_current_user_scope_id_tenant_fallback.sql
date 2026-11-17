-- Migration: Derive tenant scope id from organization_id when access_scope_id is NULL
BEGIN;
SELECT pg_advisory_lock(hashtext('202601181201_current_user_scope_id_tenant_fallback'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  IS 'Returns current authenticated user access_scope_id; for tenant-scoped users falls back to organization_id when access_scope_id is NULL (SSOT: tenant scope id = organization id).';

REVOKE EXECUTE ON FUNCTION public.current_user_scope_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_scope_id() TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601181201_current_user_scope_id_tenant_fallback'));
COMMIT;

