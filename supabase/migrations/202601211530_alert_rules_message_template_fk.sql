-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Enforce organization-scoped message template references from alert_rules.
-- Notes:
--   - Uses a composite FK (message_template_id, organization_id) -> message_templates(id, organization_id)
--     to prevent cross-tenant references.
--   - Requires a matching UNIQUE constraint on message_templates (id, organization_id).

BEGIN;

SET search_path TO public, extensions, pg_temp;

ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_id_organization_id_key,
  ADD CONSTRAINT message_templates_id_organization_id_key
    UNIQUE (id, organization_id);

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

