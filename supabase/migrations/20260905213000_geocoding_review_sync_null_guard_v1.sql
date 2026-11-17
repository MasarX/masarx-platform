-- Restore the existing geocoding NULL contract at the current wrapper boundary.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT pg_advisory_xact_lock(hashtext('20260905213000_geocoding_review_sync_null_guard_v1'));

CREATE OR REPLACE FUNCTION public.geocoding_manual_review_queue_task_sync_v1(
  p_manual_review_task_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_review public.manual_review_tasks%ROWTYPE;
  v_shipment public.shipments%ROWTYPE;
  v_shipment_id UUID;
BEGIN
  IF p_manual_review_task_id IS NULL THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 requires manual_review_task_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_review
  FROM public.manual_review_tasks mrt
  WHERE mrt.id = p_manual_review_task_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_shipment_id := COALESCE(
    v_review.shipment_id,
    CASE WHEN lower(COALESCE(v_review.resource_type, '')) = 'shipment' THEN v_review.resource_id END
  );
  IF v_shipment_id IS NOT NULL THEN
    SELECT * INTO v_shipment
    FROM public.shipments sh
    WHERE sh.id = v_shipment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'manual-review shipment % is unavailable', v_shipment_id USING ERRCODE = '23514';
    END IF;
    IF v_review.organization_id IS NOT NULL
       AND v_review.organization_id IS DISTINCT FROM v_shipment.organization_id THEN
      RAISE EXCEPTION 'manual-review organization lineage conflicts with shipment %', v_shipment_id USING ERRCODE = '23514';
    END IF;
    IF v_review.client_id IS NOT NULL
       AND v_review.client_id IS DISTINCT FROM v_shipment.client_id THEN
      RAISE EXCEPTION 'manual-review client lineage conflicts with shipment %', v_shipment_id USING ERRCODE = '23514';
    END IF;
    IF v_review.sender_id IS NOT NULL
       AND v_review.sender_id IS DISTINCT FROM v_shipment.sender_id THEN
      RAISE EXCEPTION 'manual-review sender lineage conflicts with shipment %', v_shipment_id USING ERRCODE = '23514';
    END IF;
    UPDATE public.manual_review_tasks
    SET organization_id = COALESCE(v_review.organization_id, v_shipment.organization_id),
        client_id = COALESCE(v_review.client_id, v_shipment.client_id),
        sender_id = COALESCE(v_review.sender_id, v_shipment.sender_id),
        shipment_id = COALESCE(v_review.shipment_id, v_shipment.id),
        updated_at = now()
    WHERE id = p_manual_review_task_id;
  END IF;
  RETURN public.geocoding_manual_review_queue_task_sync_v1_base_202608161870(
    p_manual_review_task_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID)
  TO service_role;

COMMIT;
