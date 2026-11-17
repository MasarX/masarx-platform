-- Migration: restore outbound failure wrapper
-- Purpose:
--   - Restore policy-driven wrapper for mark_outbound_call_failure (delegates to v2).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;
CREATE OR REPLACE FUNCTION public.mark_outbound_call_failure(
    p_job_id UUID,
    p_status_code INT,
    p_headers JSONB,
    p_body JSONB,
    p_error TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
    PERFORM public.mark_outbound_call_failure_v2(
      p_job_id := p_job_id,
      p_status_code := p_status_code,
      p_headers := p_headers,
      p_body := p_body,
      p_error := p_error,
      p_performed_by_system := 'api_caller_edge',
      p_correlation_id := NULL
    );
END;
$$;

COMMENT ON FUNCTION public.mark_outbound_call_failure(UUID, INT, JSONB, JSONB, TEXT)
  IS 'Mark outbound_call failure and, when policy permits, schedule a retry using scheduled_at backoff (row-driven via outbound_retry_policy).';
COMMIT;
