-- Migration: Batch lease label jobs
-- Purpose:
--  - Reduce label-renderer latency by leasing up to N jobs in a single DB call.
--  - Supports edge worker batch mode without per-job RPC loops.

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION lease_label_jobs(
  p_organization_id UUID DEFAULT NULL,
  p_lease_seconds INTEGER DEFAULT 300,
  p_max_jobs INTEGER DEFAULT 10
)
RETURNS SETOF label_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_lease_interval INTERVAL := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 60));
  v_max_jobs INTEGER := LEAST(GREATEST(COALESCE(p_max_jobs, 10), 1), 100);
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT id
    FROM label_jobs
    WHERE status = 'pending'
      AND scheduled_at <= now()
      AND attempts < max_attempts
      AND (p_organization_id IS NULL OR organization_id = p_organization_id)
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

COMMENT ON FUNCTION lease_label_jobs(UUID, INTEGER, INTEGER)
  IS 'Lease up to p_max_jobs pending label jobs, marking them in_progress and extending lease_expires_at (SKIP LOCKED).';

GRANT EXECUTE ON FUNCTION lease_label_jobs(UUID, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION lease_label_jobs(UUID, INTEGER, INTEGER) TO label_renderer_role;
GRANT EXECUTE ON FUNCTION lease_label_jobs(UUID, INTEGER, INTEGER) TO edge_label_renderer_role;

COMMIT;

