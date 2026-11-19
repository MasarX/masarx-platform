-- Migration: Console V2 shipment planning projection v1
-- Purpose:
--   Project validated shipment planning metadata onto canonical shipment
--   planning columns so Console-created manual shipments can flow directly
--   into route-plan candidate selection.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605072005_console_v2_shipment_planning_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.apply_shipment_planning_projection_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_meta jsonb := COALESCE(NEW.metadata, '{}'::jsonb);
  v_promised_delivery_date date;
  v_promised_window_start_at timestamptz;
  v_promised_window_end_at timestamptz;
  v_priority_score numeric;
BEGIN
  IF jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;

  IF NULLIF(v_meta->>'promised_delivery_date', '') IS NOT NULL THEN
    BEGIN
      v_promised_delivery_date := (v_meta->>'promised_delivery_date')::date;
    EXCEPTION WHEN invalid_datetime_format THEN
      RAISE EXCEPTION 'shipments.metadata.promised_delivery_date must be a date'
        USING ERRCODE = '22023';
    END;
    NEW.promised_delivery_date := COALESCE(NEW.promised_delivery_date, v_promised_delivery_date);
  END IF;

  IF NULLIF(v_meta->>'promised_window_start_at', '') IS NOT NULL THEN
    BEGIN
      v_promised_window_start_at := (v_meta->>'promised_window_start_at')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format THEN
      RAISE EXCEPTION 'shipments.metadata.promised_window_start_at must be a timestamptz'
        USING ERRCODE = '22023';
    END;
    NEW.promised_window_start_at := COALESCE(NEW.promised_window_start_at, v_promised_window_start_at);
  END IF;

  IF NULLIF(v_meta->>'promised_window_end_at', '') IS NOT NULL THEN
    BEGIN
      v_promised_window_end_at := (v_meta->>'promised_window_end_at')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format THEN
      RAISE EXCEPTION 'shipments.metadata.promised_window_end_at must be a timestamptz'
        USING ERRCODE = '22023';
    END;
    NEW.promised_window_end_at := COALESCE(NEW.promised_window_end_at, v_promised_window_end_at);
  END IF;

  IF NULLIF(v_meta->>'priority_score', '') IS NOT NULL THEN
    BEGIN
      v_priority_score := (v_meta->>'priority_score')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'shipments.metadata.priority_score must be numeric'
        USING ERRCODE = '22023';
    END;
    NEW.priority_score := COALESCE(NEW.priority_score, v_priority_score);
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_shipments_planning_projection_v1 ON public.shipments;
CREATE TRIGGER trg_shipments_planning_projection_v1
BEFORE INSERT OR UPDATE OF metadata, promised_delivery_date, promised_window_start_at, promised_window_end_at, priority_score
ON public.shipments
FOR EACH ROW
EXECUTE FUNCTION public.apply_shipment_planning_projection_v1();

COMMENT ON FUNCTION public.apply_shipment_planning_projection_v1()
  IS 'Projects validated planning metadata on shipments into canonical promised date/window/priority columns used by route planning.';
COMMENT ON TRIGGER trg_shipments_planning_projection_v1 ON public.shipments
  IS 'Keeps Console-created manual shipment planning metadata visible to route-plan candidate selection.';

SELECT pg_advisory_unlock(hashtext('202605072005_console_v2_shipment_planning_projection_v1'));
COMMIT;
