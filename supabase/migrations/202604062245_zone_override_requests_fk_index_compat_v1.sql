-- Migration: zone_override_requests foreign-key index compat v1
-- Purpose:
--   - Add full supporting indexes for zone_override_requests foreign keys so
--     FK hygiene gates remain green and delete/update paths stay efficient.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_zone_override_requests_manual_review_task_fk
  ON public.zone_override_requests (manual_review_task_id);

CREATE INDEX IF NOT EXISTS idx_zone_override_requests_organization_fk
  ON public.zone_override_requests (organization_id);

CREATE INDEX IF NOT EXISTS idx_zone_override_requests_workflow_run_fk
  ON public.zone_override_requests (workflow_run_id);

COMMIT;
