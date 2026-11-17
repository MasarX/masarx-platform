BEGIN;
SET LOCAL lock_timeout = '10s';

INSERT INTO public.rbac_role_template_permissions(role_template_id, permission_id, metadata)
SELECT rt.id, lv.id, '{"seed":true,"source":"super_admin_active_permission_resync_v1"}'::jsonb
FROM public.rbac_role_templates rt
JOIN public.lookup_definitions ld ON ld.category = 'rbac_permission'
JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
WHERE rt.key = 'super_admin'
  AND lv.status = 'active'
ON CONFLICT(role_template_id, permission_id) DO NOTHING;

COMMIT;
