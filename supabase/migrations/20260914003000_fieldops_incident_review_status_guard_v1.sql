-- Keep route-stop incident review open until a dedicated resolution contract exists.
BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.guard_route_stop_incident_review_status_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.task_type_id IS DISTINCT FROM OLD.task_type_id
    AND EXISTS (
      SELECT 1 FROM public.task_types tt
      WHERE tt.id = OLD.task_type_id AND tt.key = 'route_stop_incident_review'
    ) THEN
    RAISE EXCEPTION 'route_stop_incident_resolution_unavailable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IN ('open','pending','assigned','in_progress') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status
      AND NEW.task_type_id IS NOT DISTINCT FROM OLD.task_type_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.task_types tt
    WHERE tt.id = NEW.task_type_id AND tt.key = 'route_stop_incident_review'
  ) THEN
    RAISE EXCEPTION 'route_stop_incident_resolution_unavailable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_route_stop_incident_review_status_v1()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_tasks_guard_route_stop_incident_review_status_v1 ON public.tasks;
CREATE TRIGGER trg_tasks_guard_route_stop_incident_review_status_v1
  BEFORE INSERT OR UPDATE OF status, task_type_id ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_route_stop_incident_review_status_v1();

COMMENT ON FUNCTION public.guard_route_stop_incident_review_status_v1()
  IS 'Blocks non-actionable route-stop incident review status until dedicated resolution is approved.';

COMMIT;
