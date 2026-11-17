-- Migration: route run assignment response FK index compat v1
-- Purpose:
--   - Backfill the FK-supporting index for route_run_assignments.responded_by_user_id
--   - Keep UC080 response lifecycle compliant with enterprise FK hygiene on existing databases.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604071040_route_run_assignment_response_fk_index_compat_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_route_run_assignments_responded_by_user
  ON public.route_run_assignments (responded_by_user_id, updated_at DESC);

SELECT pg_advisory_unlock(hashtext('202604071040_route_run_assignment_response_fk_index_compat_v1'));
COMMIT;
