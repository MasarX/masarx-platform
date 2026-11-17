-- Plan: PLAN-202604-b06-closeout / Step: Allow label cleanup without orphaning shipment history

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102250_uc078_label_versions_label_cleanup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.label_versions
  DROP CONSTRAINT IF EXISTS label_versions_label_fk;

ALTER TABLE public.label_versions
  ALTER COLUMN label_id DROP NOT NULL;

ALTER TABLE public.label_versions
  ADD CONSTRAINT label_versions_label_fk
    FOREIGN KEY (label_id, shipment_id)
    REFERENCES public.labels(id, shipment_id)
    ON DELETE SET NULL (label_id)
    DEFERRABLE INITIALLY DEFERRED;

SELECT pg_advisory_unlock(hashtext('202604102250_uc078_label_versions_label_cleanup_v1'));

COMMIT;
