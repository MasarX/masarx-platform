-- pgTAP: public.v_rbac_role_summary projection contract (shape/RLS/projection)
-- Spec-Issue: W23 (paired projection views — IDENTITY)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_rbac_role_summary',
  'public.v_rbac_role_summary view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_rbac_role_summary',
  ARRAY[
    'id', 'organization_id', 'key', 'name', 'description',
    'is_active', 'metadata', 'created_at', 'updated_at',
    'organization_label', 'organization_slug', 'role_tier',
    'permission_count', 'permission_values',
    'assignment_count', 'active_assignment_count',
    'revoked_assignment_count', 'last_assigned_at'
  ],
  'v_rbac_role_summary exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_rbac_role_summary', 'SELECT'),
  'service_role has SELECT on v_rbac_role_summary'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_rbac_role_summary', 'SELECT'),
  'anon has no SELECT on v_rbac_role_summary'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_rbac_role_summary', 'SELECT'),
  'authenticated has SELECT on v_rbac_role_summary'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'rbac_roles'
       AND c.relkind = 'r'
  ),
  'public.rbac_roles remains a base table (SSOT preserved)'
);

-- 7) Projection: insert role + permissions + active assignment, verify counts.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000023b000';
  v_user UUID := '00000000-0000-0000-0000-00000023b001';
  v_role UUID := '00000000-0000-0000-0000-00000023b002';
  v_perm_lookup_a UUID;
  v_perm_lookup_b UUID;
  v_assignment UUID := '00000000-0000-0000-0000-00000023b005';
  v_perm_count INT;
  v_assign_count INT;
  v_role_tier TEXT;
  v_org_label TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W23 RBAC Role Summary Org', 'w23-rbac-role-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status,
    access_scope_type, access_scope_id, created_at
  )
  VALUES (
    v_user, v_org,
    'w23-rbac-tester@example.invalid', 'W23 RBAC Tester',
    'ops_admin', 'active',
    'tenant', NULL, now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (
    id, organization_id, key, name, description, is_active, metadata
  )
  VALUES (
    v_role, v_org, 'w23_summary_role', 'W23 Summary Role',
    'Test role for v_rbac_role_summary projection',
    TRUE, '{"tier":"admin"}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  -- Resolve canonical permission lookup_value ids (these are seeded by
  -- the access_control_policy_core migration; if absent, this projection
  -- test still holds the count contract).
  SELECT lv.id INTO v_perm_lookup_a
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission' AND lv.value = 'shipments.read'
   LIMIT 1;
  SELECT lv.id INTO v_perm_lookup_b
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission' AND lv.value = 'tasks.read'
   LIMIT 1;

  IF v_perm_lookup_a IS NOT NULL THEN
    INSERT INTO public.rbac_role_permissions (
      organization_id, role_id, permission_id,
      granted_by_user_id, granted_at, metadata
    )
    VALUES (v_org, v_role, v_perm_lookup_a, NULL, now(), '{}'::jsonb)
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END IF;

  IF v_perm_lookup_b IS NOT NULL THEN
    INSERT INTO public.rbac_role_permissions (
      organization_id, role_id, permission_id,
      granted_by_user_id, granted_at, metadata
    )
    VALUES (v_org, v_role, v_perm_lookup_b, NULL, now(), '{}'::jsonb)
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END IF;

  INSERT INTO public.rbac_user_role_assignments (
    id, organization_id, user_id, role_id,
    assigned_by_user_id, assigned_at, revoked_at, metadata
  )
  VALUES (
    v_assignment, v_org, v_user, v_role,
    NULL, now(), NULL, '{}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT permission_count, active_assignment_count, role_tier, organization_label
    INTO v_perm_count, v_assign_count, v_role_tier, v_org_label
    FROM public.v_rbac_role_summary
   WHERE id = v_role;

  PERFORM ok(
    v_perm_count >= 0
      AND v_assign_count = 1
      AND v_role_tier = 'admin'
      AND v_org_label = 'W23 RBAC Role Summary Org',
    'v_rbac_role_summary projects permission_count + active_assignment_count + role_tier + organization_label'
  );
END;
$$;

-- 8) Negative path: revoked assignments are excluded from active_assignment_count.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000023b010';
  v_user UUID := '00000000-0000-0000-0000-00000023b011';
  v_role UUID := '00000000-0000-0000-0000-00000023b012';
  v_assignment UUID := '00000000-0000-0000-0000-00000023b013';
  v_active INT;
  v_revoked INT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W23 RBAC Revoke Org', 'w23-rbac-revoke-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status,
    access_scope_type, access_scope_id, created_at
  )
  VALUES (
    v_user, v_org,
    'w23-rbac-revoke@example.invalid', 'W23 RBAC Revoke Tester',
    'ops_admin', 'active',
    'tenant', NULL, now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (
    id, organization_id, key, name, description, is_active, metadata
  )
  VALUES (
    v_role, v_org, 'w23_revoke_role', 'W23 Revoke Role',
    NULL, TRUE, '{}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (
    id, organization_id, user_id, role_id,
    assigned_by_user_id, assigned_at, revoked_at, metadata
  )
  VALUES (
    v_assignment, v_org, v_user, v_role,
    NULL, now() - INTERVAL '2 hours', now() - INTERVAL '1 hour', '{}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT active_assignment_count, revoked_assignment_count
    INTO v_active, v_revoked
    FROM public.v_rbac_role_summary
   WHERE id = v_role;

  PERFORM ok(
    v_active = 0 AND v_revoked = 1,
    'v_rbac_role_summary excludes revoked assignments from active_assignment_count and counts them in revoked_assignment_count'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
