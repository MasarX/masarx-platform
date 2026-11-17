-- Migration: reconcile FK support indexes for recent label/route additions
-- Purpose:
--   - Satisfy the enterprise FK hygiene contract for new label reprint and route-plan
--     publish foreign keys on the current UC079 schema.
--   - Keep the route-stop reassignment index backfill conditional because that table
--     can exist in drifted local worktrees before the UC078 migration lands here.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102060_fk_index_hygiene_label_route_publish_reassignment_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_label_jobs__source_label_version_id__fk
  ON ONLY public.label_jobs (source_label_version_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__client_id__fk
  ON public.label_versions (client_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__label_id__shipment_id__fk
  ON public.label_versions (label_id, shipment_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__label_job_id__organization_id__fk
  ON public.label_versions (label_job_id, organization_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__layout_template_id__organization_id__fk
  ON public.label_versions (layout_template_id, organization_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__organization_id__fk
  ON public.label_versions (organization_id);

CREATE INDEX IF NOT EXISTS idx_label_versions__superseded_by_version_id__fk
  ON public.label_versions (superseded_by_version_id);

DROP INDEX IF EXISTS public.idx_label_versions_supersedes;
CREATE INDEX IF NOT EXISTS idx_label_versions_supersedes
  ON public.label_versions (supersedes_version_id);

CREATE INDEX IF NOT EXISTS idx_labels__active_version_id__fk
  ON ONLY public.labels (active_version_id);

DROP INDEX IF EXISTS public.idx_route_plans__published_by_user_id__fk;
CREATE INDEX IF NOT EXISTS idx_route_plans__published_by_user_id__fk
  ON public.route_plans (published_by_user_id);

DO $do$
BEGIN
  IF to_regclass('public.route_stop_reassignment_events') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE '
    CREATE INDEX IF NOT EXISTS idx_route_stop_reassignment_events__source_route_run_assignment_id__fk
      ON public.route_stop_reassignment_events (source_route_run_assignment_id)
  ';

  EXECUTE '
    CREATE INDEX IF NOT EXISTS idx_route_stop_reassignment_events__target_route_run_assignment_id__fk
      ON public.route_stop_reassignment_events (target_route_run_assignment_id)
  ';

  EXECUTE '
    CREATE INDEX IF NOT EXISTS idx_route_stop_reassignment_events__actor_user_id__fk
      ON public.route_stop_reassignment_events (actor_user_id)
  ';

  EXECUTE '
    CREATE INDEX IF NOT EXISTS idx_route_stop_reassignment_events__client_id__fk
      ON public.route_stop_reassignment_events (client_id)
  ';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604102060_fk_index_hygiene_label_route_publish_reassignment_v1'));

COMMIT;
