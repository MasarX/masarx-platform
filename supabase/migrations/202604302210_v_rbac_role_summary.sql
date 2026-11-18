-- Spec-Issue: W23 IDENTITY gap closure (paired projection views)
-- Step: W23-VIEW-2
-- Migration: Canonical projection view public.v_rbac_role_summary.
-- Capability: access_policy.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-role derived counters used by
--   `apps/console-v2/src/modules/platform/access.tsx` (Roles tab):
--     - permission_count   : COUNT(rbac_role_permissions WHERE role_id matches)
--     - permission_values  : array_agg(lookup_values.value) — flat permission
--                            keys, deduped + ordered for the drawer detail.
--     - assignment_count   : COUNT(rbac_user_role_assignments WHERE
--                            role_id matches AND revoked_at IS NULL)
--     - active_assignment_count : same as assignment_count (alias for
--                            FE consumers expecting the qualified name)
--     - revoked_assignment_count : COUNT(rbac_user_role_assignments
--                            WHERE role_id matches AND revoked_at IS NOT NULL)
--     - last_assigned_at   : MAX(assigned_at) across all assignments
--                            (active + revoked) for this role
--     - organization_label : derived from organizations.name (FK join)
--     - organization_slug  : derived from organizations.slug (FK join)
--     - role_tier          : derived passthrough from metadata.tier
--                            (default 'functional' when not set; mirrors
--                            seed posture in apps/console-v2/src/lib/seed-raw/rbac.js)
--
--   The FE `RbacRoleRow` interface in
--   `apps/console-v2/src/modules/platform/access.tsx` (W19-3 closure)
--   already includes `permission_count` and `assignment_count` projection
--   fields with `// SSOT: projection — count(...)` annotations. Moving
--   them onto a canonical view exposes the canonical SSOT columns AND
--   the FE-shaped projection aliases on the same seam, so the production
--   cutover becomes a single getSupabaseClient() branch flip in
--   `ui_list_resource_v1('rbac_role_summary')`.
--
-- Notes:
--   * SSOT remains public.rbac_roles; this view is read-only.
--   * RLS is enforced by the underlying tables (rbac_roles,
--     rbac_role_permissions, rbac_user_role_assignments, lookup_values,
--     organizations).
--   * Service-role + authenticated SELECT (mirrors W20/W21/W22 paired
--     projection grants).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302210_v_rbac_role_summary'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_rbac_role_summary;

CREATE VIEW public.v_rbac_role_summary AS
WITH perm_rollup AS (
  SELECT
    rp.role_id,
    COUNT(*)::INT                                          AS permission_count,
    array_agg(DISTINCT lv.value ORDER BY lv.value)         AS permission_values
  FROM public.rbac_role_permissions rp
  LEFT JOIN public.lookup_values lv ON lv.id = rp.permission_id
  GROUP BY rp.role_id
),
assign_rollup AS (
  SELECT
    a.role_id,
    COUNT(*) FILTER (WHERE a.revoked_at IS NULL)::INT      AS active_assignment_count,
    COUNT(*) FILTER (WHERE a.revoked_at IS NOT NULL)::INT  AS revoked_assignment_count,
    MAX(a.assigned_at)                                     AS last_assigned_at
  FROM public.rbac_user_role_assignments a
  GROUP BY a.role_id
)
SELECT
  r.id,
  r.organization_id,
  r.key,
  r.name,
  r.description,
  r.is_active,
  r.metadata,
  r.created_at,
  r.updated_at,
  -- Organization join
  o.name                                                    AS organization_label,
  o.slug                                                    AS organization_slug,
  -- Tier passthrough (defaults to 'functional' if metadata.tier is
  -- absent; mirrors seed posture).
  COALESCE(NULLIF(r.metadata->>'tier', ''), 'functional')   AS role_tier,
  -- Derived counters
  COALESCE(perm_rollup.permission_count, 0)                 AS permission_count,
  COALESCE(perm_rollup.permission_values, ARRAY[]::TEXT[])  AS permission_values,
  COALESCE(assign_rollup.active_assignment_count, 0)        AS assignment_count,
  COALESCE(assign_rollup.active_assignment_count, 0)        AS active_assignment_count,
  COALESCE(assign_rollup.revoked_assignment_count, 0)       AS revoked_assignment_count,
  assign_rollup.last_assigned_at
FROM public.rbac_roles r
LEFT JOIN public.organizations o ON o.id = r.organization_id
LEFT JOIN perm_rollup    ON perm_rollup.role_id    = r.id
LEFT JOIN assign_rollup  ON assign_rollup.role_id  = r.id;

COMMENT ON VIEW public.v_rbac_role_summary IS
  'FE-friendly projection of rbac_roles with derived counters (permission_count, permission_values, assignment_count, active_assignment_count, revoked_assignment_count, last_assigned_at), tier passthrough (role_tier), and organization join (organization_label, organization_slug). Sources: rbac_roles + rbac_role_permissions + rbac_user_role_assignments + lookup_values + organizations. Read-only; SSOT remains rbac_roles; mutations go through rbac_create_role_v1 / rbac_update_role_v1 / rbac_delete_role_v1 / rbac_grant_role_v1 / rbac_revoke_role_v1 / provision_rbac_roles_from_templates_v1.';

REVOKE ALL ON public.v_rbac_role_summary FROM PUBLIC;
REVOKE ALL ON public.v_rbac_role_summary FROM anon;
REVOKE ALL ON public.v_rbac_role_summary FROM authenticated;
GRANT SELECT ON public.v_rbac_role_summary TO authenticated;
GRANT SELECT ON public.v_rbac_role_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302210_v_rbac_role_summary'));
COMMIT;
