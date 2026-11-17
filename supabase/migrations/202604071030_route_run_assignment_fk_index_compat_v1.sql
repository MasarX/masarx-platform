-- Migration: route run assignment FK index compat v1
-- Purpose:
--   - Backfill enterprise FK-supporting indexes for route-run assignment tables already deployed by UC076.
--   - Keep existing databases compliant with pgTAP FK hygiene without rewriting historical migrations.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604071030_route_run_assignment_fk_index_compat_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_route_run_assignments_driver_user
  ON public.route_run_assignments (driver_user_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_run_assignments_vehicle
  ON public.route_run_assignments (vehicle_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_run_assignments_assigned_by_user
  ON public.route_run_assignments (assigned_by_user_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_run_assignment_events_org_created
  ON public.route_run_assignment_events (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_run_assignment_events_driver_user
  ON public.route_run_assignment_events (driver_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_run_assignment_events_vehicle
  ON public.route_run_assignment_events (vehicle_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_run_assignment_events_actor_user
  ON public.route_run_assignment_events (actor_user_id, created_at DESC);

SELECT pg_advisory_unlock(hashtext('202604071030_route_run_assignment_fk_index_compat_v1'));
COMMIT;
