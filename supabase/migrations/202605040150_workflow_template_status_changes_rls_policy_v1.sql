-- Migration: workflow_template_status_changes service RLS policy
-- Date: 2026-05-03
-- Purpose:
--   Keep the workflow template status-change ledger service-only while
--   satisfying the dependency-driven API view RLS guard.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031350_workflow_template_status_changes_rls_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.workflow_template_status_changes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.workflow_template_status_changes FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_template_status_changes FROM anon;
REVOKE ALL ON TABLE public.workflow_template_status_changes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workflow_template_status_changes TO service_role;

DROP POLICY IF EXISTS workflow_template_status_changes_service_policy
  ON public.workflow_template_status_changes;
CREATE POLICY workflow_template_status_changes_service_policy
  ON public.workflow_template_status_changes
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

COMMENT ON POLICY workflow_template_status_changes_service_policy
  ON public.workflow_template_status_changes
  IS 'Service-only access for workflow template status-change ledger; Console reads through scoped projections/RPCs, not direct table grants.';

SELECT pg_advisory_unlock(hashtext('202605031350_workflow_template_status_changes_rls_policy_v1'));
COMMIT;
