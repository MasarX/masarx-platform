-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Fix provision_rbac_roles_from_templates_v1 ambiguity (role_id output vs ON CONFLICT)
-- Date: 2026-01-30
--
-- Why:
--   - The function RETURNS TABLE(role_id ...) which creates an output variable named role_id.
--   - Using ON CONFLICT (role_id, permission_id) inside the function can become ambiguous.
--   - Fix by targeting the unique constraint explicitly and avoiding ambiguous identifiers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300070_rbac_role_templates_provision_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.provision_rbac_roles_from_templates_v1(
  p_organization_id UUID,
  p_template_keys TEXT[] DEFAULT NULL,
  p_granted_by_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  template_key TEXT,
  role_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'provision_rbac_roles_from_templates_v1: organization_id is required' USING ERRCODE = '23502';
  END IF;

  RETURN QUERY
  WITH templates AS (
    SELECT t.id, t.key, t.name, t.description
    FROM public.rbac_role_templates t
    WHERE t.is_active IS TRUE
      AND (p_template_keys IS NULL OR t.key = ANY(p_template_keys))
  ),
  upserted_roles AS (
    INSERT INTO public.rbac_roles (organization_id, key, name, description, metadata)
    SELECT
      p_organization_id,
      t.key,
      t.name,
      t.description,
      jsonb_build_object('provisioned_from_template', TRUE, 'template_key', t.key)
    FROM templates t
    ON CONFLICT (organization_id, key) DO UPDATE
    SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      metadata = public.rbac_roles.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING public.rbac_roles.id AS created_role_id, public.rbac_roles.key AS role_key, (xmax = 0) AS created
  ),
  seeded_perms AS (
    INSERT INTO public.rbac_role_permissions (
      organization_id,
      role_id,
      permission_id,
      granted_by_user_id,
      metadata
    )
    SELECT
      p_organization_id,
      r.created_role_id,
      tp.permission_id,
      p_granted_by_user_id,
      jsonb_build_object('source', 'template', 'template_key', r.role_key)
    FROM upserted_roles r
    JOIN public.rbac_role_templates t ON t.key = r.role_key
    JOIN public.rbac_role_template_permissions tp ON tp.role_template_id = t.id
    ON CONFLICT ON CONSTRAINT rbac_role_permissions_unique DO NOTHING
    RETURNING 1
  )
  SELECT r.role_key, r.created_role_id, r.created
  FROM upserted_roles r;
END;
$function$;

REVOKE ALL ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) FROM anon;
REVOKE ALL ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601300070_rbac_role_templates_provision_fix_v1'));
COMMIT;

