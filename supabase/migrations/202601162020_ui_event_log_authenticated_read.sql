-- Plan: PLAN-202601-frontend-ui-ux-coverage-gap-closure / Step: S04
-- Migration: Add authenticated read policy for ui_event_log
BEGIN;
SELECT pg_advisory_lock(hashtext('202601162020_ui_event_log_authenticated_read'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.ui_event_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ui_event_log_authenticated_read ON public.ui_event_log;
CREATE POLICY ui_event_log_authenticated_read
  ON public.ui_event_log
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_capability_v1('audit_log.read')
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

SELECT pg_advisory_unlock(hashtext('202601162020_ui_event_log_authenticated_read'));
COMMIT;
