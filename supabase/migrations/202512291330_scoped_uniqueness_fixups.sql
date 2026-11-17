-- Migration: Scoped uniqueness fixups (multi-tenant readiness)
-- Purpose: relax global-unique human identifiers to the correct scope.
BEGIN;

SELECT pg_advisory_lock(hashtext('202512291330_scoped_uniqueness_fixups'));
SET search_path TO public, pg_temp;

-- webhook_sources: allow same source_identifier across organizations (auth_token_hash remains globally unique).
ALTER TABLE public.webhook_sources
  DROP CONSTRAINT IF EXISTS webhook_sources_source_identifier_key;
ALTER TABLE public.webhook_sources
  ADD CONSTRAINT webhook_sources_org_source_identifier_key
  UNIQUE (organization_id, source_identifier);

-- message_templates: allow same template_name across organizations.
ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_template_name_key;
ALTER TABLE public.message_templates
  ADD CONSTRAINT message_templates_org_template_name_key
  UNIQUE (organization_id, template_name);

-- alert_rules: allow same rule_name across organizations.
ALTER TABLE public.alert_rules
  DROP CONSTRAINT IF EXISTS alert_rules_rule_name_key;
ALTER TABLE public.alert_rules
  ADD CONSTRAINT alert_rules_org_rule_name_key
  UNIQUE (organization_id, rule_name);

SELECT pg_advisory_unlock(hashtext('202512291330_scoped_uniqueness_fixups'));

COMMIT;

