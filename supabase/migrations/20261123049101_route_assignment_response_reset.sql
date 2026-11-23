-- Reset stale response fields when an assignment returns to assigned.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.route_run_assignments_normalize_response_state_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF NEW.response_metadata IS NULL OR jsonb_typeof(NEW.response_metadata) IS DISTINCT FROM 'object' THEN
    NEW.response_metadata := '{}'::jsonb;
  END IF;

  NEW.refusal_reason := NULLIF(btrim(COALESCE(NEW.refusal_reason, '')), '');
  NEW.response_notes := NULLIF(btrim(COALESCE(NEW.response_notes, '')), '');

  IF NEW.assignment_status = 'assigned' THEN
    NEW.responded_by_user_id := NULL;
    NEW.acknowledged_at := NULL;
    NEW.accepted_at := NULL;
    NEW.refused_at := NULL;
    NEW.refusal_reason := NULL;
    IF TG_OP = 'UPDATE' THEN
      IF OLD.assignment_status IS DISTINCT FROM 'assigned' THEN
        NEW.response_notes := NULL;
        NEW.response_metadata := '{}'::jsonb;
      END IF;
    END IF;
  ELSIF NEW.assignment_status = 'acknowledged' THEN
    NEW.acknowledged_at := COALESCE(NEW.acknowledged_at, COALESCE(OLD.acknowledged_at, now()));
    NEW.accepted_at := NULL;
    NEW.refused_at := NULL;
    NEW.refusal_reason := NULL;
    NEW.responded_by_user_id := COALESCE(NEW.responded_by_user_id, OLD.responded_by_user_id);
  ELSIF NEW.assignment_status = 'accepted' THEN
    NEW.acknowledged_at := COALESCE(NEW.acknowledged_at, COALESCE(OLD.acknowledged_at, now()));
    NEW.accepted_at := COALESCE(NEW.accepted_at, now());
    NEW.refused_at := NULL;
    NEW.refusal_reason := NULL;
    NEW.responded_by_user_id := COALESCE(NEW.responded_by_user_id, OLD.responded_by_user_id);
  ELSIF NEW.assignment_status = 'refused' THEN
    NEW.refused_at := COALESCE(NEW.refused_at, now());
    NEW.accepted_at := NULL;
    NEW.responded_by_user_id := COALESCE(NEW.responded_by_user_id, OLD.responded_by_user_id);
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
