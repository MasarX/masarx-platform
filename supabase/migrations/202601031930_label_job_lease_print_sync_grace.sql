-- Migration: Guard label job leasing against print_sync worker collisions
-- Purpose:
--  - Skip label_print_sync jobs in worker leasing during a configurable grace window.
--  - Allow stale print_sync jobs to be recovered after the grace period.
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
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_lease_interval INTERVAL := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 60));
  v_max_jobs INTEGER := LEAST(GREATEST(COALESCE(p_max_jobs, 10), 1), 100);
  v_policy JSONB;
  v_grace_seconds INTEGER := 0;
  v_grace_interval INTERVAL := make_interval(secs => 0);
BEGIN
  v_policy := CASE
    WHEN p_organization_id IS NOT NULL THEN resolve_settings('label_print_policy', 'tenant', p_organization_id)
    ELSE resolve_settings('label_print_policy', 'global', NULL)
  END;

  BEGIN
    v_grace_seconds := GREATEST(
      COALESCE(NULLIF(v_policy->>'print_sync_worker_grace_seconds', '')::INTEGER, 0),
      0
    );
  EXCEPTION
    WHEN others THEN
      v_grace_seconds := 0;
  END;

  v_grace_interval := make_interval(secs => v_grace_seconds);

  RETURN QUERY
  WITH candidate AS (
    SELECT id
    FROM label_jobs
    WHERE status = 'pending'
      AND scheduled_at <= now()
      AND attempts < max_attempts
      AND (p_organization_id IS NULL OR organization_id = p_organization_id)
      AND (
        requested_source IS DISTINCT FROM 'label_print_sync'
        OR v_grace_seconds = 0
        OR created_at <= now() - v_grace_interval
      )
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
  IS 'Lease up to p_max_jobs pending label jobs, skipping recent print_sync jobs during the grace window.';

CREATE OR REPLACE FUNCTION public.lease_label_job(
    p_organization_id UUID DEFAULT NULL,
    p_lease_seconds INTEGER DEFAULT 300,
    p_job_id UUID DEFAULT NULL
)
RETURNS public.label_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_job public.label_jobs%ROWTYPE;
    v_lease_interval INTERVAL := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 60));
    v_policy JSONB;
    v_grace_seconds INTEGER := 0;
    v_grace_interval INTERVAL := make_interval(secs => 0);
BEGIN
    IF p_job_id IS NOT NULL THEN
        SELECT lj.*
        INTO v_job
        FROM public.label_jobs lj
        JOIN public.organizations o ON o.id = lj.organization_id
        JOIN public.clients c ON c.id = lj.client_id AND c.organization_id = lj.organization_id
        WHERE lj.id = p_job_id
          AND lj.status = 'pending'
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN NULL;
        END IF;

        IF p_organization_id IS NOT NULL
           AND v_job.organization_id <> p_organization_id THEN
            RAISE EXCEPTION 'Label job % does not belong to organization %', p_job_id, p_organization_id;
        END IF;

        UPDATE public.label_jobs
        SET status = 'in_progress',
            attempts = public.label_jobs.attempts + 1,
            last_attempt_at = now(),
            lease_expires_at = now() + v_lease_interval
        WHERE id = v_job.id
        RETURNING * INTO v_job;

        RETURN v_job;
    END IF;

    v_policy := CASE
      WHEN p_organization_id IS NOT NULL THEN resolve_settings('label_print_policy', 'tenant', p_organization_id)
      ELSE resolve_settings('label_print_policy', 'global', NULL)
    END;

    BEGIN
      v_grace_seconds := GREATEST(
        COALESCE(NULLIF(v_policy->>'print_sync_worker_grace_seconds', '')::INTEGER, 0),
        0
      );
    EXCEPTION
      WHEN others THEN
        v_grace_seconds := 0;
    END;

    v_grace_interval := make_interval(secs => v_grace_seconds);

    WITH candidate AS (
        SELECT lj.id
        FROM public.label_jobs lj
        JOIN public.organizations o ON o.id = lj.organization_id
        JOIN public.clients c ON c.id = lj.client_id AND c.organization_id = lj.organization_id
        WHERE lj.status = 'pending'
          AND lj.scheduled_at <= now()
          AND lj.attempts < lj.max_attempts
          AND (p_organization_id IS NULL OR lj.organization_id = p_organization_id)
          AND p_job_id IS NULL
          AND (
            lj.requested_source IS DISTINCT FROM 'label_print_sync'
            OR v_grace_seconds = 0
            OR lj.created_at <= now() - v_grace_interval
          )
        ORDER BY lj.scheduled_at, lj.created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.label_jobs lj
    SET status = 'in_progress',
        attempts = lj.attempts + 1,
        last_attempt_at = now(),
        lease_expires_at = now() + v_lease_interval
    FROM candidate
    WHERE lj.id = candidate.id
    RETURNING lj.*
    INTO v_job;

    RETURN v_job;
END;
$function$;

COMMENT ON FUNCTION public.lease_label_job(UUID, INTEGER, UUID)
  IS 'Lease a pending label job, skipping recent print_sync jobs during the grace window.';

COMMIT;
