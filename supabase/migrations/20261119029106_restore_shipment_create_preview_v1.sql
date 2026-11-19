BEGIN;
SET LOCAL lock_timeout = '10s';

-- The manual create caller requests previews through metadata.ui.dry_run.
DO $patch$
DECLARE
  v_definition TEXT := pg_get_functiondef('public.ui_create_shipment_v1(uuid,uuid,text,text,text,text,text,jsonb)'::regprocedure);
  v_destination TEXT := '  v_destination_address JSONB := v_metadata->''destination_address'';';
  v_inputs TEXT := $inputs$
  v_offering_id UUID;
  v_recipient_id UUID;
  v_dry_run BOOLEAN := lower(COALESCE(v_metadata#>>'{ui,dry_run}', 'false')) IN ('true', 't', '1', 'yes', 'on');$inputs$;
  v_start TEXT := '  v_run_id := public.start_workflow_run(v_template_id, v_context);';
  v_guard TEXT := $guard$  v_offering_id := NULLIF(btrim(v_metadata->>'service_offering_id'), '')::UUID;
  v_recipient_id := NULLIF(btrim(v_metadata->>'recipient_id'), '')::UUID;

  IF v_offering_id IS NOT NULL THEN
    PERFORM public.resolve_service_offering_context_v1(v_org_id, v_offering_id);
  END IF;

  IF v_recipient_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.recipients r
    WHERE r.id = v_recipient_id AND r.organization_id = v_org_id AND r.client_id = v_client_id
  ) THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 recipient is outside the selected client' USING ERRCODE = '42501';
  END IF;

  IF v_dry_run THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'status', 'shipment_create_preview',
      'dry_run', TRUE,
      'workflow_template_id', v_template_id,
      'correlation_id', v_correlation_id,
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'recipient_id', v_recipient_id,
      'service_type', v_service_type,
      'service_offering_id', v_offering_id,
      'client_reference_number', v_client_reference_number,
      'carrier_reference_number', v_carrier_reference_number,
      'tracking_number', v_tracking_number,
      'tracking_will_be_reserved', v_tracking_number IS NULL,
      'metadata', v_metadata
    ));
  END IF;

  v_context := jsonb_strip_nulls(v_context || jsonb_build_object(
    'recipient_id', v_recipient_id,
    'shipment', NULLIF(jsonb_strip_nulls(jsonb_build_object(
      'cod_amount', v_metadata->'cod_amount',
      'cod_currency', v_metadata->'cod_currency'
    )), '{}'::jsonb)
  ));

$guard$;
BEGIN
  IF position(v_destination IN v_definition) = 0 OR position(v_start IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Shipment create admission boundary changed';
  END IF;
  EXECUTE replace(replace(v_definition, v_destination, v_destination || v_inputs), v_start, v_guard || v_start);
END;
$patch$;

COMMIT;
