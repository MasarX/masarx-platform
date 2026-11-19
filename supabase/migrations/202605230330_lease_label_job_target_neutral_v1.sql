-- Allow the renderer to lease target-neutral label jobs where client_id is
-- intentionally null. Shipment label jobs still validate client ownership.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605230330_lease_label_job_target_neutral_v1'));
SET search_path TO public, extensions, pg_temp;

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
BEGIN
    IF p_job_id IS NOT NULL THEN
        SELECT lj.*
        INTO v_job
        FROM public.label_jobs lj
        JOIN public.organizations o ON o.id = lj.organization_id
        LEFT JOIN public.clients c
          ON c.id = lj.client_id
         AND c.organization_id = lj.organization_id
        WHERE lj.id = p_job_id
          AND lj.status = 'pending'
          AND (lj.client_id IS NULL OR c.id IS NOT NULL)
        FOR UPDATE OF lj;

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

    WITH candidate AS (
        SELECT lj.id
        FROM public.label_jobs lj
        JOIN public.organizations o ON o.id = lj.organization_id
        LEFT JOIN public.clients c
          ON c.id = lj.client_id
         AND c.organization_id = lj.organization_id
        LEFT JOIN LATERAL public.resolve_settings_row_from_context(
          'label_print_policy',
          jsonb_strip_nulls(jsonb_build_object(
            'organization_id', lj.organization_id,
            'client_id', lj.client_id
          ))
        ) policy ON lj.requested_source = 'label_print_sync'
        WHERE lj.status = 'pending'
          AND lj.scheduled_at <= now()
          AND lj.attempts < lj.max_attempts
          AND (p_organization_id IS NULL OR lj.organization_id = p_organization_id)
          AND p_job_id IS NULL
          AND (lj.client_id IS NULL OR c.id IS NOT NULL)
          AND (
            lj.requested_source IS DISTINCT FROM 'label_print_sync'
            OR COALESCE(NULLIF(policy.value->>'print_sync_worker_grace_seconds', '')::INTEGER, 0) <= 0
            OR lj.created_at <= now() - make_interval(
              secs => GREATEST(
                COALESCE(NULLIF(policy.value->>'print_sync_worker_grace_seconds', '')::INTEGER, 0),
                0
              )
            )
          )
        ORDER BY lj.scheduled_at, lj.created_at
        LIMIT 1
        FOR UPDATE OF lj SKIP LOCKED
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
  IS 'Lease a pending label job, including target-neutral jobs with null client_id; shipment/client jobs still validate client ownership.';

SELECT pg_advisory_unlock(hashtext('202605230330_lease_label_job_target_neutral_v1'));
COMMIT;
