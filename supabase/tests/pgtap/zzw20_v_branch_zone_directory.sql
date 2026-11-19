-- pgTAP: public.v_branch_zone_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W20 (paired projection views — NETWORK)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_branch_zone_directory',
  'public.v_branch_zone_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_branch_zone_directory',
  ARRAY[
    'id', 'branch_id', 'zone_id', 'priority', 'created_at',
    'branch_label', 'hub_code', 'branch_type', 'zone_label', 'zone_slug',
    'organization_id'
  ],
  'v_branch_zone_directory exposes FE-projection and tenant scope columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_branch_zone_directory', 'SELECT'),
  'service_role has SELECT on v_branch_zone_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_branch_zone_directory', 'SELECT'),
  'anon has no SELECT on v_branch_zone_directory'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_branch_zone_directory', 'SELECT'),
  'authenticated has SELECT on v_branch_zone_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'branch_zones'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.branch_zones remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a branch_zones row, verify branch_label resolves to branches.name
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000011b301';
  v_branch UUID := '00000000-0000-0000-0000-00000011b302';
  v_zone   UUID := '00000000-0000-0000-0000-00000011b303';
  v_label  TEXT;
  v_hub_code TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W20 Branch Zone Directory Org', 'w20-bzd-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (
    id, organization_id, code, name, branch_type, is_active
  )
  VALUES (
    v_branch, v_org,
    'w20-test-' || left(v_branch::text, 8),
    'W20 Test Branch',
    'hub', TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.zones (
    id, organization_id, name, slug, is_active
  )
  VALUES (
    v_zone, v_org, 'W20 Test Zone', 'w20-zone-' || left(v_zone::text, 8), TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branch_zones (branch_id, zone_id, priority)
  VALUES (v_branch, v_zone, 0)
  ON CONFLICT (zone_id) DO NOTHING;

  SELECT branch_label, hub_code
    INTO v_label, v_hub_code
    FROM public.v_branch_zone_directory
   WHERE branch_id = v_branch AND zone_id = v_zone;

  PERFORM ok(
    v_label = 'W20 Test Branch',
    'v_branch_zone_directory.branch_label projects branches.name'
  );

  PERFORM is(
    (
      SELECT organization_id
        FROM public.v_branch_zone_directory
       WHERE branch_id = v_branch AND zone_id = v_zone
    ),
    v_org,
    'v_branch_zone_directory.organization_id supports ui_read_registry tenant scoping'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
