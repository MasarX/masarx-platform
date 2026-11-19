-- Console V2 mapping tester redacted readback.
--
-- Mapping tests are operator-facing evidence. They must prove the backend
-- mapping output without persisting raw sample secrets or raw execution errors
-- in reports or returning them to the browser.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606011130_mapping_tester_redacted_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_test_mapping_config_v1(
  p_mapping_config_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_mapping RECORD;
  v_report_org_id UUID;
  v_input JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_safe_input JSONB := NULL;
  v_output JSONB := NULL;
  v_safe_output JSONB := NULL;
  v_status TEXT := 'succeeded';
  v_error TEXT := NULL;
  v_error_state TEXT := NULL;
  v_report JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_test_mapping_config_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF p_mapping_config_id IS NULL THEN
    RAISE EXCEPTION 'ui_test_mapping_config_v1 requires mapping_config_id'
      USING ERRCODE = '23502';
  END IF;

  v_safe_input := public.redact_sensitive_json(v_input);

  SELECT mc.id, mc.organization_id, mc.mapping_type, mc.mapping_key, mc.mapping_config
    INTO v_mapping
    FROM public.mapping_configs mc
   WHERE mc.id = p_mapping_config_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_test_mapping_config_v1 mapping_config % not found', p_mapping_config_id
      USING ERRCODE = '23503';
  END IF;

  v_report_org_id := COALESCE(v_mapping.organization_id, public.current_user_org_id());
  IF v_report_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_test_mapping_config_v1 requires organization context'
      USING ERRCODE = '23502';
  END IF;

  IF NOT (
    public.user_has_capability_v1('mappings.write', 'tenant', v_report_org_id)
    OR public.user_has_capability_v1('integration_plugins.write', 'tenant', v_report_org_id)
    OR public.user_has_capability_v1('webhooks.write', 'tenant', v_report_org_id)
    OR public.user_has_capability_v1('system.write', 'tenant', v_report_org_id)
  ) THEN
    RAISE EXCEPTION 'ui_test_mapping_config_v1 missing write capability'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_output := public.apply_mapping_config(v_input, p_mapping_config_id);
    v_safe_output := public.redact_sensitive_json(COALESCE(v_output, '{}'::jsonb));
  EXCEPTION WHEN OTHERS THEN
    v_status := 'failed';
    v_error := 'mapping_test_execution_failed';
    v_error_state := SQLSTATE;
    v_output := NULL;
    v_safe_output := NULL;
  END;

  v_report := public.ui_create_mapping_operation_report_v1(jsonb_build_object(
    'organization_id', v_report_org_id,
    'artifact_type', 'mapping_config',
    'operation_kind', 'mapping_test',
    'save_mode', 'direct',
    'status', v_status,
    'primary_resource_type', 'mapping_config',
    'primary_resource_id', p_mapping_config_id,
    'request_summary', jsonb_build_object(
      'mapping_config_id', p_mapping_config_id,
      'mapping_type', v_mapping.mapping_type,
      'mapping_key', v_mapping.mapping_key
    ),
    'conversion_summary', jsonb_build_object(
      'input_type', jsonb_typeof(v_input),
      'output_type', CASE WHEN v_output IS NULL THEN NULL ELSE jsonb_typeof(v_output) END,
      'redaction', 'sensitive_fields_redacted'
    ),
    'diagnostics_summary', jsonb_build_object(
      'status', v_status,
      'error', v_error,
      'error_state', v_error_state,
      'redaction', 'sensitive_fields_redacted'
    ),
    'result_payload', jsonb_build_object(
      'input', v_safe_input,
      'output', v_safe_output
    ),
    'decision_refs', '{}'::jsonb,
    'next_steps', '[]'::jsonb
  ));

  RETURN jsonb_build_object(
    'ok', v_status = 'succeeded',
    'status', v_status,
    'mapping_config_id', p_mapping_config_id,
    'transformed_payload', v_safe_output,
    'error', v_error,
    'error_state', v_error_state,
    'report_id', v_report->>'id',
    'report', v_report
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_test_mapping_config_v1(UUID, JSONB) IS
  'Console V2 guarded mapping tester. Applies mapping_config server-side, redacts sensitive input/output/error readback, and persists mapping_operation_reports evidence.';

SELECT pg_advisory_unlock(hashtext('202606011130_mapping_tester_redacted_readback_v1'));

COMMIT;
