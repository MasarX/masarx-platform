-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Persist operation_kind in mapping operation reports

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091230_mapping_operation_report_operation_kind_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_create_mapping_operation_report_v1(
  p_report JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := COALESCE(
    public.mapping_studio_try_uuid_v1(p_report->>'organization_id'),
    public.current_user_org_id()
  );
  v_id UUID;
BEGIN
  IF p_report IS NULL OR jsonb_typeof(p_report) <> 'object' THEN
    RAISE EXCEPTION 'ui_create_mapping_operation_report_v1 requires report object';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_mapping_operation_report_v1 requires organization context';
  END IF;

  IF v_user_id IS NOT NULL
     AND NOT public.is_platform_user()
     AND public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'ui_create_mapping_operation_report_v1 cannot create reports for another organization';
  END IF;

  IF v_user_id IS NOT NULL
     AND NOT (
       public.user_has_capability_v1('mappings.write', 'tenant', v_org_id)
       OR public.user_has_capability_v1('integration_plugins.write', 'tenant', v_org_id)
       OR public.user_has_capability_v1('webhooks.write', 'tenant', v_org_id)
       OR public.user_has_capability_v1('system.write', 'tenant', v_org_id)
     ) THEN
    RAISE EXCEPTION 'ui_create_mapping_operation_report_v1 missing write capability';
  END IF;

  INSERT INTO public.mapping_operation_reports (
    organization_id,
    artifact_type,
    operation_kind,
    save_mode,
    status,
    primary_resource_type,
    primary_resource_id,
    workflow_template_id,
    correlation_id,
    request_summary,
    conversion_summary,
    diagnostics_summary,
    result_payload,
    decision_refs,
    next_steps,
    created_by,
    updated_by
  )
  VALUES (
    v_org_id,
    lower(COALESCE(NULLIF(btrim(p_report->>'artifact_type'), ''), 'tabular_import')),
    lower(COALESCE(NULLIF(btrim(p_report->>'operation_kind'), ''), 'mapping_save')),
    lower(COALESCE(NULLIF(btrim(p_report->>'save_mode'), ''), 'direct')),
    lower(COALESCE(NULLIF(btrim(p_report->>'status'), ''), 'succeeded')),
    NULLIF(btrim(COALESCE(p_report->>'primary_resource_type', '')), ''),
    public.mapping_studio_try_uuid_v1(p_report->>'primary_resource_id'),
    public.mapping_studio_try_uuid_v1(p_report->>'workflow_template_id'),
    NULLIF(btrim(COALESCE(p_report->>'correlation_id', '')), ''),
    COALESCE(p_report->'request_summary', '{}'::jsonb),
    COALESCE(p_report->'conversion_summary', '{}'::jsonb),
    COALESCE(p_report->'diagnostics_summary', '{}'::jsonb),
    COALESCE(p_report->'result_payload', '{}'::jsonb),
    COALESCE(p_report->'decision_refs', '{}'::jsonb),
    COALESCE(p_report->'next_steps', '[]'::jsonb),
    COALESCE(public.mapping_studio_try_uuid_v1(p_report->>'created_by'), v_user_id),
    COALESCE(public.mapping_studio_try_uuid_v1(p_report->>'updated_by'), v_user_id)
  )
  RETURNING id INTO v_id;

  RETURN (
    SELECT to_jsonb(r.*)
    FROM public.mapping_operation_reports r
    WHERE r.id = v_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_create_mapping_operation_report_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_mapping_operation_report_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603091230_mapping_operation_report_operation_kind_fix_v1'));
COMMIT;
