-- Plan: PLAN-202601-frontend-ui-ux-coverage-gap-closure / Step: S04
-- Migration: Explicitly revoke anon EXECUTE on UI telemetry RPCs
BEGIN;
SELECT pg_advisory_lock(hashtext('202601162030_ui_event_log_revoke_anon'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.ui_log_event_v1(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_log_event_v1(JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_log_event_v1(JSONB, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_log_events_v1(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_log_events_v1(JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_log_events_v1(JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601162030_ui_event_log_revoke_anon'));
COMMIT;
