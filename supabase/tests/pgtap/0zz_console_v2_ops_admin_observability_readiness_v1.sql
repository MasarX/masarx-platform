BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, pgtap, extensions, pg_temp;

SELECT plan(9);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value = 'observability.read'
       AND lv.status = 'active'
  ),
  'rbac_permission lookup registry includes observability.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_role_templates t
      JOIN public.rbac_role_template_permissions tp ON tp.role_template_id = t.id
      JOIN public.lookup_values lv ON lv.id = tp.permission_id
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE t.key = 'ops_admin'
       AND ld.category = 'rbac_permission'
       AND lv.value = 'observability.read'
  ),
  'ops_admin role template grants observability.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions sv,
           jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role(value)
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND sv.approved_at IS NOT NULL
       AND sv.effective_until IS NULL
       AND role.value->>'key' = 'ops_admin'
       AND COALESCE(role.value->'capability_keys', '[]'::jsonb) @> to_jsonb('observability.read'::text)
  ),
  'active access_control_policy grants ops_admin observability.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
             COALESCE(
               public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}',
               '[]'::jsonb
             )
           ) AS section(section)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.section->'items', '[]'::jsonb)) AS item(item)
     WHERE COALESCE(item.item->>'route', item.item->>'href') = '/insights/decisions'
       AND item.item->>'capability' = 'observability.read'
  ),
  'Decision Log navigation is gated by observability.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
             COALESCE(
               public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}',
               '[]'::jsonb
             )
           ) AS section(section)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.section->'items', '[]'::jsonb)) AS item(item)
     WHERE COALESCE(item.item->>'route', item.item->>'href') = '/insights/audit'
       AND item.item->>'capability' = 'audit_log.read'
  ),
  'Audit Log navigation remains gated by audit_log.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.ui_read_registry_v1()->'resources', '[]'::jsonb)) AS resource(entry)
     WHERE resource.entry->>'key' = 'decision_log'
       AND resource.entry->>'capability_read' = 'observability.read'
  ),
  'Decision Log registry read uses observability.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.ui_read_registry_v1()->'resources', '[]'::jsonb)) AS resource(entry)
     WHERE resource.entry->>'key' = 'decision_log_directory'
       AND resource.entry->>'relation' = 'public.v_decision_log_directory'
       AND resource.entry->>'capability_read' = 'observability.read'
  ),
  'Decision Log directory registry exposes v_decision_log_directory via observability.read'
);

DO $$
DECLARE
  v_org UUID := '11e390a1-90e8-4b2f-8cdd-0101f0b50b01'::uuid;
  v_user UUID := '11e390a1-90e8-4b2f-8cdd-0101f0b50b02'::uuid;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Observability RBAC Org', 'observability-rbac-org')
  ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      slug = EXCLUDED.slug;

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id,
    status
  ) VALUES (
    v_user,
    v_org,
    'observability-rbac-ops@example.test',
    'Observability RBAC Operator',
    'ops_admin',
    'tenant',
    NULL,
    'active'
  )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      status = EXCLUDED.status;

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user);
END $$;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_roles r
      JOIN public.rbac_role_permissions rp ON rp.role_id = r.id
      JOIN public.lookup_values lv ON lv.id = rp.permission_id
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE r.organization_id = '11e390a1-90e8-4b2f-8cdd-0101f0b50b01'::uuid
       AND r.key = 'ops_admin'
       AND ld.category = 'rbac_permission'
       AND lv.value = 'observability.read'
  ),
  'provisioned ops_admin role receives observability.read'
);

SELECT set_config('request.jwt.claim.sub', '11e390a1-90e8-4b2f-8cdd-0101f0b50b02', true);
SET LOCAL ROLE authenticated;

SELECT ok(
  public.user_has_capability_v1(
    'observability.read',
    'tenant',
    '11e390a1-90e8-4b2f-8cdd-0101f0b50b01'::uuid
  ),
  'ops_admin can read observability surfaces'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
