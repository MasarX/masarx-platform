-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S04
-- Fix workflow_handlers.record_shipment_action_v1 to populate shipment child scope columns.

CREATE OR REPLACE FUNCTION workflow_handlers.record_shipment_action_v1(
  p_shipment_id UUID,
  p_action_type TEXT,
  p_action_category TEXT,
  p_action_data JSONB DEFAULT '{}'::jsonb,
  p_notes TEXT DEFAULT NULL,
  p_canonical_status TEXT DEFAULT NULL,
  p_performed_by_system TEXT DEFAULT 'workflow_handlers',
  p_assigned_to UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_action_id UUID;
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(p_action_data->>'idempotency_key', '')), '');
  v_shipment RECORD;
BEGIN
  IF p_shipment_id IS NULL OR NULLIF(btrim(COALESCE(p_action_type, '')), '') IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.id, s.organization_id, s.client_id
    INTO v_shipment
    FROM public.shipments s
   WHERE s.id = p_shipment_id
   LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT sa.id
      INTO v_action_id
      FROM public.shipment_actions sa
     WHERE sa.shipment_id = p_shipment_id
       AND sa.action_type = p_action_type
       AND sa.action_category = p_action_category
       AND sa.action_data->>'idempotency_key' = v_idempotency_key
     ORDER BY sa.created_at DESC
     LIMIT 1;

    IF v_action_id IS NOT NULL THEN
      RETURN v_action_id;
    END IF;
  END IF;

  INSERT INTO public.shipment_actions (
    shipment_id,
    action_type,
    action_category,
    canonical_status,
    assigned_to,
    performed_by_system,
    action_data,
    notes,
    timestamp,
    created_at,
    organization_id,
    client_id
  ) VALUES (
    p_shipment_id,
    p_action_type,
    p_action_category,
    p_canonical_status,
    p_assigned_to,
    p_performed_by_system,
    COALESCE(p_action_data, '{}'::jsonb),
    p_notes,
    now(),
    now(),
    v_shipment.organization_id,
    v_shipment.client_id
  )
  RETURNING id INTO v_action_id;

  RETURN v_action_id;
END;
$function$;
