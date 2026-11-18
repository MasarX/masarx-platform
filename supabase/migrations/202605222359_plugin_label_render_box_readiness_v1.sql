-- Console V2 Label Designer / Plugin Studio: make shipment label rendering
-- resilient when shipment materialization created box_count but not box rows.

BEGIN;

-- The compose change is applied after the canonical caller-authority migration.

SELECT pg_advisory_lock(hashtext('202605222359_plugin_label_render_box_readiness_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $complete_patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$        IF v_effective_box_id IS NULL THEN
            SELECT COUNT(*)::int
              INTO v_box_count
              FROM public.shipment_boxes sb
             WHERE sb.shipment_id = v_job.shipment_id;

            IF v_box_count = 1 THEN
$from$;
  v_to TEXT := $to$        IF v_effective_box_id IS NULL THEN
            PERFORM public.ensure_shipment_boxes(v_job.shipment_id);

            SELECT COUNT(*)::int
              INTO v_box_count
              FROM public.shipment_boxes sb
             WHERE sb.shipment_id = v_job.shipment_id;

            IF v_box_count = 1 THEN
$to$;
BEGIN
  SELECT pg_get_functiondef('public.complete_label_job_shipment_v1(uuid,text,text,integer,jsonb,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'complete_label_job_shipment_v1(uuid,text,text,integer,jsonb,text) definition not found';
  END IF;

  IF position('ensure_shipment_boxes(v_job.shipment_id' IN v_def) = 0 THEN
    IF position(v_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'complete_label_job_shipment_v1 box readiness marker not found';
    END IF;
    v_def := replace(v_def, v_from, v_to);
    EXECUTE v_def;
  END IF;
END;
$complete_patch$;

DO $complete_multibox_guard_patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$    IF lower(p_status) = 'succeeded'
       AND v_job.shipment_id IS NOT NULL
       AND NOT (lower(v_job.status) = 'succeeded' AND v_job.completed_at IS NOT NULL) THEN
        SELECT sb.id, sb.barcode
$from$;
  v_to TEXT := $to$    IF lower(p_status) = 'succeeded'
       AND v_job.shipment_id IS NOT NULL
       AND NOT (lower(v_job.status) = 'succeeded' AND v_job.completed_at IS NOT NULL) THEN
        IF COALESCE(v_job.shipment_box_id, v_job.target_box_id) IS NULL THEN
            PERFORM public.ensure_shipment_boxes(v_job.shipment_id);

            SELECT COUNT(*)::int
              INTO v_box_count
              FROM public.shipment_boxes sb
             WHERE sb.shipment_id = v_job.shipment_id;

            IF v_box_count > 1 THEN
                RAISE EXCEPTION 'Shipment label job % requires shipment_box_id for multi-box shipment %',
                    p_job_id, v_job.shipment_id;
            END IF;
        END IF;

        SELECT sb.id, sb.barcode
$to$;
BEGIN
  SELECT pg_get_functiondef('public.complete_label_job_shipment_v1(uuid,text,text,integer,jsonb,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'complete_label_job_shipment_v1(uuid,text,text,integer,jsonb,text) definition not found';
  END IF;

  IF position('IF COALESCE(v_job.shipment_box_id, v_job.target_box_id) IS NULL THEN' IN v_def) = 0 THEN
    IF position(v_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'complete_label_job_shipment_v1 multi-box guard marker not found';
    END IF;
    v_def := replace(v_def, v_from, v_to);
    EXECUTE v_def;
  END IF;
END;
$complete_multibox_guard_patch$;

DO $public_complete_multibox_guard_patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$        SELECT sb.id, sb.barcode
          INTO v_effective_box_id, v_effective_barcode
$from$;
  v_to TEXT := $to$        IF COALESCE(v_job.shipment_box_id, v_job.target_box_id) IS NULL THEN
            PERFORM public.ensure_shipment_boxes(v_job.shipment_id);

            SELECT COUNT(*)::int
              INTO v_box_count
              FROM public.shipment_boxes sb
             WHERE sb.shipment_id = v_job.shipment_id;

            IF v_box_count > 1 THEN
                RAISE EXCEPTION 'Shipment label job % requires shipment_box_id for multi-box shipment %',
                    p_job_id, v_job.shipment_id;
            END IF;
        END IF;

        SELECT sb.id, sb.barcode
          INTO v_effective_box_id, v_effective_barcode
$to$;
BEGIN
  SELECT pg_get_functiondef('public.complete_label_job(uuid,text,text,integer,jsonb,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'complete_label_job(uuid,text,text,integer,jsonb,text) definition not found';
  END IF;

  IF position('IF COALESCE(v_job.shipment_box_id, v_job.target_box_id) IS NULL THEN' IN v_def) = 0 THEN
    IF position(v_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'complete_label_job multi-box guard marker not found';
    END IF;
    v_def := replace(v_def, v_from, v_to);
    EXECUTE v_def;
  END IF;
END;
$public_complete_multibox_guard_patch$;

COMMENT ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
  IS 'Completes label render jobs and materializes shipment label rows with canonical one-box shipment box readiness while failing closed for multi-box shipment jobs missing explicit shipment_box_id.';

COMMENT ON FUNCTION public.complete_label_job_shipment_v1(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
  IS 'Direct shipment label completion wrapper that normalizes renderer output to canonical shipment-box barcode identity and materializes missing shipment_boxes before one-box completion.';

SELECT pg_advisory_unlock(hashtext('202605222359_plugin_label_render_box_readiness_v1'));

COMMIT;
