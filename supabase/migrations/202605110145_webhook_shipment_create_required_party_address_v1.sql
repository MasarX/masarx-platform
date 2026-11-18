-- Console V2 webhook shipment-create required party/address fail-closed guard.
--
-- Live clicked webhook testing exposed that a shipment-create payload missing
-- recipient and destination address data could still materialize an incomplete
-- shipment. Keep shipment-creating webhook intake fail-closed: a terminal
-- webhook shipment requires canonical recipient and destination address
-- materialization before shipment insert/update can run.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605110145_webhook_shipment_create_required_party_address_v1'));

SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_marker TEXT;
  v_replacement TEXT;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 definition not found';
  END IF;

  IF position('missing_required_webhook_party_address_failed_webhook_inbox' IN v_def) = 0 THEN
    v_marker := E'    v_destination_address_id UUID;\n';
    v_replacement := E'    v_destination_address_id UUID := COALESCE(\n        NULLIF(v_ctx->>''destination_address_id'', '''')::UUID,\n        NULLIF(v_ctx_patch->>''destination_address_id'', '''')::UUID,\n        NULLIF(v_payload_address->>''id'', '''')::UUID\n    );\n';

    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch execute_shipment_create_v1 destination_address_id initializer';
    END IF;

    v_def := replace(v_def, v_marker, v_replacement);

    v_marker := E'    IF v_recipient_id IS NULL AND v_recipient_external_id IS NOT NULL THEN\n';
    v_replacement := E'    IF v_destination_address_id IS NOT NULL THEN\n      PERFORM 1\n        FROM public.addresses a\n       WHERE a.id = v_destination_address_id\n         AND a.client_id = v_client\n         AND a.organization_id = v_org;\n      IF NOT FOUND THEN\n        RAISE EXCEPTION ''execute_shipment_create_v1 destination address % is outside shipment client scope'', v_destination_address_id;\n      END IF;\n    END IF;\n\n' || v_marker;

    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch execute_shipment_create_v1 destination address scope guard';
    END IF;

    v_def := replace(v_def, v_marker, v_replacement);

    v_marker := E'    IF jsonb_typeof(v_resource->''references'') = ''object'' THEN\n';
    v_replacement := E'    IF v_metadata_source IS NOT NULL\n       AND (v_recipient_id IS NULL OR v_destination_address_id IS NULL) THEN\n      v_result.status := ''failed'';\n      v_result.last_error := format(\n        ''execute_shipment_create_v1: missing required webhook shipment recipient/address (recipient %s, destination_address %s)'',\n        COALESCE(v_recipient_id::TEXT, ''<NULL>''),\n        COALESCE(v_destination_address_id::TEXT, ''<NULL>'')\n      );\n      v_result.operation_result := jsonb_build_object(\n        ''reason'', ''missing_required_webhook_party_address_failed_webhook_inbox'',\n        ''error'', v_result.last_error,\n        ''webhook_id'', v_metadata_source,\n        ''organization_id'', v_org,\n        ''client_id'', v_client,\n        ''recipient_id'', v_recipient_id,\n        ''destination_address_id'', v_destination_address_id\n      );\n      v_result.context_patch := jsonb_build_object(\n        ''shipment_create_error'', v_result.operation_result\n      );\n\n      UPDATE public.webhook_inbox wi\n         SET processing_status = ''failed'',\n             processed_at = COALESCE(wi.processed_at, now()),\n             error_message = v_result.last_error,\n             updated_at = now()\n       WHERE wi.id = v_metadata_source\n         AND wi.processing_status IS DISTINCT FROM ''succeeded'';\n\n      IF v_org IS NOT NULL THEN\n        PERFORM public.log_decision(\n          p_organization_id := v_org,\n          p_decision_category := ''webhook_processing'',\n          p_resource_type := ''webhook_inbox'',\n          p_resource_id := v_metadata_source,\n          p_decision_point := ''shipment_create_payload'',\n          p_decision_outcome := ''failed'',\n          p_performed_by_system := ''workflow_handlers.execute_shipment_create_v1'',\n          p_correlation_id := v_correlation_id,\n          p_decision_inputs := v_result.operation_result,\n          p_decision_reason := v_result.last_error\n        );\n      END IF;\n\n      RETURN v_result;\n    END IF;\n\n' || v_marker;

    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch execute_shipment_create_v1 webhook party/address fail-closed branch';
    END IF;

    v_def := replace(v_def, v_marker, v_replacement);
    EXECUTE v_def;
  END IF;
END;
$patch$;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Workflow-owned shipment creation handler. Materializes API/webhook shipment, recipient, destination address, COD, reference, and lineage data from canonical workflow context; missing required webhook context or webhook recipient/address materialization marks the inbox failed instead of creating incomplete shipment proof.';

CREATE OR REPLACE FUNCTION public.sync_webhook_inbox_from_shipment_create_failure_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_webhook_id UUID;
  v_error TEXT;
BEGIN
  IF NEW.handler_key IS DISTINCT FROM 'shipment_create'
     OR NEW.step_status IS DISTINCT FROM 'failed' THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_webhook_id := NULLIF(NEW.operation_result->>'webhook_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_webhook_id := NULL;
  END;

  IF v_webhook_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_error := COALESCE(
    NULLIF(NEW.last_error, ''),
    NULLIF(NEW.operation_result->>'error', ''),
    'shipment_create workflow step failed'
  );

  UPDATE public.webhook_inbox wi
     SET processing_status = 'failed',
         processed_at = COALESCE(wi.processed_at, now()),
         error_message = v_error,
         updated_at = now()
   WHERE wi.id = v_webhook_id
     AND wi.processing_status IS DISTINCT FROM 'succeeded';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_run_steps_webhook_shipment_create_failure_sync
  ON public.workflow_run_steps;

CREATE TRIGGER workflow_run_steps_webhook_shipment_create_failure_sync
AFTER INSERT OR UPDATE OF step_status, operation_result, last_error
ON public.workflow_run_steps
FOR EACH ROW
EXECUTE FUNCTION public.sync_webhook_inbox_from_shipment_create_failure_v1();

COMMENT ON FUNCTION public.sync_webhook_inbox_from_shipment_create_failure_v1()
  IS 'Synchronizes webhook_inbox to terminal failed when a workflow-engine shipment_create step with webhook lineage fails; keeps Console receiver readback fail-closed even when the workflow engine records failure outside the handler side-effect boundary.';

WITH failed_steps AS (
  SELECT DISTINCT ON ((wrs.operation_result->>'webhook_id')::UUID)
         (wrs.operation_result->>'webhook_id')::UUID AS webhook_id,
         COALESCE(
           NULLIF(wrs.last_error, ''),
           NULLIF(wrs.operation_result->>'error', ''),
           'shipment_create workflow step failed'
         ) AS error_message
    FROM public.workflow_run_steps wrs
   WHERE wrs.handler_key = 'shipment_create'
     AND wrs.step_status = 'failed'
     AND COALESCE(wrs.operation_result->>'webhook_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   ORDER BY (wrs.operation_result->>'webhook_id')::UUID, wrs.updated_at DESC NULLS LAST, wrs.created_at DESC NULLS LAST
)
UPDATE public.webhook_inbox wi
   SET processing_status = 'failed',
       processed_at = COALESCE(wi.processed_at, now()),
       error_message = failed_steps.error_message,
       updated_at = now()
  FROM failed_steps
 WHERE wi.id = failed_steps.webhook_id
   AND wi.processing_status IS DISTINCT FROM 'succeeded';

SELECT pg_advisory_unlock(hashtext('202605110145_webhook_shipment_create_required_party_address_v1'));

COMMIT;
