-- Migration: Label render metrics persistence views + SLO check (decision_log alert hook)
-- Purpose:
--  - Provide SSOT-friendly query surfaces over label_jobs.renderer_metadata.timings and bundle decision inputs.
--  - Add a DB-side SLO check that logs a decision when p95 exceeds thresholds from label_render_policy.

BEGIN;

SET search_path TO public, pg_temp;

-- -----------------------------------------------------------------------------
-- Views
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.label_render_job_timings_v AS
SELECT
  j.organization_id,
  j.id AS job_id,
  j.label_type,
  j.template_id,
  j.template_version,
  COALESCE(j.template_snapshot->>'template_key', j.template_snapshot->'renderer_config'->>'template_key') AS template_key,
  j.completed_at,
  j.output_file_size_bytes,
  (j.renderer_metadata->'timings'->>'compose_ms')::INTEGER AS compose_ms,
  (j.renderer_metadata->'timings'->>'render_ms')::INTEGER AS render_ms,
  (j.renderer_metadata->'timings'->>'upload_ms')::INTEGER AS upload_ms,
  (j.renderer_metadata->'timings'->>'total_ms')::INTEGER AS total_ms
FROM public.label_jobs j
WHERE j.renderer_metadata ? 'timings';

COMMENT ON VIEW public.label_render_job_timings_v IS
'Flattened per-job timings extracted from label_jobs.renderer_metadata.timings for dashboards and SLO checks.';

REVOKE ALL ON public.label_render_job_timings_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.label_render_job_timings_v TO service_role;

CREATE OR REPLACE VIEW public.label_bundle_merge_metrics_v AS
SELECT
  d.organization_id,
  d.resource_id AS bundle_id,
  d.decision_point,
  d.decision_outcome,
  d.timestamp,
  d.decision_inputs->>'output' AS output_path,
  (d.decision_inputs->>'merged_pages')::INTEGER AS merged_pages,
  (d.decision_inputs->'timings'->>'download_ms')::INTEGER AS download_ms,
  (d.decision_inputs->'timings'->>'merge_ms')::INTEGER AS merge_ms,
  (d.decision_inputs->'timings'->>'upload_ms')::INTEGER AS upload_ms,
  (d.decision_inputs->'timings'->>'total_ms')::INTEGER AS total_ms
FROM public.decision_log d
WHERE d.decision_category = 'label_bundle'
  AND d.decision_inputs ? 'timings';

COMMENT ON VIEW public.label_bundle_merge_metrics_v IS
'Bundle merge timings extracted from decision_log entries written by run-bundle-merge.js --record.';

REVOKE ALL ON public.label_bundle_merge_metrics_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.label_bundle_merge_metrics_v TO service_role;

-- -----------------------------------------------------------------------------
-- Rollup + SLO check
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.label_render_metrics_window(
  p_organization_id UUID,
  p_window_minutes INTEGER DEFAULT 60
)
RETURNS TABLE (
  sample_count INTEGER,
  p50_render_ms INTEGER,
  p95_render_ms INTEGER,
  p50_total_ms INTEGER,
  p95_total_ms INTEGER
)
LANGUAGE sql
STABLE
SET search_path TO public, pg_temp
AS $$
  SELECT
    COUNT(*)::INTEGER AS sample_count,
    ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY render_ms))::INTEGER AS p50_render_ms,
    ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY render_ms))::INTEGER AS p95_render_ms,
    ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms))::INTEGER AS p50_total_ms,
    ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms))::INTEGER AS p95_total_ms
  FROM public.label_render_job_timings_v
  WHERE organization_id = p_organization_id
    AND completed_at >= (now() - make_interval(mins => GREATEST(p_window_minutes, 1)))
    AND render_ms IS NOT NULL
    AND total_ms IS NOT NULL;
$$;

COMMENT ON FUNCTION public.label_render_metrics_window(UUID, INTEGER) IS
'Returns p50/p95 rollups for label render timings over a time window (minutes) for an organization.';

GRANT EXECUTE ON FUNCTION public.label_render_metrics_window(UUID, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.check_label_render_slo_and_log(
  p_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_org UUID;
  v_policy JSONB;
  v_metrics JSONB;
  v_window_minutes INTEGER;
  v_min_samples INTEGER;
  v_slo_p95_render_ms INTEGER;
  v_slo_p95_total_ms INTEGER;
  v_sample_count INTEGER;
  v_p50_render_ms INTEGER;
  v_p95_render_ms INTEGER;
  v_p50_total_ms INTEGER;
  v_p95_total_ms INTEGER;
  v_results JSONB := '[]'::jsonb;
  v_outcome TEXT;
BEGIN
  FOR v_org IN
    SELECT DISTINCT organization_id
    FROM public.label_jobs
    WHERE completed_at >= (now() - interval '24 hours')
      AND (p_organization_id IS NULL OR organization_id = p_organization_id)
  LOOP
    v_policy := public.resolve_settings('label_render_policy', 'tenant', v_org);
    IF v_policy IS NULL THEN
      v_policy := public.resolve_settings('label_render_policy', 'global', NULL);
    END IF;

    v_metrics := COALESCE(v_policy->'metrics', '{}'::jsonb);
    v_window_minutes := COALESCE(NULLIF((v_metrics->>'window_minutes')::INTEGER, 0), 60);
    v_min_samples := COALESCE(NULLIF((v_metrics->>'min_samples')::INTEGER, 0), 25);
    v_slo_p95_render_ms := COALESCE(NULLIF((v_metrics->>'slo_p95_render_ms')::INTEGER, 0), 4000);
    v_slo_p95_total_ms := COALESCE(NULLIF((v_metrics->>'slo_p95_total_ms')::INTEGER, 0), 8000);

    SELECT
      sample_count,
      p50_render_ms,
      p95_render_ms,
      p50_total_ms,
      p95_total_ms
    INTO
      v_sample_count,
      v_p50_render_ms,
      v_p95_render_ms,
      v_p50_total_ms,
      v_p95_total_ms
    FROM public.label_render_metrics_window(v_org, v_window_minutes);

    IF v_sample_count IS NULL OR v_sample_count < v_min_samples THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'organization_id', v_org,
        'status', 'insufficient_samples',
        'window_minutes', v_window_minutes,
        'sample_count', COALESCE(v_sample_count, 0),
        'min_samples', v_min_samples
      ));
      CONTINUE;
    END IF;

    IF v_p95_render_ms > v_slo_p95_render_ms OR v_p95_total_ms > v_slo_p95_total_ms THEN
      v_outcome := 'slo_violation';
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'label_render_slo',
        p_resource_type := 'organization',
        p_resource_id := v_org,
        p_decision_point := 'label_render_slo_check',
        p_decision_outcome := v_outcome,
        p_performed_by_system := 'alert_aggregation_worker',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object(
          'window_minutes', v_window_minutes,
          'sample_count', v_sample_count,
          'p50_render_ms', v_p50_render_ms,
          'p95_render_ms', v_p95_render_ms,
          'p50_total_ms', v_p50_total_ms,
          'p95_total_ms', v_p95_total_ms,
          'thresholds', jsonb_build_object(
            'slo_p95_render_ms', v_slo_p95_render_ms,
            'slo_p95_total_ms', v_slo_p95_total_ms
          )
        ),
        p_decision_reason := 'Label render SLO regression detected'
      );
    ELSE
      v_outcome := 'ok';
    END IF;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'organization_id', v_org,
      'status', v_outcome,
      'window_minutes', v_window_minutes,
      'sample_count', v_sample_count,
      'p50_render_ms', v_p50_render_ms,
      'p95_render_ms', v_p95_render_ms,
      'p50_total_ms', v_p50_total_ms,
      'p95_total_ms', v_p95_total_ms,
      'thresholds', jsonb_build_object(
        'slo_p95_render_ms', v_slo_p95_render_ms,
        'slo_p95_total_ms', v_slo_p95_total_ms
      )
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'ok',
    'checked', jsonb_array_length(v_results),
    'results', v_results
  );
END;
$$;

COMMENT ON FUNCTION public.check_label_render_slo_and_log(UUID) IS
'Computes p95 rollups from label_jobs timings and logs decision_log entries when SLO thresholds are exceeded (thresholds resolved via label_render_policy).';

GRANT EXECUTE ON FUNCTION public.check_label_render_slo_and_log(UUID) TO service_role;

COMMIT;

