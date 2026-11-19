BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('network.read'),
      ('marketplace.read')
    ) AS required(permission_value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'rbac_permission'
        AND lv.value = required.permission_value
        AND lv.status = 'active'
    )
  ),
  'rbac_permission lookup registry includes network and marketplace capabilities'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('network.read'),
      ('marketplace.read')
    ) AS required(permission_value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.rbac_role_templates t
      JOIN public.rbac_role_template_permissions tp ON tp.role_template_id = t.id
      JOIN public.lookup_values lv ON lv.id = tp.permission_id
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE t.key = 'ops_admin'
        AND ld.category = 'rbac_permission'
        AND lv.value = required.permission_value
    )
  ),
  'ops_admin role template grants network and marketplace capabilities'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (
      SELECT role.value AS role_value
      FROM public.settings_versions sv,
           jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role(value)
      WHERE sv.category = 'access_control_policy'
        AND sv.scope_type = 'global'
        AND sv.scope_id IS NULL
        AND sv.approved_at IS NOT NULL
        AND sv.effective_until IS NULL
        AND role.value->>'key' = 'ops_admin'
      ORDER BY sv.version DESC
      LIMIT 1
    ) AS ops
    CROSS JOIN (VALUES
      ('network.read'),
      ('marketplace.read')
    ) AS required(permission_value)
    WHERE NOT (COALESCE(ops.role_value->'capability_keys', '[]'::jsonb) @> to_jsonb(required.permission_value))
  ),
  'active access_control_policy grants ops_admin network and marketplace capabilities'
);

DO $$
DECLARE
  v_org UUID := '11e390a1-90e8-4b2f-8cdd-0101f001cf01'::uuid;
  v_user UUID := '11e390a1-90e8-4b2f-8cdd-0101f001cf02'::uuid;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Partner Finance Handoff RBAC Org', 'partner-finance-handoff-rbac')
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
    'partner-finance-handoff-rbac@example.test',
    'Partner Finance Handoff RBAC Operator',
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
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('network.read'),
      ('marketplace.read')
    ) AS required(permission_value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.rbac_roles r
      JOIN public.rbac_role_permissions rp ON rp.role_id = r.id
      JOIN public.lookup_values lv ON lv.id = rp.permission_id
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE r.organization_id = '11e390a1-90e8-4b2f-8cdd-0101f001cf01'::uuid
        AND r.key = 'ops_admin'
        AND ld.category = 'rbac_permission'
        AND lv.value = required.permission_value
    )
  ),
  'provisioned ops_admin role receives network and marketplace capabilities'
);

DO $$
DECLARE
  v_org UUID := '11e390a1-90e8-4b2f-8cdd-0101f001cf01'::uuid;
  v_user UUID := '11e390a1-90e8-4b2f-8cdd-0101f001cf02'::uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(public.user_has_capability_v1('marketplace.read', 'tenant', v_org), 'ops_admin can read marketplace participants');
  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();

ROLLBACK;
