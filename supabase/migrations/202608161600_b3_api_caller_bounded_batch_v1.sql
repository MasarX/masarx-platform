-- Migration: Bound api-caller batches and fence every claimed job with an opaque lease token.
-- The legacy claim/complete RPCs remain unchanged for compatibility. The bounded Edge path
-- claims one immediately executable job at a time and uses token-guarded compare-and-swap RPCs.

BEGIN;

ALTER TABLE public.outbound_calls
  ADD COLUMN IF NOT EXISTS edge_lease_token UUID;

COMMENT ON COLUMN public.outbound_calls.edge_lease_token
IS 'Opaque per-claim ownership fence for bounded Edge dispatch. Rotated on every claim and cleared on status transition.';

CREATE OR REPLACE FUNCTION public.clear_stale_edge_lease_token_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
BEGIN
  -- A status transition performed without rotating the token is a legacy completion,
  -- failure, or requeue. Clear the old fence so it can never regain ownership later.
  IF OLD.edge_lease_token IS NOT NULL
     AND NEW.edge_lease_token IS NOT DISTINCT FROM OLD.edge_lease_token
     AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR (OLD.lease_expires_at IS NOT NULL AND NEW.lease_expires_at IS NULL)
     ) THEN
    NEW.edge_lease_token := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS outbound_calls_clear_stale_edge_lease_token_v1
  ON public.outbound_calls;
CREATE TRIGGER outbound_calls_clear_stale_edge_lease_token_v1
BEFORE UPDATE ON public.outbound_calls
FOR EACH ROW
EXECUTE FUNCTION public.clear_stale_edge_lease_token_v1();

CREATE OR REPLACE FUNCTION public.claim_pending_edge_job_ids_v1(p_batch INT DEFAULT 1)
RETURNS TABLE (job_id UUID, lease_token UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  -- Runtime concurrency is one. Claiming more than one would start lease clocks for
  -- work that cannot execute yet, so the database enforces one claim per call.
  v_limit CONSTANT INT := 1;
  v_lease_interval CONSTANT INTERVAL := interval '12 minutes';
  v_candidate RECORD;
  v_optout JSONB;
  v_effective_context JSONB := '{}'::jsonb;
  v_org_text TEXT;
  v_failover_candidate JSONB;
  v_lease_token UUID;
BEGIN
  IF to_regclass('public.outbound_calls') IS NULL THEN
    RETURN;
  END IF;

  -- Retain p_batch in the signature for compatibility, but fail closed on nonsensical input.
  IF COALESCE(p_batch, 1) < 1 THEN
    RETURN;
  END IF;

  FOR v_candidate IN
    SELECT
      oc.id,
      oc.call_type,
      oc.shipment_id
    FROM public.outbound_calls oc
    WHERE oc.status IN ('pending_edge', 'failed')
      AND oc.scheduled_at <= now()
      AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
      AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries)
    ORDER BY oc.priority DESC, oc.scheduled_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_candidate.call_type = 'provider_api' THEN
      v_failover_candidate := public.resolve_outbound_failover_candidate_v1(
        v_candidate.id,
        'claim_pending_edge_jobs',
        NULL,
        NULL
      );
      IF COALESCE((v_failover_candidate->>'applied')::BOOLEAN, FALSE) THEN
        PERFORM public.apply_outbound_call_failover_v1(
          v_candidate.id,
          v_failover_candidate,
          'claim_pending_edge_jobs',
          NULL
        );
      END IF;
    END IF;

    SELECT COALESCE(oc.context, '{}'::jsonb)
    INTO v_effective_context
    FROM public.outbound_calls oc
    WHERE oc.id = v_candidate.id;

    v_optout := public.should_skip_outbound_call_for_opt_out(
      v_candidate.call_type,
      v_candidate.shipment_id,
      v_effective_context
    );

    IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
      UPDATE public.outbound_calls oc
      SET
        status = 'skipped',
        error_message = COALESCE(v_optout->>'reason', 'skipped'),
        completed_at = now(),
        lease_expires_at = NULL,
        edge_lease_token = NULL
      WHERE oc.id = v_candidate.id;

      v_org_text := COALESCE(v_effective_context->>'organization_id', '');
      IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        PERFORM public.log_decision(
          p_organization_id := v_org_text::UUID,
          p_decision_category := 'outbound_call',
          p_resource_type := 'outbound_call',
          p_resource_id := v_candidate.id,
          p_decision_point := 'opt_out_enforcement',
          p_decision_outcome := 'skipped',
          p_performed_by_system := 'claim_pending_edge_job_ids_v1',
          p_correlation_id := NULL,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'reason', v_optout->>'reason',
            'recipient_id', v_optout->>'recipient_id',
            'channel', v_optout->>'channel'
          )),
          p_decision_reason := 'Outbound call suppressed by opt-out policy.'
        );
      END IF;
      CONTINUE;
    END IF;

    v_lease_token := gen_random_uuid();
    UPDATE public.outbound_calls oc
    SET
      status = 'in_progress_edge',
      lease_expires_at = now() + v_lease_interval,
      edge_lease_token = v_lease_token
    WHERE oc.id = v_candidate.id;

    job_id := v_candidate.id;
    lease_token := v_lease_token;
    RETURN NEXT;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_edge_job_by_id_v1(p_job_id UUID)
RETURNS TABLE (job_id UUID, lease_token UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_lease_token UUID := gen_random_uuid();
BEGIN
  UPDATE public.outbound_calls oc
  SET
    status = 'in_progress_edge',
    lease_expires_at = now() + interval '12 minutes',
    edge_lease_token = v_lease_token
  WHERE oc.id = p_job_id
    AND oc.status IN ('pending_edge', 'failed')
    AND oc.scheduled_at <= now()
    AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
    AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries)
  RETURNING oc.id, oc.edge_lease_token INTO job_id, lease_token;

  IF job_id IS NULL OR lease_token IS NULL THEN
    RAISE EXCEPTION 'claim_edge_job_by_id_v1: outbound call % is not claimable', p_job_id;
  END IF;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_claimed_edge_job_call_spec_v1(
  p_job_id UUID,
  p_lease_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_job RECORD;
  v_spec JSONB;
  v_error TEXT;
  v_org_text TEXT;
BEGIN
  SELECT oc.call_type, COALESCE(oc.context, '{}'::jsonb) AS context
  INTO v_job
  FROM public.outbound_calls oc
  WHERE oc.id = p_job_id
    AND oc.status = 'in_progress_edge'
    AND oc.edge_lease_token = p_lease_token
    AND oc.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'get_claimed_edge_job_call_spec_v1: active lease for job % not found', p_job_id;
  END IF;

  BEGIN
    v_spec := public.get_job_call_spec(p_job_id);
  EXCEPTION
    WHEN others THEN
      v_error := SQLERRM;
      UPDATE public.outbound_calls oc
      SET
        status = 'permanently_failed',
        error_message = v_error,
        completed_at = now(),
        lease_expires_at = NULL,
        edge_lease_token = NULL
      WHERE oc.id = p_job_id
        AND oc.status = 'in_progress_edge'
        AND oc.edge_lease_token = p_lease_token
        AND oc.lease_expires_at > now();

      IF NOT FOUND THEN
        RAISE EXCEPTION 'get_claimed_edge_job_call_spec_v1: lease for job % changed during spec resolution', p_job_id;
      END IF;

      v_org_text := COALESCE(v_job.context->>'organization_id', '');
      IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        PERFORM public.log_decision(
          p_organization_id := v_org_text::UUID,
          p_decision_category := 'outbound_call',
          p_resource_type := 'outbound_call',
          p_resource_id := p_job_id,
          p_decision_point := 'edge_claim_spec',
          p_decision_outcome := 'permanently_failed',
          p_performed_by_system := 'get_claimed_edge_job_call_spec_v1',
          p_correlation_id := NULL,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'call_type', v_job.call_type,
            'reason', 'spec_resolution_failed',
            'error', v_error
          )),
          p_decision_reason := 'Claimed Edge job has an invalid call specification.'
        );
      END IF;
      RETURN NULL;
  END;

  RETURN jsonb_build_object(
    'url', COALESCE((v_job.context->'edge_dispatch')->>'url', v_spec->>'url'),
    'method', COALESCE(upper((v_job.context->'edge_dispatch')->>'method'), upper(v_spec->>'method'), 'POST'),
    'headers', COALESCE((v_job.context->'edge_dispatch')->'headers', v_spec->'headers', '{}'::jsonb),
    'body', COALESCE((v_job.context->'edge_dispatch')->'body', v_spec->'body', '{}'::jsonb),
    'timeout_seconds', COALESCE(
      NULLIF((v_job.context->'edge_dispatch')->>'timeout_seconds', '')::INT,
      NULLIF(v_spec->>'timeout_seconds', '')::INT,
      30
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.renew_claimed_edge_job_lease_v1(
  p_job_id UUID,
  p_lease_token UUID
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_lease_expires_at TIMESTAMPTZ;
BEGIN
  UPDATE public.outbound_calls oc
  SET lease_expires_at = now() + interval '12 minutes'
  WHERE oc.id = p_job_id
    AND oc.status = 'in_progress_edge'
    AND oc.edge_lease_token = p_lease_token
    AND oc.lease_expires_at > now()
  RETURNING oc.lease_expires_at INTO v_lease_expires_at;

  IF v_lease_expires_at IS NULL THEN
    RAISE EXCEPTION 'renew_claimed_edge_job_lease_v1: active lease for job % not found', p_job_id;
  END IF;
  RETURN v_lease_expires_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_claimed_edge_job_success_v1(
  p_job_id UUID,
  p_lease_token UUID,
  p_status_code INT,
  p_headers JSONB,
  p_body JSONB,
  p_latency_ms INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  PERFORM 1
  FROM public.outbound_calls oc
  WHERE oc.id = p_job_id
    AND oc.status = 'in_progress_edge'
    AND oc.edge_lease_token = p_lease_token
    AND oc.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_claimed_edge_job_success_v1: active lease for job % not found', p_job_id;
  END IF;

  PERFORM public.mark_outbound_call_success(
    p_job_id,
    p_status_code,
    p_headers,
    p_body,
    p_latency_ms
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_claimed_edge_job_failure_v1(
  p_job_id UUID,
  p_lease_token UUID,
  p_status_code INT,
  p_headers JSONB,
  p_body JSONB,
  p_error TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  PERFORM 1
  FROM public.outbound_calls oc
  WHERE oc.id = p_job_id
    AND oc.status = 'in_progress_edge'
    AND oc.edge_lease_token = p_lease_token
    AND oc.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_claimed_edge_job_failure_v1: active lease for job % not found', p_job_id;
  END IF;

  PERFORM public.mark_outbound_call_failure(
    p_job_id,
    p_status_code,
    p_headers,
    p_body,
    p_error
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.claim_pending_edge_job_ids_v1(p_batch INT DEFAULT 1)
RETURNS TABLE (job_id UUID, lease_token UUID)
LANGUAGE sql
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT * FROM public.claim_pending_edge_job_ids_v1(p_batch);
$function$;

CREATE OR REPLACE FUNCTION api.claim_edge_job_by_id_v1(p_job_id UUID)
RETURNS TABLE (job_id UUID, lease_token UUID)
LANGUAGE sql
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT * FROM public.claim_edge_job_by_id_v1(p_job_id);
$function$;

CREATE OR REPLACE FUNCTION api.get_claimed_edge_job_call_spec_v1(p_job_id UUID, p_lease_token UUID)
RETURNS JSONB
LANGUAGE sql
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.get_claimed_edge_job_call_spec_v1(p_job_id, p_lease_token);
$function$;

CREATE OR REPLACE FUNCTION api.renew_claimed_edge_job_lease_v1(p_job_id UUID, p_lease_token UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.renew_claimed_edge_job_lease_v1(p_job_id, p_lease_token);
$function$;

CREATE OR REPLACE FUNCTION api.mark_claimed_edge_job_success_v1(
  p_job_id UUID,
  p_lease_token UUID,
  p_status_code INT,
  p_headers JSONB,
  p_body JSONB,
  p_latency_ms INT
)
RETURNS VOID
LANGUAGE sql
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.mark_claimed_edge_job_success_v1(
    p_job_id, p_lease_token, p_status_code, p_headers, p_body, p_latency_ms
  );
$function$;

CREATE OR REPLACE FUNCTION api.mark_claimed_edge_job_failure_v1(
  p_job_id UUID,
  p_lease_token UUID,
  p_status_code INT,
  p_headers JSONB,
  p_body JSONB,
  p_error TEXT
)
RETURNS VOID
LANGUAGE sql
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.mark_claimed_edge_job_failure_v1(
    p_job_id, p_lease_token, p_status_code, p_headers, p_body, p_error
  );
$function$;

CREATE OR REPLACE FUNCTION api.resolve_effective_outbound_egress_policy_v1(p_job_id UUID)
RETURNS JSONB
LANGUAGE sql
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.resolve_effective_outbound_egress_policy_v1(p_job_id);
$function$;

CREATE OR REPLACE FUNCTION api.log_api_call_event(
  p_job_id UUID,
  p_request JSONB,
  p_response JSONB,
  p_status INT,
  p_latency_ms INT,
  p_error TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.log_api_call_event(
    p_job_id, p_request, p_response, p_status, p_latency_ms, p_error
  );
$function$;

DO $do$
DECLARE
  v_role TEXT;
  v_signature TEXT;
  v_callable_signatures TEXT[] := ARRAY[
    -- New token-fenced public contracts.
    'public.claim_pending_edge_job_ids_v1(INT)',
    'public.claim_edge_job_by_id_v1(UUID)',
    'public.get_claimed_edge_job_call_spec_v1(UUID, UUID)',
    'public.renew_claimed_edge_job_lease_v1(UUID, UUID)',
    'public.mark_claimed_edge_job_success_v1(UUID, UUID, INT, JSONB, JSONB, INT)',
    'public.mark_claimed_edge_job_failure_v1(UUID, UUID, INT, JSONB, JSONB, TEXT)',
    -- Safe api-schema wrappers used by the Edge runtime.
    'api.claim_pending_edge_job_ids_v1(INT)',
    'api.claim_edge_job_by_id_v1(UUID)',
    'api.get_claimed_edge_job_call_spec_v1(UUID, UUID)',
    'api.renew_claimed_edge_job_lease_v1(UUID, UUID)',
    'api.mark_claimed_edge_job_success_v1(UUID, UUID, INT, JSONB, JSONB, INT)',
    'api.mark_claimed_edge_job_failure_v1(UUID, UUID, INT, JSONB, JSONB, TEXT)',
    'api.resolve_effective_outbound_egress_policy_v1(UUID)',
    'api.log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT)',
    -- Retained public SECURITY DEFINER helpers. These remain for compatibility,
    -- but only the service identities may execute them.
    'public.claim_pending_edge_jobs(INT)',
    'public.get_job_call_spec(UUID)',
    'public.log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT)',
    'public.resolve_effective_outbound_egress_policy_v1(UUID)',
    'public.mark_outbound_call_in_progress(UUID)',
    'public.mark_outbound_call_success(UUID, INT, JSONB, JSONB, INT)',
    'public.mark_outbound_call_failure(UUID, INT, JSONB, JSONB, TEXT)',
    'public.mark_outbound_call_failure_v2(UUID, INT, JSONB, JSONB, TEXT, TEXT, UUID)',
    -- Historical api wrappers are not used by the repaired runtime. Keep them
    -- compatibility-restricted rather than creating any new unfenced wrapper.
    'api.claim_pending_edge_jobs(INT)',
    'api.get_job_call_spec(UUID)',
    'api.mark_outbound_call_in_progress(UUID)',
    'api.mark_outbound_call_success(UUID, INT, JSONB, JSONB, INT)',
    'api.mark_outbound_call_failure(UUID, INT, JSONB, JSONB, TEXT)'
  ];
BEGIN
  REVOKE ALL ON FUNCTION public.clear_stale_edge_lease_token_v1() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.clear_stale_edge_lease_token_v1() FROM %I',
        v_role
      );
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY v_callable_signatures
  LOOP
    IF to_regprocedure(v_signature) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
      LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
          EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', v_signature, v_role);
        END IF;
      END LOOP;

      FOREACH v_role IN ARRAY ARRAY['service_role', 'edge_api_caller_role']
      LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
          EXECUTE format('GRANT USAGE ON SCHEMA public, api TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_signature, v_role);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END;
$do$;

COMMENT ON FUNCTION public.claim_pending_edge_job_ids_v1(INT)
IS 'Claims exactly one immediately executable Edge outbound job with a fresh opaque 12-minute ownership token.';

COMMENT ON FUNCTION public.get_claimed_edge_job_call_spec_v1(UUID, UUID)
IS 'Resolves one claimed Edge dispatch only for its current unexpired ownership token.';

COMMENT ON FUNCTION public.renew_claimed_edge_job_lease_v1(UUID, UUID)
IS 'Renews one active token-owned Edge lease to 12 minutes, covering the 600-second request cap plus bounded overhead.';

COMMENT ON FUNCTION public.mark_claimed_edge_job_success_v1(UUID, UUID, INT, JSONB, JSONB, INT)
IS 'Completes one Edge job only when the caller still owns its active lease token.';

COMMENT ON FUNCTION public.mark_claimed_edge_job_failure_v1(UUID, UUID, INT, JSONB, JSONB, TEXT)
IS 'Fails one Edge job only when the caller still owns its active lease token.';

COMMIT;
