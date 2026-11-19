BEGIN;

CREATE OR REPLACE FUNCTION public.label_jobs_fill_shipment_target_lineage_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
BEGIN
  IF NEW.shipment_id IS NOT NULL THEN
    NEW.target_type := COALESCE(NULLIF(NEW.target_type, ''), 'shipment');
    NEW.target_id := COALESCE(NEW.target_id, NEW.shipment_id);
    NEW.target_box_id := COALESCE(NEW.target_box_id, NEW.shipment_box_id);
    NEW.target_metadata := COALESCE(NEW.target_metadata, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', NEW.shipment_id,
        'shipment_box_id', NEW.shipment_box_id,
        'lineage_source', COALESCE(NULLIF(NEW.target_metadata->>'lineage_source', ''), 'shipment_label_job_guard')
      ));
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_label_jobs_fill_shipment_target_lineage_v1 ON public.label_jobs;

CREATE TRIGGER trg_label_jobs_fill_shipment_target_lineage_v1
BEFORE INSERT OR UPDATE OF shipment_id, shipment_box_id, target_type, target_id, target_box_id, target_metadata
ON public.label_jobs
FOR EACH ROW
EXECUTE FUNCTION public.label_jobs_fill_shipment_target_lineage_v1();

UPDATE public.label_jobs
SET
  target_type = COALESCE(NULLIF(target_type, ''), 'shipment'),
  target_id = COALESCE(target_id, shipment_id),
  target_box_id = COALESCE(target_box_id, shipment_box_id),
  target_metadata = COALESCE(target_metadata, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', shipment_id,
      'shipment_box_id', shipment_box_id,
      'lineage_source', COALESCE(NULLIF(target_metadata->>'lineage_source', ''), 'shipment_label_job_backfill')
    )),
  updated_at = now()
WHERE shipment_id IS NOT NULL
  AND (
    target_type IS NULL
    OR target_id IS NULL
    OR (shipment_box_id IS NOT NULL AND target_box_id IS NULL)
    OR target_metadata IS NULL
    OR target_metadata->>'shipment_id' IS NULL
  );

COMMENT ON FUNCTION public.label_jobs_fill_shipment_target_lineage_v1()
  IS 'Ensures shipment-backed label_jobs retain target-neutral shipment lineage for Console V2 drawers, registry filters, and renderer/readback contracts.';

COMMIT;
