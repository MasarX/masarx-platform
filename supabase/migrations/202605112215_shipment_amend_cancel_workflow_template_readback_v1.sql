-- Ensure authenticated shipment amend/cancel responses carry workflow template
-- evidence directly, so shipment operators do not need workflow-run read
-- permissions to confirm a backend-backed mutation succeeded.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605112215_shipment_amend_cancel_workflow_template_readback_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $block$
BEGIN
  IF to_regprocedure('public.shipment_amend_cancel_execute_base_v1(jsonb)') IS NULL THEN
    ALTER FUNCTION public.shipment_amend_cancel_execute_v1(JSONB)
      RENAME TO shipment_amend_cancel_execute_base_v1;
  END IF;
END;
$block$;

CREATE OR REPLACE FUNCTION public.shipment_amend_cancel_execute_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_result JSONB := '{}'::jsonb;
  v_workflow_run_id UUID := NULL;
  v_workflow_template_id UUID := NULL;
  v_workflow_template_name TEXT := NULL;
  v_result_template_id TEXT := NULL;
  v_result_template_name TEXT := NULL;
  v_result_template_ref TEXT := NULL;
BEGIN
  v_result := COALESCE(public.shipment_amend_cancel_execute_base_v1(p_input), '{}'::jsonb);

  BEGIN
    v_workflow_run_id := NULLIF(v_result->>'workflow_run_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_workflow_run_id := NULL;
  END;

  IF v_workflow_run_id IS NOT NULL THEN
    SELECT
      wr.workflow_template_id,
      wt.name
    INTO
      v_workflow_template_id,
      v_workflow_template_name
    FROM public.workflow_runs wr
    LEFT JOIN public.workflow_templates wt
      ON wt.id = wr.workflow_template_id
    WHERE wr.id = v_workflow_run_id;
  END IF;

  v_result_template_id := COALESCE(NULLIF(v_result->>'workflow_template_id', ''), v_workflow_template_id::TEXT);
  v_result_template_name := COALESCE(NULLIF(v_result->>'workflow_template_name', ''), v_workflow_template_name);
  v_result_template_ref := COALESCE(NULLIF(v_result->>'workflow_template', ''), v_result_template_name, v_result_template_id);

  IF v_result_template_ref IS NOT NULL THEN
    v_result := jsonb_strip_nulls(
      v_result
      || jsonb_build_object(
        'workflow_template',
        v_result_template_ref,
        'workflow_template_id',
        v_result_template_id,
        'workflow_template_name',
        v_result_template_name
      )
    );
  END IF;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.shipment_amend_cancel_execute_base_v1(JSONB)
  IS 'Base executor for authenticated shipment amend/cancel operations; starts canonical workflow-engine runs and mutates shipment truth.';

COMMENT ON FUNCTION public.shipment_amend_cancel_execute_v1(JSONB)
  IS 'Shipment amend/cancel executor facade that returns workflow template evidence with mutation readback so Console shipment operators do not need workflow-run read permissions.';

REVOKE ALL ON FUNCTION public.shipment_amend_cancel_execute_base_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shipment_amend_cancel_execute_v1(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shipment_amend_cancel_execute_base_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.shipment_amend_cancel_execute_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202605112215_shipment_amend_cancel_workflow_template_readback_v1'));

COMMIT;
