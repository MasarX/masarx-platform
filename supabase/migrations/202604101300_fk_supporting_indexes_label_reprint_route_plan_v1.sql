-- Migration: FK supporting indexes for label reprint governance + route plan publish actor
-- Purpose:
--   - Satisfy FK hygiene by ensuring non-partial supporting indexes exist for
--     label reprint lineage tables and route plan publish actor references.
--   - Keep the index contract explicit for composite foreign keys that are not
--     covered by existing unique or partial indexes.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_label_jobs__source_label_version_id__fk
  ON public.label_jobs (source_label_version_id);

CREATE INDEX IF NOT EXISTS idx_labels__active_version_id__fk
  ON public.labels (active_version_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__organization_id__fk
  ON public.label_versions (organization_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__client_id__fk
  ON public.label_versions (client_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__label_id__shipment_id__fk
  ON public.label_versions (label_id, shipment_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__label_job_id__organization_id__fk
  ON public.label_versions (label_job_id, organization_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__layout_template_id__organization_id__fk
  ON public.label_versions (layout_template_id, organization_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__supersedes_version_id__fk
  ON public.label_versions (supersedes_version_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__superseded_by_version_id__fk
  ON public.label_versions (superseded_by_version_id);

CREATE INDEX IF NOT EXISTS idx_route_plans__published_by_user_id__fk_full
  ON public.route_plans (published_by_user_id);

COMMIT;
