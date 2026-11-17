-- Migration: workflow template invoker grants v1
-- Purpose:
--   - Restore authenticated access to workflow_templates/workflow_template_steps under
--     ui_* SECURITY INVOKER RPCs while keeping RLS authoritative.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603062220_workflow_template_invoker_grants_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON TABLE public.workflow_templates FROM authenticated;
REVOKE ALL ON TABLE public.workflow_template_steps FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflow_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflow_template_steps TO authenticated;

COMMENT ON TABLE public.workflow_templates
  IS 'Workflow template definitions. Authenticated access is gated by RLS and workflow capability checks.';

COMMENT ON TABLE public.workflow_template_steps
  IS 'Workflow template steps. Authenticated access is gated by parent workflow template RLS and capability checks.';

SELECT pg_advisory_unlock(hashtext('202603062220_workflow_template_invoker_grants_v1'));

COMMIT;
