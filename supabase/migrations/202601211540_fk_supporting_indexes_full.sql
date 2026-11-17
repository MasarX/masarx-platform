-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Ensure FK supporting indexes are full (non-partial) per 0zz_fk_index_hygiene.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- FK: label_jobs(label_id, shipment_id) -> labels(id, shipment_id)
DROP INDEX IF EXISTS public.idx_label_jobs__label_id__shipment_id__fk;
CREATE INDEX IF NOT EXISTS idx_label_jobs__label_id__shipment_id__fk
  ON public.label_jobs (label_id, shipment_id);

-- FK: labels(layout_template_id, organization_id) -> label_template_specs(id, organization_id)
DROP INDEX IF EXISTS public.idx_labels__layout_template_id__organization_id__fk;
CREATE INDEX IF NOT EXISTS idx_labels__layout_template_id__organization_id__fk
  ON public.labels (layout_template_id, organization_id);

-- FK: alert_rules(message_template_id, organization_id) -> message_templates(id, organization_id)
DROP INDEX IF EXISTS public.idx_alert_rules__message_template_id__organization_id__fk;
CREATE INDEX IF NOT EXISTS idx_alert_rules__message_template_id__organization_id__fk
  ON public.alert_rules (message_template_id, organization_id);

COMMIT;

