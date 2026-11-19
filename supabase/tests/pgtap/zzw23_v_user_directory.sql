-- pgTAP: public.v_user_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W23 (paired projection views — IDENTITY)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_user_directory',
  'public.v_user_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_user_directory',
  ARRAY[
    'id', 'organization_id', 'email', 'full_name',
    'user_type', 'status',
    'access_scope_type', 'access_scope_id',
    'created_at', 'last_login_at',
    'organization_label', 'organization_slug', 'access_scope_label',
    'active_role_count', 'active_role_keys',
    'is_platform_user', 'is_tenant_user', 'is_client_user', 'is_sender_user'
  ],
  'v_user_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_user_directory', 'SELECT'),
  'service_role has SELECT on v_user_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_user_directory', 'SELECT'),
  'anon has no SELECT on v_user_directory'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_user_directory', 'SELECT'),
  'authenticated has SELECT on v_user_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'users'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.users remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a user with role assignment, verify projections resolve through the view.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000023a000';
  v_user UUID := '00000000-0000-0000-0000-00000023a001';
  v_role UUID := '00000000-0000-0000-0000-00000023a002';
  v_assignment UUID := '00000000-0000-0000-0000-00000023a003';
  v_org_label TEXT;
  v_role_count INT;
  v_role_keys TEXT[];
  v_is_tenant BOOLEAN;
  v_scope_label TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W23 User Directory Test Org', 'w23-user-dir-test-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status,
    access_scope_type, access_scope_id, created_at
  )
  VALUES (
    v_user, v_org,
    'w23-test@example.invalid',
    'W23 Tester',
    'ops_admin', 'active',
    'tenant', NULL, now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (
    id, organization_id, key, name, description, is_active, metadata
  )
  VALUES (
    v_role, v_org, 'w23_test_role', 'W23 Test Role',
    'Role for W23 view test', TRUE, '{"tier":"functional"}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (
    id, organization_id, user_id, role_id,
    assigned_by_user_id, assigned_at, revoked_at, metadata
  )
  VALUES (
    v_assignment, v_org, v_user, v_role,
    NULL, now(), NULL, '{}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT organization_label, active_role_count, active_role_keys, is_tenant_user, access_scope_label
    INTO v_org_label, v_role_count, v_role_keys, v_is_tenant, v_scope_label
    FROM public.v_user_directory
   WHERE id = v_user;

  PERFORM ok(
    v_org_label = 'W23 User Directory Test Org'
      AND v_role_count = 1
      AND v_role_keys @> ARRAY['w23_test_role']::TEXT[]
      AND v_is_tenant = TRUE
      AND v_scope_label = 'Tenant',
    'v_user_directory projects organization_label + active_role_count + active_role_keys + is_tenant_user + access_scope_label'
  );
END;
$$;

-- 8) Negative path: revoked role assignments are excluded from active_role_count.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000023a010';
  v_user UUID := '00000000-0000-0000-0000-00000023a011';
  v_role UUID := '00000000-0000-0000-0000-00000023a012';
  v_assignment UUID := '00000000-0000-0000-0000-00000023a013';
  v_role_count INT;
  v_is_platform BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W23 Revoked Role Org', 'w23-revoked-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status,
    access_scope_type, access_scope_id, created_at
  )
  VALUES (
    v_user, v_org,
    'w23-revoked@example.invalid',
    'W23 Revoked Tester',
    'super_admin', 'active',
    'platform', NULL, now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (
    id, organization_id, key, name, description, is_active, metadata
  )
  VALUES (
    v_role, v_org, 'w23_revoked_role', 'W23 Revoked Role',
    'Role for revoked-path test', TRUE, '{}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (
    id, organization_id, user_id, role_id,
    assigned_by_user_id, assigned_at, revoked_at, metadata
  )
  VALUES (
    v_assignment, v_org, v_user, v_role,
    NULL, now() - INTERVAL '1 hour', now(), '{}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT active_role_count, is_platform_user
    INTO v_role_count, v_is_platform
    FROM public.v_user_directory
   WHERE id = v_user;

  PERFORM ok(
    v_role_count = 0
      AND v_is_platform = TRUE,
    'v_user_directory excludes revoked assignments from active_role_count and flags is_platform_user'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
