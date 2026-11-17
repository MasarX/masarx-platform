-- Migration: Benchmark results writer v2 (run_id aware)
-- Purpose: Record benchmark outcomes under a benchmark_runs row (append-only), without truncating benchmark_results.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.benchmark_record_result_v2(
    p_run_id UUID,
    p_sample_id UUID,
    p_policy_scope_type TEXT,
    p_policy_scope_id UUID,
    p_policy_label TEXT,
    p_match_plugin TEXT,
    p_matched BOOLEAN,
    p_confidence NUMERIC,
    p_selected_city_id UUID,
    p_selected_district_id UUID,
    p_expected_city_id UUID,
    p_expected_district_id UUID,
    p_local_latency_ms NUMERIC,
    p_provider_latency_ms NUMERIC,
    p_failure_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.benchmark_results (
        run_id,
        sample_id,
        policy_scope_type,
        policy_scope_id,
        policy_label,
        match_plugin,
        matched,
        confidence,
        selected_city_id,
        selected_district_id,
        expected_city_id,
        expected_district_id,
        local_latency_ms,
        provider_latency_ms,
        failure_reason
    ) VALUES (
        p_run_id,
        p_sample_id,
        NULLIF(trim(lower(p_policy_scope_type)), ''),
        p_policy_scope_id,
        NULLIF(p_policy_label, ''),
        NULLIF(p_match_plugin, ''),
        p_matched,
        p_confidence,
        p_selected_city_id,
        p_selected_district_id,
        p_expected_city_id,
        p_expected_district_id,
        p_local_latency_ms,
        p_provider_latency_ms,
        NULLIF(p_failure_reason, '')
    );
END;
$$;

COMMENT ON FUNCTION workflow_handlers.benchmark_record_result_v2(
    UUID, UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN, NUMERIC, UUID, UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT
) IS 'Records a single benchmark execution outcome into benchmark_results under a benchmark_runs run_id (append-only).';

COMMIT;

