BEGIN;

REVOKE ALL ON public.v_alert_trigger_summary FROM PUBLIC;
REVOKE ALL ON public.v_alert_trigger_summary FROM anon;
REVOKE ALL ON public.v_alert_trigger_summary FROM authenticated;
GRANT SELECT ON public.v_alert_trigger_summary TO service_role;

COMMIT;
