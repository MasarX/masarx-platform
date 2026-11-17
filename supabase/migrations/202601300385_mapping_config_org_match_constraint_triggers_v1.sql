-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Make mapping_config org-match triggers constraint-deferred v1
-- Date: 2026-01-30
--
-- Why:
--   - Some setup/seed/test statements create mapping_configs and webhook_sources/operation_templates
--     in a single statement without explicit CTE dependency ordering.
--   - A BEFORE trigger requires the referenced mapping_config row to exist immediately and can
--     fail even when the row is created later in the statement.
--   - Convert to DEFERRABLE constraint triggers so org-consistency is enforced at commit time,
--     while allowing flexible statement composition.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300385_mapping_config_org_match_constraint_triggers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP TRIGGER IF EXISTS trg_webhook_sources_enforce_mapping_config_org_match ON public.webhook_sources;
CREATE CONSTRAINT TRIGGER trg_webhook_sources_enforce_mapping_config_org_match
  AFTER INSERT OR UPDATE ON public.webhook_sources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.webhook_sources_enforce_mapping_config_org_match_v1();

DROP TRIGGER IF EXISTS trg_operation_templates_enforce_mapping_config_org_match ON public.operation_templates;
CREATE CONSTRAINT TRIGGER trg_operation_templates_enforce_mapping_config_org_match
  AFTER INSERT OR UPDATE ON public.operation_templates
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.operation_templates_enforce_mapping_config_org_match_v1();

SELECT pg_advisory_unlock(hashtext('202601300385_mapping_config_org_match_constraint_triggers_v1'));
COMMIT;

