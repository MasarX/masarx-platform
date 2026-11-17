-- Migration: Compact targeted leasing helper for edge orchestrators
-- Purpose:
--  - Lease a specific set of label_jobs while returning only job ids (no large row payloads).
--  - Reduces Edge <-> DB transfer and improves print_sync latency.

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION public.lease_label_jobs_by_ids_compact(
  p_job_ids UUID[],
  p_lease_seconds INTEGER DEFAULT 300,
  p_max_jobs INTEGER DEFAULT 10
)
RETURNS TABLE (
  job_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_lease_interval INTERVAL := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 60));
  v_max_jobs INTEGER := LEAST(GREATEST(COALESCE(p_max_jobs, 10), 1), 100);
BEGIN
  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT id
    FROM public.label_jobs
    WHERE id = ANY (p_job_ids)
      AND status = 'pending'
      AND scheduled_at <= now()
      AND attempts < max_attempts
    ORDER BY scheduled_at, created_at
    LIMIT v_max_jobs
    FOR UPDATE SKIP LOCKED
  ),
  leased AS (
    UPDATE public.label_jobs lj
    SET status = 'in_progress',
        attempts = lj.attempts + 1,
        last_attempt_at = now(),
        lease_expires_at = now() + v_lease_interval
    FROM candidate
    WHERE lj.id = candidate.id
    RETURNING lj.id
  )
  SELECT leased.id AS job_id
  FROM leased;
END;
$function$;

COMMENT ON FUNCTION public.lease_label_jobs_by_ids_compact(UUID[], INTEGER, INTEGER)
  IS 'Lease up to p_max_jobs pending label jobs from an explicit id list (SKIP LOCKED) and return only job ids (compact).';

REVOKE EXECUTE ON FUNCTION public.lease_label_jobs_by_ids_compact(UUID[], INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.lease_label_jobs_by_ids_compact(UUID[], INTEGER, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.lease_label_jobs_by_ids_compact(UUID[], INTEGER, INTEGER) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.lease_label_jobs_by_ids_compact(UUID[], INTEGER, INTEGER) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.lease_label_jobs_by_ids_compact(UUID[], INTEGER, INTEGER) TO label_renderer_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.lease_label_jobs_by_ids_compact(UUID[], INTEGER, INTEGER) TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;

