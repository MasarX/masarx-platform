-- Plan: PLAN-202604-b06-closeout / Step: Fix label_versions cleanup FK on the live database

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102240_uc078_label_versions_fk_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.label_versions
  DROP CONSTRAINT IF EXISTS label_versions_label_job_fk;

ALTER TABLE public.label_versions
  ADD CONSTRAINT label_versions_label_job_fk
    FOREIGN KEY (label_job_id, organization_id)
    REFERENCES public.label_jobs(id, organization_id)
    ON DELETE SET NULL (label_job_id)
    DEFERRABLE INITIALLY DEFERRED;

SELECT pg_advisory_unlock(hashtext('202604102240_uc078_label_versions_fk_fix_v1'));

COMMIT;
