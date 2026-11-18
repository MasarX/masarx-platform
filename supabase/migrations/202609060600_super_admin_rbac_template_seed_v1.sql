-- F726 preserved source: bdc5d78150a97265e64f9c7461dc5ea15fdc250f
-- Restores 202606301700_super_admin_rbac_template_seed_v1 without rewriting history.
-- Templates and permission links only: no user assignments, role grants, or policy changes.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202609060600_super_admin_rbac_template_seed_v1'));

-- Existing explicit template state (including an inactive override) is authoritative.
WITH inserted_template AS (
INSERT INTO public.rbac_role_templates (key, name, description, is_active, metadata)
VALUES (
  'super_admin',
  'Super Admin',
  'Platform-wide administrative access for breakglass/operator bootstrap.',
  TRUE,
  jsonb_build_object('seed', TRUE, 'tier', 'admin', 'scope', 'platform')
)
ON CONFLICT (key) DO NOTHING
RETURNING id
)
INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
SELECT t.id, lv.id,
  jsonb_build_object('seed', TRUE, 'template_key', 'super_admin',
    'source', 'active_rbac_permission_registry')
FROM inserted_template t
CROSS JOIN public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'rbac_permission'
  AND lv.status = 'active'
ON CONFLICT (role_template_id, permission_id) DO NOTHING;

COMMIT;
