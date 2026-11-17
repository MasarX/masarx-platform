-- Migration: lease_and_compose_label_payloads_compact
-- Purpose:
--  - Provide an all-or-none compact RPC for direct print sync batches.
--  - Lease + compose in one DB round-trip when full batch leasing is immediately available.
--  - Fall back safely by returning zero rows if full leasing cannot be satisfied.

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION public.lease_and_compose_label_payloads_compact(
  p_job_ids UUID[],
  p_lease_seconds INTEGER DEFAULT 300,
  p_max_jobs INTEGER DEFAULT 10
)
RETURNS TABLE (
  job_id UUID,
  composed JSONB,
  compose_ms NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_lease_interval INTERVAL := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 60));
  v_max_jobs INTEGER := LEAST(GREATEST(COALESCE(p_max_jobs, 10), 1), 100);
  v_expected_count INTEGER := 0;
BEGIN
  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  v_expected_count := LEAST(v_max_jobs, array_length(p_job_ids, 1));
  IF v_expected_count <= 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT lj.id
    FROM public.label_jobs lj
    WHERE lj.id = ANY (p_job_ids)
      AND lj.status = 'pending'
      AND lj.scheduled_at <= now()
      AND lj.attempts < lj.max_attempts
    ORDER BY lj.scheduled_at, lj.created_at
    LIMIT v_expected_count
    FOR UPDATE SKIP LOCKED
  ),
  candidate_count AS (
    SELECT COUNT(*)::int AS cnt FROM candidate
  ),
  guarded_candidate AS (
    SELECT c.id
    FROM candidate c
    CROSS JOIN candidate_count cc
    WHERE cc.cnt = v_expected_count
  ),
  leased AS (
    UPDATE public.label_jobs lj
    SET status = 'in_progress',
        attempts = lj.attempts + 1,
        last_attempt_at = now(),
        lease_expires_at = now() + v_lease_interval
    FROM guarded_candidate gc
    WHERE lj.id = gc.id
    RETURNING lj.*
  ),
  payload_by_job AS (
    SELECT
      l.id AS job_id,
      COALESCE(to_jsonb(p), '{}'::jsonb) AS payload
    FROM leased l
    LEFT JOIN LATERAL (
      SELECT p.*
      FROM public.shipment_label_payload_v p
      WHERE p.shipment_id = l.shipment_id
        AND (
          l.shipment_box_id IS NULL
          OR p.shipment_box_id = l.shipment_box_id
        )
      ORDER BY p.box_number NULLS FIRST
      LIMIT 1
    ) p ON TRUE
  )
  SELECT
    l.id AS job_id,
    jsonb_build_object(
      'job',
      jsonb_build_object(
        'id', l.id,
        'organization_id', l.organization_id,
        'client_id', l.client_id,
        'shipment_id', l.shipment_id,
        'shipment_box_id', l.shipment_box_id,
        'label_type', l.label_type,
        'attempts', l.attempts,
        'max_attempts', l.max_attempts,
        'template', l.template_snapshot,
        'renderer_hint', l.renderer_hint,
        'retry_state', l.retry_state
      ),
      'payload',
      pb.payload
    ) AS composed,
    0::numeric AS compose_ms
  FROM leased l
  JOIN payload_by_job pb ON pb.job_id = l.id;
END;
$function$;

COMMENT ON FUNCTION public.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER)
  IS 'All-or-none compact helper: lease explicit pending label jobs and compose payloads in one call; returns zero rows when full lease cannot be satisfied.';

REVOKE ALL ON FUNCTION public.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) TO label_renderer_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;
