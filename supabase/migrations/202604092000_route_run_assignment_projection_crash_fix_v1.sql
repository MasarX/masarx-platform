-- Plan: PLAN-202604-b06-route-run-execution-manifest / Step: E03
-- Migration: route_run_assignment_projection_crash_fix_v1
-- Purpose:
--   - Replace the rowtype-based route_run assignment projection helper with a
--     scalar SQL projection so route manifests fail closed to NULL instead of
--     crashing when the canonical assignment row is absent.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604092000_route_run_assignment_projection_crash_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.route_run_assignment_projection_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT CASE
    WHEN $1 IS NULL THEN NULL
    ELSE (
      SELECT jsonb_strip_nulls(
        jsonb_build_object(
          'route_run_assignment_id', rra.id,
          'assignment_status', rra.assignment_status,
          'assignment_mode', rra.assignment_mode,
          'assignment_version', rra.assignment_version,
          'driver_user_id', rra.driver_user_id,
          'vehicle_id', rra.vehicle_id,
          'partner', rra.partner,
          'assigned_by_user_id', rra.assigned_by_user_id,
          'assigned_at', rra.assigned_at,
          'notes', rra.notes,
          'metadata', NULLIF(rra.metadata, '{}'::jsonb),
          'responded_by_user_id', rra.responded_by_user_id,
          'acknowledged_at', rra.acknowledged_at,
          'accepted_at', rra.accepted_at,
          'refused_at', rra.refused_at,
          'refusal_reason', rra.refusal_reason,
          'response_notes', rra.response_notes,
          'response_metadata', NULLIF(rra.response_metadata, '{}'::jsonb)
        )
      )
      FROM public.route_run_assignments rra
      WHERE rra.route_run_id = $1
      ORDER BY rra.assignment_version DESC, rra.assigned_at DESC, rra.id DESC
      LIMIT 1
    )
  END;
$function$;

COMMENT ON FUNCTION public.route_run_assignment_projection_v1(UUID)
  IS 'Canonical JSON projection of the current route_run assignment state from route_run_assignments. Returns NULL when no canonical assignment row exists.';

REVOKE ALL ON FUNCTION public.route_run_assignment_projection_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_assignment_projection_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_run_assignment_projection_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_run_assignment_projection_v1(UUID) TO service_role;

SELECT pg_advisory_unlock(hashtext('202604092000_route_run_assignment_projection_crash_fix_v1'));
COMMIT;
