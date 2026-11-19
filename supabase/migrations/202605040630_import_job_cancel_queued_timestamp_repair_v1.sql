-- Repair import_job_cancel_v1 so cancelling a queued job satisfies the
-- import_jobs lifecycle timestamp contract.

BEGIN;

CREATE OR REPLACE FUNCTION public.import_job_cancel_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_job public.import_jobs%ROWTYPE;
  v_job_id UUID := NULLIF(p_args->>'import_job_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'import_job_cancel_v1: p_args must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'import_job_cancel_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('imports.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'import_job_cancel_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'import_job_cancel_v1 requires import_job_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT *
    INTO v_job
    FROM public.import_jobs
   WHERE id = v_job_id
   FOR UPDATE;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'import_job_cancel_v1: job % not found', v_job_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_job.organization_id <> v_org_id AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'import_job_cancel_v1: job % outside tenant scope', v_job_id
      USING ERRCODE = '42501';
  END IF;

  IF v_job.status NOT IN ('queued','running') THEN
    RAISE EXCEPTION 'import_job_cancel_v1: job % not cancellable (status=%)', v_job_id, v_job.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.import_jobs
     SET status = 'cancelled',
         started_at = COALESCE(started_at, now()),
         completed_at = now(),
         cancelled_reason = COALESCE(v_reason, 'cancelled_by_user'),
         updated_at = now()
   WHERE id = v_job_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_job.organization_id, 'imports.cancel', 'import_job', v_job_id,
    'import_job_cancel_v1', 'cancelled',
    jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_job.status,
      'reason', v_reason
    )),
    'import_job_cancel_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload,
    correlation_id, status
  ) VALUES (
    v_job.organization_id, 'import_job.cancelled', 'import_job', v_job_id,
    jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_job.status,
      'reason', v_reason
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'import_job_id', v_job_id,
    'status', 'cancelled',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_job_cancel_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_job_cancel_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_job_cancel_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.import_job_cancel_v1(jsonb)
  IS 'Canonical RPC: cancel a queued/running import job (status=cancelled). Capability: imports.write. Emits decision_log + domain_events.';

COMMIT;
