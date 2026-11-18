-- Console V2 webhook/API shipment intake must materialize recipients from
-- the common nested shipment.recipient provider payload shape.

DO $$
DECLARE
  v_function_def TEXT;
  v_original_block TEXT := $fn$v_payload_recipient JSONB := jsonb_strip_nulls(
      COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'recipient') = 'object' THEN v_materialized_payload->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'recipient') = 'object' THEN v_resource->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'recipient') = 'object' THEN v_ctx_patch->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'recipient') = 'object' THEN v_ctx->'recipient' END, '{}'::jsonb)
    );
$fn$;
  v_replacement_block TEXT := $fn$v_payload_recipient JSONB := jsonb_strip_nulls(
      COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'recipient') = 'object' THEN v_materialized_payload->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,recipient}') = 'object' THEN v_materialized_payload#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'recipient') = 'object' THEN v_resource->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource#>'{shipment,recipient}') = 'object' THEN v_resource#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'recipient') = 'object' THEN v_ctx_patch->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch#>'{shipment,recipient}') = 'object' THEN v_ctx_patch#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'recipient') = 'object' THEN v_ctx->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx#>'{shipment,recipient}') = 'object' THEN v_ctx#>'{shipment,recipient}' END, '{}'::jsonb)
    );
$fn$;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure
  )
    INTO v_function_def;

  IF v_function_def IS NULL THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 is missing; cannot patch nested recipient materialization';
  END IF;

  IF v_function_def NOT LIKE '%v_payload_recipient JSONB := jsonb_strip_nulls%' THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 recipient extraction block is missing';
  END IF;

  IF v_function_def LIKE '%v_materialized_payload#>''{shipment,recipient}''%' THEN
    RETURN;
  END IF;

  v_function_def := replace(v_function_def, v_original_block, v_replacement_block);

  IF v_function_def NOT LIKE '%v_materialized_payload#>''{shipment,recipient}''%' THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 nested recipient patch did not apply';
  END IF;

  EXECUTE v_function_def;
END $$;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Creates shipments from canonical workflow payloads and materializes provider/API shipment, recipient, address, COD, service, and label context including nested shipment.recipient payloads.';
