-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Tabular import authenticated read/profile/cancel RPCs

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091170_tabular_import_runtime_read_api_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Authenticated profile summaries for tabular import mappings
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_tabular_import_profiles_v1(
  p_resource TEXT
)
RETURNS TABLE (
  id UUID,
  profile_name TEXT,
  profile_slug TEXT,
  header_fingerprint TEXT,
  sheet_hint TEXT,
  write_mode TEXT,
  mapping_key TEXT,
  mapping_config JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_resource_key TEXT := NULLIF(btrim(COALESCE(p_resource, '')), '');
  v_org_id UUID := public.current_user_org_id();
  v_resource JSONB;
  v_capability TEXT;
BEGIN
  IF v_resource_key IS NULL THEN
    RAISE EXCEPTION 'ui_tabular_import_profiles_v1 requires resource key';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_resource_key);
  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_tabular_import_profiles_v1 unknown resource %', v_resource_key;
  END IF;

  IF COALESCE((v_resource#>>ARRAY['import','enabled'])::boolean, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_tabular_import_profiles_v1 import disabled for resource %', v_resource_key;
  END IF;

  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), '')
  );
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, 'tenant', v_org_id);
  END IF;

  RETURN QUERY
  SELECT
    mc.id,
    NULLIF(btrim(COALESCE(mc.mapping_config->>'profile_name', '')), '') AS profile_name,
    public.tabular_import_slug_v1(
      COALESCE(
        NULLIF(btrim(COALESCE(mc.mapping_config->>'profile_name', '')), ''),
        split_part(mc.mapping_key, '::', 3)
      )
    ) AS profile_slug,
    NULLIF(btrim(COALESCE(mc.mapping_config->>'header_fingerprint', '')), '') AS header_fingerprint,
    NULLIF(btrim(COALESCE(mc.mapping_config->>'sheet_hint', '')), '') AS sheet_hint,
    COALESCE(NULLIF(btrim(COALESCE(mc.mapping_config->>'write_mode', '')), ''), 'create') AS write_mode,
    mc.mapping_key,
    mc.mapping_config,
    mc.created_at,
    mc.updated_at
  FROM public.mapping_configs mc
  WHERE mc.organization_id = v_org_id
    AND mc.mapping_type = 'tabular_import'
    AND COALESCE(mc.mapping_config->>'resource_key', '') = v_resource_key
  ORDER BY mc.updated_at DESC, mc.created_at DESC;
END;
$function$;

-------------------------------------------------------------------------------
-- 2) Authenticated run reader
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_get_tabular_import_run_v1(
  p_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_resource JSONB;
  v_capability TEXT;
  v_artifacts JSONB := '[]'::jsonb;
  v_rows JSONB := '[]'::jsonb;
  v_report JSONB := NULL;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_tabular_import_run_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'ui_get_tabular_import_run_v1 run % not found', p_run_id;
  END IF;

  IF NOT public.is_platform_user()
     AND v_run.organization_id IS DISTINCT FROM public.current_user_org_id() THEN
    RAISE EXCEPTION 'ui_get_tabular_import_run_v1 cannot read another organization';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_run.resource_key);
  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), ''),
    'system.write'
  );
  PERFORM public.assert_capability_v1(v_capability, 'tenant', v_run.organization_id);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'artifact_id', a.id,
          'relation_type', link.relation_type,
          'storage_bucket', a.storage_bucket,
          'storage_key', a.storage_key,
          'mime_type', a.mime_type,
          'file_name', COALESCE(NULLIF(btrim(COALESCE(a.metadata->>'file_name', '')), ''), split_part(a.storage_key, '/', array_length(string_to_array(a.storage_key, '/'), 1))),
          'metadata', a.metadata
        )
      )
      ORDER BY link.created_at ASC
    ),
    '[]'::jsonb
  )
    INTO v_artifacts
    FROM public.artifact_links link
    JOIN public.artifacts a ON a.id = link.artifact_id
   WHERE link.organization_id = v_run.organization_id
     AND link.resource_type = 'tabular_import_runs'
     AND link.resource_id = v_run.id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'row_number', row_number,
        'execution_status', execution_status,
        'action', action,
        'diagnostics', diagnostics,
        'coercions', coercions,
        'mapped_row', mapped_row,
        'target_record_id', target_record_id,
        'reason_codes', reason_codes,
        'reason_messages', reason_messages
      )
      ORDER BY row_number ASC
    ),
    '[]'::jsonb
  )
    INTO v_rows
    FROM (
      SELECT *
      FROM public.tabular_import_run_rows
      WHERE run_id = v_run.id
      ORDER BY row_number ASC
      LIMIT 25
    ) sample_rows;

  IF v_run.report_id IS NOT NULL THEN
    SELECT to_jsonb(r.*)
      INTO v_report
      FROM public.mapping_operation_reports r
     WHERE r.id = v_run.report_id;
  END IF;

  RETURN jsonb_strip_nulls(
    to_jsonb(v_run) || jsonb_build_object(
      'artifacts', COALESCE(v_artifacts, '[]'::jsonb),
      'rows', COALESCE(v_rows, '[]'::jsonb),
      'report', v_report
    )
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 3) Authenticated cancel
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_cancel_tabular_import_run_v1(
  p_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_resource JSONB;
  v_capability TEXT;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_cancel_tabular_import_run_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id
   FOR UPDATE;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'ui_cancel_tabular_import_run_v1 run % not found', p_run_id;
  END IF;

  IF NOT public.is_platform_user()
     AND v_run.organization_id IS DISTINCT FROM public.current_user_org_id() THEN
    RAISE EXCEPTION 'ui_cancel_tabular_import_run_v1 cannot cancel another organization';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_run.resource_key);
  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), ''),
    'system.write'
  );
  PERFORM public.assert_capability_v1(v_capability, 'tenant', v_run.organization_id);

  IF v_run.status IN ('completed', 'completed_with_errors', 'failed', 'canceled') THEN
    RETURN public.ui_get_tabular_import_run_v1(v_run.id);
  END IF;

  UPDATE public.tabular_import_runs
     SET status = 'canceled',
         canceled_at = now(),
         completed_at = COALESCE(completed_at, now()),
         updated_by = COALESCE(auth.uid(), updated_by),
         updated_at = now()
   WHERE id = v_run.id;

  UPDATE public.tabular_import_run_rows
     SET execution_status = CASE
                              WHEN execution_status IN ('succeeded', 'failed', 'blocked', 'skipped') THEN execution_status
                              ELSE 'canceled'
                            END,
         processed_at = CASE
                          WHEN execution_status IN ('succeeded', 'failed', 'blocked', 'skipped') THEN processed_at
                          ELSE now()
                        END,
         updated_at = now()
   WHERE run_id = v_run.id;

  IF v_run.task_id IS NOT NULL THEN
    PERFORM public.tabular_import_transition_task_system_v1(
      v_run.task_id,
      'canceled',
      'tabular_import_canceled',
      jsonb_build_object('run_id', v_run.id),
      'resource_import_studio'
    );
  END IF;

  RETURN public.ui_get_tabular_import_run_v1(v_run.id);
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_tabular_import_profiles_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_tabular_import_profiles_v1(TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_get_tabular_import_run_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_get_tabular_import_run_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603091170_tabular_import_runtime_read_api_v1'));
COMMIT;
