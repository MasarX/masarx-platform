-- Console V2 mapping tester: run canonical apply_mapping_config server-side and
-- persist a mapping_operation_reports row for operator evidence.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031840_mapping_config_test_ui_execute_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, false, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('mapping_operation_report_artifact_type', 'mapping_config', 'Mapping Config', 50),
    ('mapping_operation_report_operation_kind', 'mapping_test', 'Mapping Test', 30)
) AS v(category, value, label, sort_order)
  ON v.category = d.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status;

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
  v_output JSONB := NULL;
  v_status TEXT := 'succeeded';
  v_error TEXT := NULL;
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
  EXCEPTION WHEN OTHERS THEN
    v_status := 'failed';
    v_error := SQLERRM;
    v_output := NULL;
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
      'output_type', CASE WHEN v_output IS NULL THEN NULL ELSE jsonb_typeof(v_output) END
    ),
    'diagnostics_summary', jsonb_build_object(
      'status', v_status,
      'error', v_error
    ),
    'result_payload', jsonb_build_object(
      'input', v_input,
      'output', v_output
    ),
    'decision_refs', '{}'::jsonb,
    'next_steps', '[]'::jsonb
  ));

  RETURN jsonb_build_object(
    'ok', v_status = 'succeeded',
    'status', v_status,
    'mapping_config_id', p_mapping_config_id,
    'transformed_payload', v_output,
    'error', v_error,
    'report_id', v_report->>'id',
    'report', v_report
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_test_mapping_config_v1(
  p_mapping_config_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_test_mapping_config_v1(p_mapping_config_id, p_payload);
$function$;

REVOKE ALL ON FUNCTION public.ui_test_mapping_config_v1(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_test_mapping_config_v1(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_test_mapping_config_v1(UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION api.ui_test_mapping_config_v1(UUID, JSONB) FROM anon;

GRANT EXECUTE ON FUNCTION public.ui_test_mapping_config_v1(UUID, JSONB)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_test_mapping_config_v1(UUID, JSONB)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_test_mapping_config_v1(UUID, JSONB) IS
  'Console V2 guarded mapping tester. Applies mapping_config server-side with public.apply_mapping_config and persists mapping_operation_reports evidence.';
COMMENT ON FUNCTION api.ui_test_mapping_config_v1(UUID, JSONB) IS
  'Browser-safe api schema wrapper for public.ui_test_mapping_config_v1.';

SELECT pg_advisory_unlock(hashtext('202605031840_mapping_config_test_ui_execute_v1'));
COMMIT;
