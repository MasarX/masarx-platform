-- Migration: Observability RLS policies for authenticated reads
BEGIN;
SELECT pg_advisory_lock(hashtext('202601041220_observability_rls_policies'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.decision_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings_resolution_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS decision_log_authenticated_read ON public.decision_log;
CREATE POLICY decision_log_authenticated_read
  ON public.decision_log
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_capability_v1('audit_log.read')
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS settings_resolution_log_authenticated_read ON public.settings_resolution_log;
CREATE POLICY settings_resolution_log_authenticated_read
  ON public.settings_resolution_log
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_capability_v1('settings.read')
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

SELECT pg_advisory_unlock(hashtext('202601041220_observability_rls_policies'));
COMMIT;
