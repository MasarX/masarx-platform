-- Plan: PLAN-202603-operator-accounts-superadmin-audit / Step: S95
-- pgTAP: Operator account + super-admin contract invariants

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(role->'capability_keys') = 'array' THEN role->'capability_keys'
        ELSE '[]'::jsonb
      END
    ) AS cap(value)
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND role->>'key' = 'super_admin'
      AND cap.value = '*'
  ),
  'access_control_policy super_admin role includes wildcard capability'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND jsonb_path_exists(
        sv.value,
        '$.assignments.user_type.super_admin[*] ? (@ == "super_admin")'
      )
  ),
  'access_control_policy maps user_type.super_admin to super_admin role'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'user_type'
      AND lv.value = 'super_admin'
      AND COALESCE(lower(lv.metadata->>'default_scope_type'), '') = 'platform'
  ),
  'lookup metadata pins super_admin default_scope_type=platform'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_policy JSONB;
  v_allowed BOOLEAN := FALSE;
  v_caps TEXT[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Operator Contract Org', 'operator-contract-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_user,
    v_org,
    'operator-contract-' || left(v_user::text, 8) || '@example.com',
    'Operator Contract Super Admin',
    'super_admin',
    'platform',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT policy
  INTO v_policy
  FROM public.resolve_access_control_policy_v1('global', NULL::uuid, FALSE)
  LIMIT 1;

  SELECT allowed, capability_keys
  INTO v_allowed, v_caps
  FROM public.access_eval_capability_v1(
    v_policy,
    'organizations.write',
    'platform',
    NULL::uuid,
    v_user,
    'super_admin'
  );

  PERFORM ok(v_allowed IS TRUE, 'super_admin resolves organizations.write through wildcard capability');
  PERFORM ok(COALESCE(v_caps, ARRAY[]::text[]) @> ARRAY['*']::text[], 'super_admin capability set contains "*"');
END $$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'organizations'
      AND tc.audit_enabled IS TRUE
  ),
  'table_contracts: organizations audit is enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'clients'
      AND tc.audit_enabled IS TRUE
  ),
  'table_contracts: clients audit is enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'senders'
      AND tc.audit_enabled IS TRUE
  ),
  'table_contracts: senders audit is enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'shipments'
      AND tc.audit_enabled IS TRUE
  ),
  'table_contracts: shipments audit is enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'providers'
      AND tc.audit_enabled IS TRUE
  ),
  'table_contracts: providers audit is enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'webhook_sources'
      AND tc.audit_enabled IS TRUE
  ),
  'table_contracts: webhook_sources audit is enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'organizations'
      AND (COALESCE(p.qual, '') LIKE '%is_platform_user%' OR COALESCE(p.with_check, '') LIKE '%is_platform_user%')
  ),
  'organizations policies include platform scope path'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'clients'
      AND (COALESCE(p.qual, '') LIKE '%is_platform_user%' OR COALESCE(p.with_check, '') LIKE '%is_platform_user%')
  ),
  'clients policies include platform scope path'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'senders'
      AND (COALESCE(p.qual, '') LIKE '%is_platform_user%' OR COALESCE(p.with_check, '') LIKE '%is_platform_user%')
  ),
  'senders policies include platform scope path'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'shipments'
      AND (COALESCE(p.qual, '') LIKE '%is_platform_user%' OR COALESCE(p.with_check, '') LIKE '%is_platform_user%')
  ),
  'shipments policies include platform scope path'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'providers'
      AND (COALESCE(p.qual, '') LIKE '%is_platform_user%' OR COALESCE(p.with_check, '') LIKE '%is_platform_user%')
  ),
  'providers policies include platform scope path'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'webhook_sources'
      AND (COALESCE(p.qual, '') LIKE '%is_platform_user%' OR COALESCE(p.with_check, '') LIKE '%is_platform_user%')
  ),
  'webhook_sources policies include platform scope path'
);

SELECT * FROM finish();

ROLLBACK;

