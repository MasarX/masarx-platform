BEGIN;
SET LOCAL lock_timeout = '10s';

-- Only webhook shipment creation requires both parties to be materialized here.
DO $patch$
DECLARE
  v_definition TEXT := pg_get_functiondef(
    'workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure
  );
  v_marker TEXT := '    IF jsonb_typeof(v_resource->''references'') = ''object'' THEN';
  v_guard TEXT := $guard$    IF v_metadata_source IS NOT NULL
       AND (v_recipient_id IS NULL OR v_destination_address_id IS NULL) THEN
      v_result.status := 'failed';
      v_result.last_error := 'execute_shipment_create_v1: missing required webhook shipment recipient/address';
      v_result.operation_result := jsonb_build_object(
        'reason', 'missing_required_webhook_party_address_failed_webhook_inbox',
        'error', v_result.last_error,
        'webhook_id', v_metadata_source
      );
      RETURN v_result;
    END IF;

$guard$;
BEGIN
  IF position(v_marker IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Webhook shipment materialization boundary changed';
  END IF;
  EXECUTE replace(v_definition, v_marker, v_guard || v_marker);
END;
$patch$;

COMMIT;
