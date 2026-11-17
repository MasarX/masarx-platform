-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- pgTAP: Regression guard - control-plane authenticated write policies must be RBAC-gated

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);

CREATE TEMP TABLE tmp_control_plane_tables AS
SELECT unnest(ARRAY[
  'branches',
  'service_levels',
  'service_offerings',
  'branch_coverage_windows',
  'branch_capacity_windows',
  'calendar_events',
  'branch_memberships',
  'zones',
  'zone_districts',
  'branch_zones',
  'vehicle_types',
  'vehicles',
  'vehicle_assignments',
  'vehicle_maintenance_windows',
  'clients',
  'senders',
  'providers',
  'webhook_sources',
  'mapping_configs'
])::text AS table_name;

SELECT is_empty(
  $sql$
  SELECT t.table_name
  FROM tmp_control_plane_tables t
  LEFT JOIN pg_policies p
    ON p.schemaname = 'public'
   AND p.tablename = t.table_name
   AND p.cmd IN ('ALL','INSERT','UPDATE','DELETE')
   AND 'authenticated' = ANY (p.roles)
  WHERE p.tablename IS NULL
  $sql$,
  'All control-plane tables define authenticated write policies'
);

SELECT is_empty(
  $sql$
  SELECT p.tablename, p.policyname, p.cmd
  FROM pg_policies p
  JOIN tmp_control_plane_tables t ON t.table_name = p.tablename
  WHERE p.schemaname = 'public'
    AND p.cmd IN ('ALL','INSERT','UPDATE','DELETE')
    AND 'authenticated' = ANY (p.roles)
    AND (
      (COALESCE(p.qual, '') || ' ' || COALESCE(p.with_check, '')) NOT ILIKE '%user_has_permission_v1%'
    )
  $sql$,
  'All control-plane authenticated write policies reference user_has_permission_v1'
);

SELECT finish();
ROLLBACK;
