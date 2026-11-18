-- pgTAP: public.v_service_level_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W31 (paired projection views - CATALOG)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_service_level_directory',
  'public.v_service_level_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_service_level_directory',
  ARRAY[
    'id', 'organization_id', 'key', 'name', 'description',
    'is_active', 'metadata', 'created_at', 'updated_at',
    'tenant_label',
    'tier', 'priority_rank', 'sla_minutes', 'sla_label', 'color_token',
    'offering_count', 'active_offering_count',
    'active_subscription_count',
    'age_seconds', 'age_hours', 'last_updated_at'
  ],
  'v_service_level_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_service_level_directory', 'SELECT'),
  'service_role has SELECT on v_service_level_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_service_level_directory', 'SELECT'),
  'anon has no SELECT on v_service_level_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_service_level_directory', 'SELECT'),
  'authenticated has SELECT on v_service_level_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'service_levels'
       AND c.relkind = 'r'
  ),
  'public.service_levels remains a base table (SSOT preserved)'
);

-- 7) Projection: insert org + level + offerings + subscriptions.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000031b001';
  v_level    UUID := '00000000-0000-0000-0000-00000031b002';
  v_branch   UUID := '00000000-0000-0000-0000-00000031b003';
  v_off1     UUID := '00000000-0000-0000-0000-00000031b004';
  v_off2     UUID := '00000000-0000-0000-0000-00000031b005';
  v_sub1     UUID := '00000000-0000-0000-0000-00000031b006';
  v_sub2     UUID := '00000000-0000-0000-0000-00000031b007';
  v_sub3     UUID := '00000000-0000-0000-0000-00000031b008';
  v_level_key TEXT := 'w31-tier-main';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W31 Level Org', 'w31-lvl-org-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.service_levels (
    id, organization_id, key, name, is_active, metadata
  )
  VALUES (
    v_level, v_org, v_level_key, 'W31 Tier Level', TRUE,
    jsonb_build_object(
      'tier', 'express',
      'priority_rank', 30,
      'sla_minutes', 240,
      'sla_label', '4 hours',
      'color_token', 'success-strong'
    )
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (
    id, organization_id, code, name, branch_type
  )
  VALUES (
    v_branch, v_org, 'w31lb-main', 'W31 Level Branch', 'hub'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.service_offerings (
    id, service_level_id, branch_id,
    effective_from, priority, is_active, metadata
  )
  VALUES
    (v_off1, v_level, v_branch, now() - interval '1 day', 0, TRUE,
      jsonb_build_object('display', jsonb_build_object('status', 'active'))),
    (v_off2, v_level, v_branch, now() - interval '60 days', 0, FALSE,
      jsonb_build_object('display', jsonb_build_object('status', 'archived')))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.subscriptions (
    id, organization_id, plan_key, status
  )
  VALUES
    (v_sub1, v_org, v_level_key, 'active'),
    (v_sub2, v_org, v_level_key, 'active'),
    (v_sub3, v_org, v_level_key, 'canceled')
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_service_level_directory
    WHERE id = '00000000-0000-0000-0000-00000031b002'::UUID
      AND tenant_label = 'W31 Level Org'
      AND tier = 'express'
      AND priority_rank = 30
      AND sla_minutes = 240
      AND sla_label = '4 hours'
      AND color_token = 'success-strong'
      AND offering_count = 2
      AND active_offering_count = 1
      AND active_subscription_count = 2
  ),
  'v_service_level_directory derives tenant_label + metadata projection (tier/priority_rank/sla_minutes/sla_label/color_token) + offering counters (offering_count=2, active_offering_count=1) + active_subscription_count=2 (canceled excluded)'
);

-- 8) Cross-tenant isolation.
DO $$
DECLARE
  v_org_b    UUID := '00000000-0000-0000-0000-00000031b020';
  v_level_key TEXT := 'w31-tier-main';
  v_sub_other UUID := '00000000-0000-0000-0000-00000031b021';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_b, 'W31 Other Org', 'w31-oth-org-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.subscriptions (
    id, organization_id, plan_key, status
  )
  VALUES (v_sub_other, v_org_b, v_level_key, 'active')
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_service_level_directory
    WHERE id = '00000000-0000-0000-0000-00000031b002'::UUID
      AND active_subscription_count = 2
  ),
  'v_service_level_directory: subscriptions in a different organization_id do NOT count toward this level''s active_subscription_count (multi-tenant isolation preserved)'
);

SELECT * FROM finish();
ROLLBACK;
