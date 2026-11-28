-- Install before the historical migration switches renderer producers to leased jobs.
CREATE OR REPLACE FUNCTION public.hold_renderer_upgrade_job_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
BEGIN
  -- The tagged table does not have renderer_request_id yet.
  IF NEW.status = 'pending_edge' AND to_jsonb(NEW)->>'renderer_request_id' IS NOT NULL THEN
    NEW.scheduled_at := 'infinity';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.hold_renderer_upgrade_job_v1() FROM PUBLIC, anon, authenticated, service_role;
DO $grant$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.hold_renderer_upgrade_job_v1() TO %I', current_user);
END;
$grant$;

CREATE OR REPLACE TRIGGER hold_renderer_upgrade_job_v1
BEFORE INSERT ON public.outbound_calls
FOR EACH ROW EXECUTE FUNCTION public.hold_renderer_upgrade_job_v1();
