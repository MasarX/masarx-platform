-- Console V2 webhook shipment-created domain event lineage.
--
-- A succeeded shipment-creating webhook is not operator-complete until the
-- inbox workflow drawer can show the shipment event that was materialized from
-- the workflow path. Keep this as a focused trigger projection instead of
-- adding more responsibilities to the shipment-create handler.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.webhook_inbox_is_shipment_create_intent_v1(
  p_event_type TEXT,
  p_raw_payload JSONB,
  p_transformed_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT lower(btrim(COALESCE(
    NULLIF(p_event_type, ''),
    NULLIF(p_transformed_payload#>>'{event,type}', ''),
    NULLIF(p_raw_payload#>>'{event,type}', ''),
    NULLIF(p_transformed_payload->>'event_type', ''),
    NULLIF(p_raw_payload->>'event_type', ''),
    ''
  ))) IN ('shipment.create', 'shipments.create', 'shipment.created');
$$;

COMMENT ON FUNCTION public.webhook_inbox_is_shipment_create_intent_v1(TEXT, JSONB, JSONB)
  IS 'Returns true only for shipment-create webhook intents that may project shipment.created readback.';

CREATE OR REPLACE FUNCTION public.project_webhook_shipment_created_domain_event_v1(
  p_webhook_id UUID,
  p_shipment_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_link RECORD;
  v_event_id UUID;
BEGIN
  IF p_webhook_id IS NULL OR p_shipment_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
      ws.organization_id,
      wi.id AS webhook_inbox_id,
      wi.webhook_source_id,
      wi.workflow_run_id,
      wi.correlation_id,
      wi.processing_status,
      s.id AS shipment_id,
      s.tracking_number,
      CASE
        WHEN COALESCE(s.metadata->>'workflow_run_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (s.metadata->>'workflow_run_id')::UUID
        ELSE NULL::UUID
      END AS shipment_workflow_run_id
    INTO v_link
    FROM public.webhook_inbox wi
    JOIN public.webhook_sources ws
      ON ws.id = wi.webhook_source_id
    JOIN public.shipments s
      ON s.id = p_shipment_id
     AND s.organization_id = ws.organization_id
   WHERE wi.id = p_webhook_id
     AND wi.workflow_run_id IS NOT NULL
     AND public.webhook_inbox_is_shipment_create_intent_v1(
       wi.event_type,
       wi.raw_payload,
       wi.transformed_payload
     )
   LIMIT 1;

  IF v_link.shipment_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT de.id
    INTO v_event_id
    FROM public.domain_events de
   WHERE de.organization_id = v_link.organization_id
     AND de.event_type = 'shipment.created'
     AND de.resource_type = 'shipment'
     AND de.resource_id = v_link.shipment_id
     AND de.workflow_run_id = v_link.workflow_run_id
     AND de.payload->>'webhook_inbox_id' = v_link.webhook_inbox_id::TEXT
   ORDER BY de.created_at ASC
   LIMIT 1;

  IF v_event_id IS NOT NULL THEN
    RETURN v_event_id;
  END IF;

  INSERT INTO public.domain_events (
    organization_id,
    event_type,
    resource_type,
    resource_id,
    workflow_run_id,
    correlation_id,
    payload,
    status
  )
  VALUES (
    v_link.organization_id,
    'shipment.created',
    'shipment',
    v_link.shipment_id,
    v_link.workflow_run_id,
    v_link.correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'webhook_inbox_id', v_link.webhook_inbox_id,
      'webhook_source_id', v_link.webhook_source_id,
      'shipment_workflow_run_id', v_link.shipment_workflow_run_id,
      'tracking_number', v_link.tracking_number,
      'processing_status', v_link.processing_status
    )),
    'completed'
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION public.project_webhook_shipment_created_domain_event_v1(UUID, UUID)
  IS 'Idempotently projects canonical webhook-created shipment readback into domain_events for the entry workflow drawer.';

CREATE OR REPLACE FUNCTION public.enqueue_webhook_shipment_created_domain_event_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_org_id UUID;
  v_shipment RECORD;
BEGIN
  IF TG_OP <> 'UPDATE'
     OR NEW.processing_status IS DISTINCT FROM 'succeeded'
     OR NEW.workflow_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ws.organization_id
    INTO v_org_id
    FROM public.webhook_sources ws
   WHERE ws.id = NEW.webhook_source_id;

  IF v_org_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT public.webhook_inbox_is_shipment_create_intent_v1(
    NEW.event_type,
    NEW.raw_payload,
    NEW.transformed_payload
  ) THEN
    RETURN NEW;
  END IF;

  SELECT
      s.id,
      s.tracking_number
    INTO v_shipment
    FROM public.shipments s
   WHERE s.organization_id = v_org_id
     AND (
       s.metadata->>'source_webhook_id' = NEW.id::TEXT
       OR s.metadata#>>'{provider_payload,webhook_id}' = NEW.id::TEXT
       OR s.metadata#>>'{webhook,id}' = NEW.id::TEXT
       OR s.metadata#>>'{source,webhook_id}' = NEW.id::TEXT
     )
   ORDER BY
     (s.metadata->>'source_webhook_id' = NEW.id::TEXT) DESC,
     s.updated_at DESC,
     s.created_at DESC
   LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.project_webhook_shipment_created_domain_event_v1(NEW.id, v_shipment.id);

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_webhook_shipment_created_domain_event_from_shipment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_webhook_id UUID;
BEGIN
  v_webhook_id := CASE
    WHEN COALESCE(NEW.metadata->>'source_webhook_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (NEW.metadata->>'source_webhook_id')::UUID
    WHEN COALESCE(NEW.metadata#>>'{provider_payload,webhook_id}', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (NEW.metadata#>>'{provider_payload,webhook_id}')::UUID
    WHEN COALESCE(NEW.metadata#>>'{webhook,id}', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (NEW.metadata#>>'{webhook,id}')::UUID
    WHEN COALESCE(NEW.metadata#>>'{source,webhook_id}', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (NEW.metadata#>>'{source,webhook_id}')::UUID
    ELSE NULL::UUID
  END;

  IF v_webhook_id IS NOT NULL THEN
    PERFORM public.project_webhook_shipment_created_domain_event_v1(v_webhook_id, NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webhook_inbox_enqueue_shipment_created_domain_event
  ON public.webhook_inbox;

CREATE TRIGGER webhook_inbox_enqueue_shipment_created_domain_event
AFTER UPDATE OF processing_status, processed_at
ON public.webhook_inbox
FOR EACH ROW
WHEN (NEW.processing_status = 'succeeded')
EXECUTE FUNCTION public.enqueue_webhook_shipment_created_domain_event_v1();

COMMENT ON FUNCTION public.enqueue_webhook_shipment_created_domain_event_v1()
  IS 'Projects succeeded shipment-creating webhook inbox rows into domain_events after canonical shipment readback exists.';

DROP TRIGGER IF EXISTS shipments_enqueue_webhook_created_domain_event
  ON public.shipments;

CREATE TRIGGER shipments_enqueue_webhook_created_domain_event
AFTER INSERT OR UPDATE OF metadata
ON public.shipments
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_webhook_shipment_created_domain_event_from_shipment_v1();

COMMENT ON FUNCTION public.enqueue_webhook_shipment_created_domain_event_from_shipment_v1()
  IS 'Projects webhook-created shipment readback into domain_events when shipment metadata carries webhook lineage.';

SELECT public.project_webhook_shipment_created_domain_event_v1(wi.id, s.id)
FROM public.webhook_inbox wi
JOIN public.webhook_sources ws
  ON ws.id = wi.webhook_source_id
JOIN public.shipments s
  ON s.organization_id = ws.organization_id
 AND (
   s.metadata->>'source_webhook_id' = wi.id::TEXT
   OR s.metadata#>>'{provider_payload,webhook_id}' = wi.id::TEXT
   OR s.metadata#>>'{webhook,id}' = wi.id::TEXT
   OR s.metadata#>>'{source,webhook_id}' = wi.id::TEXT
 )
WHERE wi.workflow_run_id IS NOT NULL
  AND public.webhook_inbox_is_shipment_create_intent_v1(
    wi.event_type,
    wi.raw_payload,
    wi.transformed_payload
  );

COMMIT;
