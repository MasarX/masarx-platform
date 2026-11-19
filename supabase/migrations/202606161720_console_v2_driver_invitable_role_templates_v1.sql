-- Console V2 tenant invite driver-role admission.
-- Tenant user invite already provisions active RBAC templates on submit. Keep the
-- visible role picker aligned with that backend contract so driver-capable mobile
-- actors can be admitted through product UI without a prior manual template apply.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606161720_console_v2_driver_invitable_role_templates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $ops_admin_user_management$
BEGIN
  WITH permission_registry AS (
    SELECT lv.id, lv.value
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value IN ('users.read', 'users.manage')
  )
  INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
  SELECT
    t.id,
    p.id,
    jsonb_build_object(
      'seed', TRUE,
      'template_key', t.key,
      'source', 'console_v2_driver_invitable_role_templates_v1'
    )
  FROM public.rbac_role_templates t
  JOIN permission_registry p ON TRUE
  WHERE t.key = 'ops_admin'
  ON CONFLICT (role_template_id, permission_id) DO UPDATE
     SET metadata = COALESCE(public.rbac_role_template_permissions.metadata, '{}'::jsonb)
                  || EXCLUDED.metadata,
         updated_at = now();

  WITH permission_registry AS (
    SELECT lv.id, lv.value
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value IN ('users.read', 'users.manage')
  )
  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  SELECT
    r.organization_id,
    r.id,
    p.id,
    jsonb_build_object('source', 'console_v2_driver_invitable_role_templates_v1')
  FROM public.rbac_roles r
  JOIN permission_registry p ON TRUE
  WHERE r.key = 'ops_admin'
    AND COALESCE(r.is_active, TRUE) IS TRUE
  ON CONFLICT ON CONSTRAINT rbac_role_permissions_unique DO UPDATE
     SET metadata = COALESCE(public.rbac_role_permissions.metadata, '{}'::jsonb)
                  || EXCLUDED.metadata,
         updated_at = now();
END;
$ops_admin_user_management$;

CREATE OR REPLACE FUNCTION public.ui_list_tenant_invitable_roles_v1(
  p_organization_id UUID DEFAULT NULL::uuid
)
RETURNS TABLE (
  role_id UUID,
  organization_id UUID,
  role_key TEXT,
  name TEXT,
  description TEXT,
  is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_assert JSONB;
  v_org_id UUID;
BEGIN
  v_assert := public.tenant_user_invite_assert_operator_v1(p_organization_id);
  v_org_id := NULLIF(v_assert->>'organization_id', '')::uuid;

  RETURN QUERY
  WITH tenant_roles AS (
    SELECT
      r.id AS role_id,
      r.organization_id,
      r.key AS role_key,
      r.name,
      r.description,
      r.is_active,
      0 AS sort_bucket
    FROM public.rbac_roles r
    WHERE r.organization_id = v_org_id
      AND COALESCE(r.is_active, TRUE) IS TRUE
  ),
  template_roles AS (
    SELECT
      t.id AS role_id,
      v_org_id AS organization_id,
      t.key AS role_key,
      t.name,
      t.description,
      t.is_active,
      1 AS sort_bucket
    FROM public.rbac_role_templates t
    WHERE t.is_active IS TRUE
      AND NOT EXISTS (
        SELECT 1
          FROM public.rbac_roles r
         WHERE r.organization_id = v_org_id
           AND r.key = t.key
           AND COALESCE(r.is_active, TRUE) IS TRUE
      )
  )
  SELECT
    roles.role_id,
    roles.organization_id,
    roles.role_key,
    roles.name,
    roles.description,
    roles.is_active
  FROM (
    SELECT * FROM tenant_roles
    UNION ALL
    SELECT * FROM template_roles
  ) roles
  ORDER BY roles.sort_bucket, roles.role_key;
END;
$function$;

COMMENT ON FUNCTION public.ui_list_tenant_invitable_roles_v1(UUID)
  IS 'Browser-safe tenant invite role catalog. Lists active tenant roles plus active templates that tenant_user_invite_apply_v1 can provision on submit.';

REVOKE ALL ON FUNCTION public.ui_list_tenant_invitable_roles_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_tenant_invitable_roles_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_list_tenant_invitable_roles_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606161720_console_v2_driver_invitable_role_templates_v1'));

COMMIT;
