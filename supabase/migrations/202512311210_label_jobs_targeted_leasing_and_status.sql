-- Migration: Targeted leasing + status helpers for sync label print orchestration
-- Purpose:
--  - Allow edge orchestrators to lease a specific set of label_jobs (avoid cross-queue interference).
--  - Provide a least-privilege status view for a set of label_jobs (no direct SELECT grants needed).
BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION lease_label_jobs_by_ids(
  p_job_ids UUID[],
  p_lease_seconds INTEGER DEFAULT 300,
  p_max_jobs INTEGER DEFAULT 10
)
RETURNS SETOF label_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
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
    FROM label_jobs
    WHERE id = ANY (p_job_ids)
      AND status = 'pending'
      AND scheduled_at <= now()
      AND attempts < max_attempts
    ORDER BY scheduled_at, created_at
    LIMIT v_max_jobs
    FOR UPDATE SKIP LOCKED
  )
  UPDATE label_jobs lj
  SET status = 'in_progress',
      attempts = lj.attempts + 1,
      last_attempt_at = now(),
      lease_expires_at = now() + v_lease_interval
  FROM candidate
  WHERE lj.id = candidate.id
  RETURNING lj.*;
END;
$$;

COMMENT ON FUNCTION lease_label_jobs_by_ids(UUID[], INTEGER, INTEGER)
  IS 'Lease up to p_max_jobs pending label jobs from an explicit id list (SKIP LOCKED).';

REVOKE EXECUTE ON FUNCTION lease_label_jobs_by_ids(UUID[], INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lease_label_jobs_by_ids(UUID[], INTEGER, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION lease_label_jobs_by_ids(UUID[], INTEGER, INTEGER) FROM authenticated;

GRANT EXECUTE ON FUNCTION lease_label_jobs_by_ids(UUID[], INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION lease_label_jobs_by_ids(UUID[], INTEGER, INTEGER) TO label_renderer_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION lease_label_jobs_by_ids(UUID[], INTEGER, INTEGER) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION get_label_jobs_status(
  p_job_ids UUID[]
)
RETURNS TABLE (
  job_id UUID,
  organization_id UUID,
  status TEXT,
  output_file_url TEXT,
  label_id UUID,
  shipment_id UUID,
  shipment_box_id UUID,
  updated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
  SELECT
    lj.id AS job_id,
    lj.organization_id,
    lj.status,
    lj.output_file_url,
    lj.label_id,
    lj.shipment_id,
    lj.shipment_box_id,
    lj.updated_at,
    lj.completed_at
  FROM label_jobs lj
  WHERE p_job_ids IS NOT NULL
    AND array_length(p_job_ids, 1) IS NOT NULL
    AND lj.id = ANY (p_job_ids);
$$;

COMMENT ON FUNCTION get_label_jobs_status(UUID[])
  IS 'Return status and output_file_url for an explicit list of label_jobs ids.';

REVOKE EXECUTE ON FUNCTION get_label_jobs_status(UUID[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_label_jobs_status(UUID[]) FROM anon;
REVOKE EXECUTE ON FUNCTION get_label_jobs_status(UUID[]) FROM authenticated;

GRANT EXECUTE ON FUNCTION get_label_jobs_status(UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION get_label_jobs_status(UUID[]) TO label_renderer_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION get_label_jobs_status(UUID[]) TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;

