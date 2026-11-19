-- pgTAP: public.v_service_offering_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W31 (paired projection views - CATALOG)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_service_offering_directory',
  'public.v_service_offering_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_service_offering_directory',
  ARRAY[
    'id', 'service_level_id', 'branch_id', 'zone_id',
    'effective_from', 'effective_to', 'priority', 'is_active',
    'metadata', 'created_at', 'updated_at',
    'organization_id', 'level_key', 'level_name', 'level_is_active',
    'tenant_label', 'branch_name', 'zone_label',
    'display_name', 'display_slug', 'effective_status',
    'base_price', 'currency', 'max_weight_kg',
    'active_subscription_count',
    'is_active_window', 'is_archived', 'is_draft',
    'age_seconds', 'age_hours', 'last_updated_at'
  ],
  'v_service_offering_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_service_offering_directory', 'SELECT'),
  'service_role has SELECT on v_service_offering_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_service_offering_directory', 'SELECT'),
  'anon has no SELECT on v_service_offering_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_service_offering_directory', 'SELECT'),
  'authenticated has SELECT on v_service_offering_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'service_offerings'
       AND c.relkind = 'r'
  ),
  'public.service_offerings remains a base table (SSOT preserved)'
);

-- 7) Projection: insert org/level/branch/zone/offering + subscriptions.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000031e001';
  v_level    UUID := '00000000-0000-0000-0000-00000031e002';
  v_branch   UUID := '00000000-0000-0000-0000-00000031e003';
  v_zone     UUID := '00000000-0000-0000-0000-00000031e004';
  v_offering UUID := '00000000-0000-0000-0000-00000031e005';
  v_sub_active1 UUID := '00000000-0000-0000-0000-00000031e006';
  v_sub_active2 UUID := '00000000-0000-0000-0000-00000031e007';
  v_sub_cancel  UUID := '00000000-0000-0000-0000-00000031e008';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W31 Catalog Org', 'w31-catalog-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.lookup_values (lookup_definition_id, value, label, status)
  SELECT id, 'w31-express-main', 'Fixture service level', 'active'
  FROM public.lookup_definitions
  WHERE category = 'service_level'
  ON CONFLICT (lookup_definition_id, value) DO NOTHING;

  INSERT INTO public.service_levels (
    id, organization_id, key, name, is_active, metadata
  )
  VALUES (
    v_level, v_org, 'w31-express-main', 'W31 Express', TRUE,
    jsonb_build_object('tier', 'express', 'priority_rank', 30, 'sla_minutes', 240)
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (
    id, organization_id, code, name, branch_type
  )
  VALUES (
    v_branch, v_org, 'w31-br-main', 'W31 Branch', 'hub'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.zones (
    id, organization_id, slug, name
  )
  VALUES (
    v_zone, v_org, 'w31-zn-main', 'W31 Zone'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.service_offerings (
    id, service_level_id, branch_id, zone_id,
    effective_from, effective_to,
    priority, is_active, metadata
  )
  VALUES (
    v_offering, v_level, v_branch, v_zone,
    now() - interval '1 day', now() + interval '30 days',
    10, TRUE,
    jsonb_build_object(
      'display', jsonb_build_object('name', 'W31 Display Name', 'slug', 'w31-display-slug', 'status', 'active'),
      'base_price', 99.5,
      'currency', 'SAR',
      'max_weight_kg', 25
    )
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.subscriptions (
    id, organization_id, plan_key, status, metadata
  )
  VALUES
    (v_sub_active1, v_org, 'w31-plan-a', 'active',
      jsonb_build_object('service_offering_id', v_offering::text)),
    (v_sub_active2, v_org, 'w31-plan-b', 'active',
      jsonb_build_object('service_offering_id', v_offering::text)),
    (v_sub_cancel, v_org, 'w31-plan-c', 'canceled',
      jsonb_build_object('service_offering_id', v_offering::text))
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_service_offering_directory
    WHERE id = '00000000-0000-0000-0000-00000031e005'::UUID
      AND tenant_label = 'W31 Catalog Org'
      AND level_key = 'w31-express-main'
      AND level_name = 'W31 Express'
      AND branch_name = 'W31 Branch'
      AND zone_label = 'W31 Zone'
      AND display_name = 'W31 Display Name'
      AND display_slug = 'w31-display-slug'
      AND effective_status = 'active'
      AND base_price = 99.5
      AND currency = 'SAR'
      AND max_weight_kg = 25
      AND active_subscription_count = 2
      AND is_active_window = TRUE
      AND is_archived = FALSE
      AND is_draft = FALSE
  ),
  'v_service_offering_directory derives tenant_label/level_key/level_name/branch_name/zone_label + display projection + pricing facets + active_subscription_count + is_active_window'
);

-- 8) Archived projection.
DO $$
DECLARE
  v_level    UUID := '00000000-0000-0000-0000-00000031e002';
  v_branch   UUID := '00000000-0000-0000-0000-00000031e003';
  v_offering2 UUID := '00000000-0000-0000-0000-00000031e009';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.service_offerings (
    id, service_level_id, branch_id,
    effective_from, priority, is_active, metadata
  )
  VALUES (
    v_offering2, v_level, v_branch,
    now() - interval '90 days', 0, TRUE,
    jsonb_build_object(
      'display', jsonb_build_object('status', 'archived')
    )
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_service_offering_directory
    WHERE id = '00000000-0000-0000-0000-00000031e009'::UUID
      AND effective_status = 'archived'
      AND is_archived = TRUE
      AND is_draft = FALSE
  ),
  'v_service_offering_directory: metadata.display.status=archived overrides is_active=TRUE; effective_status=archived + is_archived=TRUE + is_draft=FALSE'
);

SELECT * FROM finish();
ROLLBACK;
