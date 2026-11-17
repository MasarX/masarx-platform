-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: FK index hygiene for enterprise ops tables (pgTAP 0zz_fk_index_hygiene)
-- Why: Enterprise posture requires supporting indexes for all foreign keys.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- driver_compliance_events.actor_user_id -> users(id)
CREATE INDEX IF NOT EXISTS idx_driver_compliance_events_actor_user_id
  ON public.driver_compliance_events (actor_user_id, created_at DESC);

-- driver_profiles.user_id -> users(id)
CREATE INDEX IF NOT EXISTS idx_driver_profiles_user_id
  ON public.driver_profiles (user_id);

-- driver_documents.* -> users/artifacts
CREATE INDEX IF NOT EXISTS idx_driver_documents_user_id
  ON public.driver_documents (user_id);

CREATE INDEX IF NOT EXISTS idx_driver_documents_verified_by_user_id
  ON public.driver_documents (verified_by_user_id);

CREATE INDEX IF NOT EXISTS idx_driver_documents_artifact_id
  ON public.driver_documents (artifact_id);

-- vehicle_events.* -> users/artifacts
CREATE INDEX IF NOT EXISTS idx_vehicle_events_actor_user_id
  ON public.vehicle_events (actor_user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_events_artifact_id
  ON public.vehicle_events (artifact_id);

-- warehouse_locations.parent_location_id -> warehouse_locations(id)
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_parent_location_id
  ON public.warehouse_locations (parent_location_id);

COMMIT;

