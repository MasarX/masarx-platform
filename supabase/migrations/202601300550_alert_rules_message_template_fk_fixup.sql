-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- Fixup: Ensure alert_rules.message_template_id references message_templates (org-scoped FK).
-- Why: pgTAP expects `alert_rules_message_template_fk` to exist; remote drift can leave it missing.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- The FK depends on the composite UNIQUE constraint, so drop it first to allow idempotent redefinition.
ALTER TABLE public.alert_rules
  DROP CONSTRAINT IF EXISTS alert_rules_message_template_fk;

-- Required for composite FK target.
ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_id_organization_id_key,
  ADD CONSTRAINT message_templates_id_organization_id_key
    UNIQUE (id, organization_id);

-- If any pre-existing rows reference a template outside the org (or a missing template),
-- null the reference before adding the FK to avoid migration failure.
UPDATE public.alert_rules ar
SET message_template_id = NULL
WHERE ar.message_template_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.message_templates mt
    WHERE mt.id = ar.message_template_id
      AND mt.organization_id = ar.organization_id
  );

CREATE INDEX IF NOT EXISTS idx_alert_rules__message_template_id__organization_id__fk
  ON public.alert_rules (message_template_id, organization_id)
  WHERE message_template_id IS NOT NULL;

ALTER TABLE public.alert_rules
  DROP CONSTRAINT IF EXISTS alert_rules_message_template_fk,
  ADD CONSTRAINT alert_rules_message_template_fk
    FOREIGN KEY (message_template_id, organization_id)
    REFERENCES public.message_templates(id, organization_id)
    DEFERRABLE INITIALLY DEFERRED;

COMMIT;
