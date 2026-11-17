-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Add referential integrity for label template usage across label pipeline tables.
-- Goals:
--   - Prevent orphaned label_jobs references (shipment/template/label).
--   - Ensure labels.layout_template_id, when present, references a real template spec for the same organization.
-- Notes:
--   - labels.layout_template_id is nullable; existing orphan values are nulled before adding FK.
--   - Indexes are added to satisfy FK index hygiene tests.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Data fixup: remove orphan label template pointers on labels (pre-live safety)
-- ---------------------------------------------------------------------------
UPDATE public.labels l
SET layout_template_id = NULL
WHERE l.layout_template_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.label_template_specs t
    WHERE t.id = l.layout_template_id
      AND t.organization_id = l.organization_id
  );

-- ---------------------------------------------------------------------------
-- 2) Indexes for new foreign keys
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_label_jobs__shipment_id__client_id__fk
  ON public.label_jobs (shipment_id, client_id);

CREATE INDEX IF NOT EXISTS idx_label_jobs__template_id__organization_id__fk
  ON public.label_jobs (template_id, organization_id);

CREATE INDEX IF NOT EXISTS idx_label_jobs__label_id__shipment_id__fk
  ON public.label_jobs (label_id, shipment_id)
  WHERE label_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_labels__layout_template_id__organization_id__fk
  ON public.labels (layout_template_id, organization_id)
  WHERE layout_template_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) Foreign keys (explicitly named)
-- ---------------------------------------------------------------------------
ALTER TABLE public.label_jobs
  DROP CONSTRAINT IF EXISTS label_jobs_shipment_fk,
  ADD CONSTRAINT label_jobs_shipment_fk
    FOREIGN KEY (shipment_id, client_id)
    REFERENCES public.shipments(id, client_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.label_jobs
  DROP CONSTRAINT IF EXISTS label_jobs_template_fk,
  ADD CONSTRAINT label_jobs_template_fk
    FOREIGN KEY (template_id, organization_id)
    REFERENCES public.label_template_specs(id, organization_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.label_jobs
  DROP CONSTRAINT IF EXISTS label_jobs_label_fk,
  ADD CONSTRAINT label_jobs_label_fk
    FOREIGN KEY (label_id, shipment_id)
    REFERENCES public.labels(id, shipment_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.labels
  DROP CONSTRAINT IF EXISTS labels_layout_template_fk,
  ADD CONSTRAINT labels_layout_template_fk
    FOREIGN KEY (layout_template_id, organization_id)
    REFERENCES public.label_template_specs(id, organization_id)
    DEFERRABLE INITIALLY DEFERRED;

COMMIT;

