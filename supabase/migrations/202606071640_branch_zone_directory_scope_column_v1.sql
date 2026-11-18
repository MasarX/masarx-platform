-- Maps/geocoding readiness: keep branch-zone directory scope-compatible.
-- The Console Zones surface reads branch_zone_directory through the shared
-- ui_read_registry path, whose tenant scope filter resolves to organization_id.
-- Expose that column on the paired projection instead of bypassing registry
-- scoping in the frontend.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606071640_branch_zone_directory_scope_column_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_branch_zone_directory;

CREATE VIEW public.v_branch_zone_directory
WITH (security_invoker = true)
AS
SELECT
  bz.id AS id,
  bz.branch_id,
  bz.zone_id,
  bz.priority,
  bz.created_at,
  COALESCE(b.name, b.code) AS branch_label,
  b.code AS hub_code,
  b.branch_type AS branch_type,
  z.name AS zone_label,
  z.slug AS zone_slug,
  COALESCE(z.organization_id, b.organization_id) AS organization_id
FROM public.branch_zones bz
LEFT JOIN public.branches b ON b.id = bz.branch_id
LEFT JOIN public.zones z ON z.id = bz.zone_id;

COMMENT ON VIEW public.v_branch_zone_directory IS
  'FE-friendly projection of branch_zones with derived join columns and tenant scope organization_id. Sources: branch_zones + branches + zones. Read-only; SSOT remains branch_zones; mutations go through branch_zone_assign_v1 / branch_zone_unassign_v1.';

REVOKE ALL ON public.v_branch_zone_directory FROM PUBLIC;
REVOKE ALL ON public.v_branch_zone_directory FROM anon;
REVOKE ALL ON public.v_branch_zone_directory FROM authenticated;
GRANT SELECT ON public.v_branch_zone_directory TO authenticated;
GRANT SELECT ON public.v_branch_zone_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202606071640_branch_zone_directory_scope_column_v1'));
COMMIT;
