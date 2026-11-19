-- Preserve the Console V2 label paths after the canonical caller-authority correction.
BEGIN;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_definition TEXT;
  v_compose_anchor CONSTANT TEXT := $anchor$  IF v_job.shipment_id IS NOT NULL THEN
    SELECT to_jsonb(payload)
$anchor$;
  v_compose_replacement CONSTANT TEXT := $replacement$  IF v_job.shipment_id IS NOT NULL THEN
    PERFORM public.ensure_shipment_boxes(v_job.shipment_id);

    IF COALESCE(v_job.shipment_box_id, v_job.target_box_id) IS NULL
       AND (
         SELECT COUNT(*)::int
           FROM public.shipment_boxes sb
          WHERE sb.shipment_id = v_job.shipment_id
       ) > 1 THEN
      RAISE EXCEPTION 'Shipment label job % requires shipment_box_id for multi-box shipment %',
        p_job_id, v_job.shipment_id;
    END IF;

    SELECT to_jsonb(payload)
$replacement$;
  v_reprint_anchor CONSTANT TEXT := $anchor$    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label % not found', p_label_id;
    END IF;
$anchor$;
  v_reprint_replacement CONSTANT TEXT := $replacement$    IF NOT FOUND THEN
        RETURN public.request_label_artifact_reprint_v1(
            p_label_id, p_reprint_reason, p_actor_id, p_requested_source, v_is_privileged
        );
    END IF;
$replacement$;
BEGIN
  v_definition := replace(pg_get_functiondef('public.compose_label_payload(uuid)'::regprocedure), E'\r\n', E'\n');
  IF length(v_definition) - length(replace(v_definition, v_compose_anchor, '')) <> length(v_compose_anchor) THEN
    RAISE EXCEPTION 'Expected one shipment payload entry point in compose_label_payload';
  END IF;
  EXECUTE replace(v_definition, v_compose_anchor, v_compose_replacement);

  v_definition := replace(pg_get_functiondef('public.request_label_reprint(uuid,text,uuid,text)'::regprocedure), E'\r\n', E'\n');
  IF length(v_definition) - length(replace(v_definition, v_reprint_anchor, '')) <> length(v_reprint_anchor) THEN
    RAISE EXCEPTION 'Expected one shipment label lookup in request_label_reprint';
  END IF;
  EXECUTE replace(v_definition, v_reprint_anchor, v_reprint_replacement);
END;
$patch$;

COMMENT ON FUNCTION public.compose_label_payload(UUID)
  IS 'Composes label render payloads with row-driven render and print policy enrichment and canonical shipment box readiness.';

COMMENT ON FUNCTION public.request_label_reprint(UUID, TEXT, UUID, TEXT)
  IS 'Queues a reprint for shipment labels or target-neutral artifacts after checking caller authority and preserving source lineage.';

COMMIT;
