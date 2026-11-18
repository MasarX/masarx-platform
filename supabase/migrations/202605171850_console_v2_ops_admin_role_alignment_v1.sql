BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH candidate_ops_admins AS (
  SELECT
    u.organization_id,
    u.id AS user_id,
    r.id AS role_id
  FROM public.users u
  JOIN public.rbac_roles r
    ON r.organization_id = u.organization_id
   AND r.key = u.user_type
   AND r.is_active IS TRUE
  WHERE u.status = 'active'
    AND u.user_type = 'ops_admin'
    AND NOT EXISTS (
      SELECT 1
      FROM public.rbac_user_role_assignments a
      WHERE a.organization_id = u.organization_id
        AND a.user_id = u.id
        AND a.role_id = r.id
        AND a.revoked_at IS NULL
    )
)
INSERT INTO public.rbac_user_role_assignments (
  organization_id,
  user_id,
  role_id,
  assigned_by_user_id,
  metadata
)
SELECT
  organization_id,
  user_id,
  role_id,
  NULL,
  jsonb_build_object(
    'source', 'console_v2_ops_admin_role_alignment_v1',
    'user_type', 'ops_admin'
  )
FROM candidate_ops_admins
ON CONFLICT (organization_id, user_id, role_id) WHERE revoked_at IS NULL
DO UPDATE SET
  metadata = public.rbac_user_role_assignments.metadata || EXCLUDED.metadata,
  updated_at = now();

COMMIT;
