-- Console V2 Access Control RBAC registry repair.
--
-- Access Control must read roles, assignments, permissions, and templates
-- through operator-facing projections registered in ui_read_registry. The live
-- Console was rendering unknown-resource errors for the RBAC tabs because the
-- seed registry entries had not been mirrored into backend settings.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605081830_console_v2_access_rbac_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_rbac_role_permission_directory
WITH (security_invoker = true) AS
SELECT
  rp.id,
  rp.organization_id,
  rp.role_id,
  r.key AS role_key,
  r.name AS role_name,
  rp.permission_id,
  lv.value AS permission_value,
  lv.label AS permission_label,
  rp.granted_by_user_id,
  granted_by.email AS granted_by_email,
  rp.granted_at,
  rp.metadata,
  rp.created_at,
  rp.updated_at
FROM public.rbac_role_permissions rp
LEFT JOIN public.rbac_roles r ON r.id = rp.role_id
LEFT JOIN public.lookup_values lv ON lv.id = rp.permission_id
LEFT JOIN public.users granted_by ON granted_by.id = rp.granted_by_user_id;

CREATE OR REPLACE VIEW public.v_rbac_user_role_assignment_directory
WITH (security_invoker = true) AS
SELECT
  a.id,
  a.organization_id,
  a.user_id,
  u.email AS user_email,
  u.full_name AS user_full_name,
  a.role_id,
  r.key AS role_key,
  r.name AS role_name,
  a.assigned_by_user_id,
  assigned_by.email AS assigned_by_email,
  a.assigned_at,
  a.revoked_by_user_id,
  revoked_by.email AS revoked_by_email,
  a.revoked_at,
  a.metadata,
  a.created_at,
  a.updated_at
FROM public.rbac_user_role_assignments a
LEFT JOIN public.users u ON u.id = a.user_id
LEFT JOIN public.rbac_roles r ON r.id = a.role_id
LEFT JOIN public.users assigned_by ON assigned_by.id = a.assigned_by_user_id
LEFT JOIN public.users revoked_by ON revoked_by.id = a.revoked_by_user_id;

CREATE OR REPLACE VIEW public.v_rbac_role_template_directory
WITH (security_invoker = true) AS
SELECT
  t.id,
  t.key,
  t.name,
  t.description,
  t.is_active,
  t.metadata,
  COALESCE(perms.permission_count, 0)::integer AS permission_count,
  COALESCE(perms.permission_values, ARRAY[]::text[]) AS permission_values,
  t.created_at,
  t.updated_at
FROM public.rbac_role_templates t
LEFT JOIN LATERAL (
  SELECT
    count(*)::integer AS permission_count,
    array_agg(lv.value ORDER BY lv.value) FILTER (WHERE lv.value IS NOT NULL) AS permission_values
  FROM public.rbac_role_template_permissions tp
  LEFT JOIN public.lookup_values lv ON lv.id = tp.permission_id
  WHERE tp.role_template_id = t.id
) perms ON TRUE;

COMMENT ON VIEW public.v_rbac_role_permission_directory IS
  'Console V2 Access Control projection for role permissions. Sources: rbac_role_permissions + rbac_roles + lookup_values + users. Read-only; writes go through RBAC RPCs.';
COMMENT ON VIEW public.v_rbac_user_role_assignment_directory IS
  'Console V2 Access Control projection for user role assignments. Sources: rbac_user_role_assignments + users + rbac_roles. Read-only; writes go through RBAC RPCs.';
COMMENT ON VIEW public.v_rbac_role_template_directory IS
  'Console V2 Access Control projection for role templates with permission counts and values. Sources: rbac_role_templates + rbac_role_template_permissions + lookup_values. Read-only; provisioning goes through provision_rbac_roles_from_templates_v1.';

REVOKE ALL ON public.v_rbac_role_permission_directory FROM PUBLIC;
REVOKE ALL ON public.v_rbac_role_permission_directory FROM anon;
REVOKE ALL ON public.v_rbac_user_role_assignment_directory FROM PUBLIC;
REVOKE ALL ON public.v_rbac_user_role_assignment_directory FROM anon;
REVOKE ALL ON public.v_rbac_role_template_directory FROM PUBLIC;
REVOKE ALL ON public.v_rbac_role_template_directory FROM anon;
GRANT SELECT ON public.v_rbac_role_permission_directory TO authenticated, service_role;
GRANT SELECT ON public.v_rbac_user_role_assignment_directory TO authenticated, service_role;
GRANT SELECT ON public.v_rbac_role_template_directory TO authenticated, service_role;

DO $read_registry$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_existing_resources JSONB;
  v_filtered JSONB;
  v_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'rbac_roles',
      'relation', 'public.v_rbac_role_summary',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'access_policy.read',
      'capability_write', 'access_policy.approve',
      'allow_view_relation', true,
      'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'key', 'column', 'key', 'op', 'ilike'),
        jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq')
      ),
      'columns', jsonb_build_array(
        jsonb_build_object('key', 'key', 'label', 'Key', 'mono', true, 'sortable', true, 'filterable', true),
        jsonb_build_object('key', 'name', 'label', 'Name', 'sortable', true, 'filterable', true),
        jsonb_build_object('key', 'description', 'label', 'Description'),
        jsonb_build_object('key', 'permission_count', 'label', 'Permissions', 'align', 'right', 'sortable', true),
        jsonb_build_object('key', 'assignment_count', 'label', 'Assignees', 'align', 'right', 'sortable', true),
        jsonb_build_object('key', 'is_active', 'label', 'Active', 'sortable', true, 'filterable', true),
        jsonb_build_object('key', 'updated_at', 'label', 'Updated', 'format', 'datetime', 'sortable', true)
      )
    ),
    jsonb_build_object(
      'key', 'rbac_role_summary',
      'relation', 'public.v_rbac_role_summary',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'access_policy.read',
      'allow_view_relation', true,
      'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'key', 'column', 'key', 'op', 'ilike')
      )
    ),
    jsonb_build_object(
      'key', 'rbac_role_permissions',
      'relation', 'public.v_rbac_role_permission_directory',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'access_policy.read',
      'capability_write', 'access_policy.approve',
      'allow_view_relation', true,
      'default_sort', jsonb_build_object('column', 'granted_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'role_id', 'column', 'role_id', 'op', 'eq'),
        jsonb_build_object('key', 'permission_value', 'column', 'permission_value', 'op', 'ilike')
      )
    ),
    jsonb_build_object(
      'key', 'rbac_user_role_assignments',
      'relation', 'public.v_rbac_user_role_assignment_directory',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'access_policy.read',
      'capability_write', 'access_policy.approve',
      'allow_view_relation', true,
      'default_sort', jsonb_build_object('column', 'assigned_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'user_id', 'column', 'user_id', 'op', 'eq'),
        jsonb_build_object('key', 'role_id', 'column', 'role_id', 'op', 'eq'),
        jsonb_build_object('key', 'role_key', 'column', 'role_key', 'op', 'ilike')
      )
    ),
    jsonb_build_object(
      'key', 'rbac_role_templates',
      'relation', 'public.v_rbac_role_template_directory',
      'id_column', 'id',
      'capability_read', 'access_policy.read',
      'capability_write', 'access_policy.approve',
      'allow_view_relation', true,
      'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'key', 'column', 'key', 'op', 'ilike'),
        jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq')
      )
    )
  );
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_existing_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_existing_resources) IS DISTINCT FROM 'array' THEN
      v_existing_resources := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(resource), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(v_existing_resources) AS resource
     WHERE NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_resources) AS desired
       WHERE desired->>'key' = resource->>'key'
     );

    v_current := jsonb_set(v_current, '{resources}', v_filtered || v_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Expose Console V2 Access Control RBAC registry resources',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$read_registry$;

SELECT pg_advisory_unlock(hashtext('202605081830_console_v2_access_rbac_registry_v1'));

COMMIT;
