-- Spec-Issue: W23 IDENTITY gap closure (paired projection views)
-- Step: W23-VIEW-1
-- Migration: Canonical projection view public.v_user_directory.
-- Capability: users.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-user derived counters + role rollups used by
--   `apps/console-v2/src/modules/platform/users.tsx` (UserRow surface):
--     - organization_label : derived from organizations.name (FK join)
--     - organization_slug  : derived from organizations.slug (FK join)
--     - access_scope_label : human-readable scope label resolved via
--                            scope_type_registry.scope_type (canonical
--                            ladder ranks). NULL when access_scope_type
--                            is itself NULL.
--     - active_role_count  : COUNT(rbac_user_role_assignments WHERE
--                            user_id matches AND revoked_at IS NULL)
--     - active_role_keys   : array_agg(rbac_roles.key) for active
--                            assignments (deduped + ordered)
--     - active_session_count : derived passthrough — actual session
--                            tracking lives in auth.sessions which is
--                            not joined here (auth schema is server-
--                            internal); FE seed mirrors this column
--                            from the user_sessions slice.
--     - last_login_at      : passthrough canonical column
--     - is_platform_user   : derived BOOLEAN — TRUE when
--                            access_scope_type='platform'
--     - is_tenant_user     : derived BOOLEAN — TRUE when
--                            access_scope_type='tenant'
--     - is_client_user     : derived BOOLEAN — TRUE when
--                            access_scope_type='client'
--     - is_sender_user     : derived BOOLEAN — TRUE when
--                            access_scope_type='sender'
--
--   The FE `UserRow` interface (apps/console-v2/src/modules/platform/users.tsx)
--   currently joins organizations and rbac_user_role_assignments via
--   in-memory lookups for these derivations. Moving to a canonical view
--   exposes the canonical SSOT columns AND the FE-shaped projection
--   aliases on the same seam, so the production cutover becomes a
--   single getSupabaseClient() branch flip in
--   `ui_list_resource_v1('user_directory')`.
--
-- Notes:
--   * SSOT remains public.users; this view is read-only.
--   * RLS is enforced by the underlying tables (users, organizations,
--     rbac_roles, rbac_user_role_assignments).
--   * Service-role + authenticated SELECT (mirrors W20/W21/W22 paired
--     projection grants).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302200_v_user_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_user_directory;

CREATE VIEW public.v_user_directory AS
WITH active_assignments AS (
  SELECT
    a.user_id,
    COUNT(*)::INT                              AS active_role_count,
    array_agg(DISTINCT r.key ORDER BY r.key)   AS active_role_keys
  FROM public.rbac_user_role_assignments a
  LEFT JOIN public.rbac_roles r ON r.id = a.role_id
  WHERE a.revoked_at IS NULL
  GROUP BY a.user_id
)
SELECT
  u.id,
  u.organization_id,
  u.email,
  u.full_name,
  u.user_type,
  u.status,
  u.access_scope_type,
  u.access_scope_id,
  u.created_at,
  u.last_login_at,
  -- Organization join
  o.name                                                                  AS organization_label,
  o.slug                                                                  AS organization_slug,
  -- Access scope label (resolves to scope_type_registry.scope_type — the
  -- canonical ladder identifier; FE renders an `initcap` of this for the
  -- table chip).
  CASE
    WHEN u.access_scope_type IS NULL THEN NULL
    ELSE initcap(u.access_scope_type)
  END                                                                     AS access_scope_label,
  -- Role rollups
  COALESCE(active_assignments.active_role_count, 0)                       AS active_role_count,
  COALESCE(active_assignments.active_role_keys, ARRAY[]::TEXT[])          AS active_role_keys,
  -- Tier flags (derived; mirror is_platform_user() / current_user_scope_type())
  (u.access_scope_type = 'platform')                                      AS is_platform_user,
  (u.access_scope_type = 'tenant')                                        AS is_tenant_user,
  (u.access_scope_type = 'client')                                        AS is_client_user,
  (u.access_scope_type = 'sender')                                        AS is_sender_user
FROM public.users u
LEFT JOIN public.organizations o ON o.id = u.organization_id
LEFT JOIN active_assignments ON active_assignments.user_id = u.id;

COMMENT ON VIEW public.v_user_directory IS
  'FE-friendly projection of users with organization join (organization_label, organization_slug), access-scope label, active role rollups (active_role_count, active_role_keys), and tier-flag booleans (is_platform_user, is_tenant_user, is_client_user, is_sender_user). Sources: users + organizations + rbac_user_role_assignments + rbac_roles. Read-only; SSOT remains users; mutations go through grant_user_role_v1 / revoke_user_role_v1 / suspend_user_v1 / reactivate_user_v1 / update_user_profile_v1.';

REVOKE ALL ON public.v_user_directory FROM PUBLIC;
REVOKE ALL ON public.v_user_directory FROM anon;
REVOKE ALL ON public.v_user_directory FROM authenticated;
GRANT SELECT ON public.v_user_directory TO authenticated;
GRANT SELECT ON public.v_user_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302200_v_user_directory'));
COMMIT;
