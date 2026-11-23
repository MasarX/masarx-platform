BEGIN;

SET LOCAL lock_timeout = '30s';

-- The 2b-1 migration removed the shared SQL batch tick. Disable the legacy
-- claimant while preserving its return type for the trusted compatibility caller.
CREATE OR REPLACE FUNCTION public.claim_pending_edge_jobs(p_batch INT DEFAULT 10)
RETURNS TABLE (
  job_id UUID,
  dispatch JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  -- Keep the old return contract for trusted callers, without acquiring any work.
  -- Edge dispatch uses claim_pending_edge_job_ids_v1 or claim_edge_job_by_id_v1.
  RETURN;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_pending_edge_jobs(integer)
  FROM PUBLIC, anon, authenticated, edge_api_caller_role, ui_rpc_executor;
REVOKE EXECUTE ON FUNCTION api.claim_pending_edge_jobs(integer)
  FROM PUBLIC, anon, authenticated, edge_api_caller_role, ui_rpc_executor;
GRANT EXECUTE ON FUNCTION public.claim_pending_edge_jobs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION api.claim_pending_edge_jobs(integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.log_api_call_event(uuid, jsonb, jsonb, integer, integer, text)
  FROM edge_api_caller_role;
REVOKE EXECUTE ON FUNCTION api.log_api_call_event(uuid, jsonb, jsonb, integer, integer, text)
  FROM edge_api_caller_role;

CREATE OR REPLACE FUNCTION public.claim_pending_jobs(
    p_batch_size INT
)
RETURNS TABLE (
    job_id UUID,
    call_type TEXT,
    target_type TEXT,
    target_id UUID,
    method TEXT,
    url TEXT,
    headers JSONB,
    body JSONB,
    priority INT,
    retry_count INT,
    max_retries INT,
    correlation_id UUID,
    shipment_id UUID,
    context JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_placeholder uuid;
    v_limit integer := GREATEST(COALESCE(p_batch_size, 10), 1);
BEGIN
    -- Keep the fail-closed policy read. Either setting leaves pending_edge to the leased claimant.
    PERFORM public.resolve_edge_dispatch_enabled_v1();

    -- Retire unrendered channel rows before the generic worker takes a lease.
    FOR v_placeholder IN
        SELECT oc.id FROM public.outbound_calls oc
         WHERE oc.status = 'pending'
           AND oc.renderer_credential_ref IS NULL
           AND oc.scheduled_at <= now()
           AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
           AND public.outbound_placeholder_url_v1(oc.url)
           AND NOT COALESCE(oc.context ? 'async_request_id', false)
         ORDER BY oc.priority DESC, oc.scheduled_at
         LIMIT v_limit
         FOR UPDATE SKIP LOCKED
    LOOP
        PERFORM public.mark_outbound_url_invalid_v1(v_placeholder, 'outbound_worker');
    END LOOP;

    RETURN QUERY
    UPDATE public.outbound_calls AS oc
       SET lease_expires_at = now() + interval '30 seconds'
     WHERE oc.id IN (
        SELECT oc2.id
          FROM public.outbound_calls oc2
         WHERE oc2.status = 'pending'
           AND oc2.renderer_credential_ref IS NULL
           AND (public.outbound_placeholder_url_v1(oc2.url) IS NOT TRUE
                OR oc2.context ? 'async_request_id')
           AND oc2.scheduled_at <= now()
           AND (oc2.lease_expires_at IS NULL OR oc2.lease_expires_at < now())
         ORDER BY oc2.priority DESC, oc2.scheduled_at
         LIMIT v_limit
         FOR UPDATE SKIP LOCKED
     )
     RETURNING oc.id, oc.call_type, oc.target_type, oc.target_id, oc.method, oc.url, oc.headers, oc.body,
               oc.priority, oc.retry_count, oc.max_retries, oc.correlation_id, oc.shipment_id, oc.context;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_pending_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_jobs(integer) TO service_role;

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
      oc.url,
      oc.renderer_credential_ref,
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
    IF public.outbound_placeholder_url_v1(v_candidate.url) THEN
      PERFORM public.mark_outbound_url_invalid_v1(v_candidate.id, 'claim_pending_edge_job_ids_v1');
      CONTINUE;
    END IF;

    IF v_candidate.call_type = 'provider_api' AND v_candidate.renderer_credential_ref IS NULL THEN
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

REVOKE EXECUTE ON FUNCTION public.claim_pending_edge_job_ids_v1(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_edge_job_ids_v1(integer) TO service_role, edge_api_caller_role;

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

REVOKE EXECUTE ON FUNCTION public.claim_edge_job_by_id_v1(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_edge_job_by_id_v1(uuid) TO service_role, edge_api_caller_role;

CREATE OR REPLACE FUNCTION public.get_claimed_edge_job_call_spec_v1(p_job_id uuid, p_lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_spec JSONB;
  v_dispatch JSONB;
  v_error TEXT;
  v_org_text TEXT;
BEGIN
  SELECT oc.call_type, oc.url, oc.headers, oc.body, oc.renderer_credential_ref,
    COALESCE(oc.context, '{}'::jsonb) AS context
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
    IF public.outbound_placeholder_url_v1(v_job.url) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_url_invalid';
    END IF;

    IF v_job.renderer_credential_ref IS NOT NULL THEN
      v_spec := public.resolve_label_renderer_edge_config_v1(NULLIF(v_job.context->>'organization_id', '')::uuid);
      IF v_spec->>'state' <> 'ready'
         OR v_spec->>'url' IS DISTINCT FROM v_job.url
         OR (v_spec->>'renderer_credential_ref')::uuid IS DISTINCT FROM v_job.renderer_credential_ref THEN
        RAISE EXCEPTION 'label_renderer_configuration_changed';
      END IF;
      RETURN jsonb_build_object(
        'url', v_job.url, 'method', 'POST', 'body', v_job.body, 'headers', '{}'::jsonb,
        'timeout_seconds', v_spec->'timeout_seconds',
        'renderer_credential_ref', v_job.renderer_credential_ref
      );
    END IF;
    v_spec := public.get_job_call_spec(p_job_id);
    v_dispatch := COALESCE(v_job.context->'edge_dispatch', '{}'::jsonb);
    -- Keep a credential-enriched spec together, including its vetted destination.
    IF (v_spec->>'url') IS DISTINCT FROM v_job.url
       OR (v_spec->'headers') IS DISTINCT FROM COALESCE(v_job.headers, '{}'::jsonb)
       OR (v_spec->'body') IS DISTINCT FROM COALESCE(v_job.body, '{}'::jsonb) THEN
      v_dispatch := jsonb_build_object('timeout_seconds', v_dispatch->'timeout_seconds');
    END IF;
    v_spec := v_spec || jsonb_build_object(
      'url', COALESCE(v_dispatch->>'url', v_spec->>'url'),
      'headers', public.outbound_dispatch_headers_v1(
        COALESCE(v_dispatch->>'url', v_spec->>'url'),
        COALESCE(v_dispatch->'headers', v_spec->'headers'),
        p_job_id
      )
    );
  EXCEPTION
    WHEN others THEN
      -- Resolver errors can contain request data. Persist only stable category codes.
      v_error := CASE
        WHEN SQLERRM IN ('outbound_url_invalid', 'label_renderer_configuration_changed') THEN SQLERRM
        ELSE 'outbound_spec_resolution_failed'
      END;
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
        BEGIN
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
        EXCEPTION WHEN OTHERS THEN
          IF v_error <> 'outbound_url_invalid' THEN
            RAISE;
          END IF;
          -- Preserve the terminal URL rejection if its audit insert fails.
          RAISE WARNING 'outbound_edge_claim_spec_audit_failed';
        END;
      END IF;
      RETURN NULL;
  END;

  RETURN jsonb_build_object(
    'url', v_spec->>'url',
    'method', COALESCE(upper(v_dispatch->>'method'), upper(v_spec->>'method'), 'POST'),
    'headers', v_spec->'headers',
    'body', COALESCE(v_dispatch->'body', v_spec->'body', '{}'::jsonb),
    'timeout_seconds', COALESCE(
      NULLIF(v_dispatch->>'timeout_seconds', '')::INT,
      NULLIF(v_spec->>'timeout_seconds', '')::INT,
      30
    )
  ) || CASE WHEN v_spec->>'url' COLLATE "C" ~* '^http://' THEN
    jsonb_build_object('http_allowed_host',
      substring(lower((v_spec->>'url') COLLATE "C") FROM '^http://([a-z0-9.-]+)'))
  ELSE '{}'::jsonb END;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_claimed_edge_job_call_spec_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_claimed_edge_job_call_spec_v1(uuid, uuid)
  TO service_role, edge_api_caller_role;

CREATE OR REPLACE FUNCTION public.mark_claimed_edge_job_failure_v1(
  p_job_id UUID,
  p_lease_token UUID,
  p_status_code INT,
  p_headers JSONB,
  p_body JSONB,
  p_error TEXT,
  p_latency_ms INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_correlation_id uuid;
BEGIN
  SELECT oc.correlation_id INTO v_correlation_id
  FROM public.outbound_calls oc
  WHERE oc.id = p_job_id
    AND oc.status = 'in_progress_edge'
    AND oc.edge_lease_token = p_lease_token
    AND oc.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_claimed_edge_job_failure_v1: active lease for job % not found', p_job_id;
  END IF;

  UPDATE public.outbound_calls
     SET status = 'permanently_failed',
         response_status_code = p_status_code,
         response_headers = public.redact_sensitive_headers(COALESCE(p_headers, '{}'::jsonb)),
         response_body = p_body,
         error_message = COALESCE(p_error, 'label_renderer_dispatch_failed'),
         completed_at = now(),
         lease_expires_at = NULL,
         edge_lease_token = NULL
   WHERE id = p_job_id AND renderer_credential_ref IS NOT NULL;
  IF FOUND THEN
    RETURN;
  END IF;

  -- The failure policy may retarget the canonical request before scheduling a retry.
  BEGIN
    PERFORM public.log_api_call_event(p_job_id, '{}'::jsonb,
      jsonb_build_object('headers', p_headers, 'body', p_body), p_status_code, p_latency_ms, 'outbound_call_failed');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'outbound_api_audit_failed';
  END;

  PERFORM public.mark_outbound_call_failure_v2(
    p_job_id,
    p_status_code,
    p_headers,
    p_body,
    p_error,
    'api_caller_edge',
    v_correlation_id
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mark_claimed_edge_job_failure_v1(uuid, uuid, integer, jsonb, jsonb, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_claimed_edge_job_failure_v1(uuid, uuid, integer, jsonb, jsonb, text, integer)
  TO service_role, edge_api_caller_role;

CREATE OR REPLACE FUNCTION public.handoff_outbound_call_to_edge_v1(
  p_job_id uuid, p_method text, p_headers jsonb, p_timeout_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_dispatch jsonb;
  v_timeout integer := COALESCE(p_timeout_seconds,
    (public.resolve_settings('api_caller_policy', 'global', NULL)->>'default_timeout_seconds')::integer, 30);
BEGIN
  IF v_timeout <= 0 THEN
    RAISE EXCEPTION 'Resolved timeout must be positive (resolved=%)', v_timeout;
  END IF;

  -- Resolve the URL and body again under the Edge lease instead of persisting an enriched spec.
  v_dispatch := jsonb_build_object(
    'method', upper(COALESCE(NULLIF(p_method, ''), 'POST')),
    'headers', public.sql_transport_headers_v1(p_headers),
    'timeout_seconds', v_timeout
  );

  UPDATE public.outbound_calls
  SET status = 'pending_edge',
      scheduled_at = now(),
      lease_expires_at = NULL,
      edge_lease_token = NULL,
      context = jsonb_set(COALESCE(context, '{}'::jsonb) - 'async_request_id',
                          '{edge_dispatch}', v_dispatch, true)
  WHERE id = p_job_id;

  RETURN v_dispatch;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.handoff_outbound_call_to_edge_v1(uuid, text, jsonb, integer)
  FROM PUBLIC, anon, authenticated, service_role, edge_api_caller_role, ui_rpc_executor;

CREATE OR REPLACE FUNCTION public.run_outbound_worker()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_job RECORD;
    v_org UUID;
    v_dispatch_headers JSONB;
    v_edge_dispatch JSONB;
    v_status INT;
    v_completed BOOLEAN;
    v_optout JSONB;
    v_async_request_id BIGINT := NULL;
    v_poll JSONB := NULL;
    v_policy_row RECORD;
    v_policy_ctx JSONB;
    v_defaults JSONB;
    v_poll_seconds INT := NULL;
    v_poll_min INT := NULL;
    v_poll_max INT := NULL;
    v_settings_resolution_id UUID := NULL;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_settings_version_id UUID;
    v_policy_version INT;
    v_scope_path JSONB;
BEGIN
    SELECT * INTO v_throttle FROM public.check_throttle('outbound_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := public.create_request_context('outbound_worker');

    FOR v_job IN SELECT oc.workflow_run_step_id, cpj.* FROM public.claim_pending_jobs(v_throttle.batch_size) cpj JOIN public.outbound_calls oc ON oc.id = cpj.job_id
    LOOP
        BEGIN
            IF v_job.target_type = 'provider' THEN
                v_org := public.resolve_organization_id_strict('provider', v_job.target_id);
            ELSIF v_job.target_type = 'client' THEN
                v_org := public.resolve_organization_id_strict('client', v_job.target_id);
            ELSIF v_job.shipment_id IS NOT NULL THEN
                v_org := public.resolve_organization_id_strict('shipment', v_job.shipment_id);
            ELSE
                v_org := public.resolve_organization_id_strict('outbound_call', v_job.job_id);
            END IF;

            v_policy_ctx := NULL;
            v_policy_row := NULL;
            v_defaults := NULL;
            v_poll_seconds := NULL;
            v_poll_min := NULL;
            v_poll_max := NULL;
            v_settings_resolution_id := NULL;
            v_scope_path := NULL;

            IF v_job.workflow_run_step_id IS NOT NULL THEN
                SELECT r.context
                  INTO v_policy_ctx
                  FROM public.workflow_run_steps s
                  JOIN public.workflow_runs r ON r.id = s.workflow_run_id
                 WHERE s.id = v_job.workflow_run_step_id;
            END IF;

            v_policy_ctx := jsonb_strip_nulls(
              COALESCE(v_policy_ctx, v_job.context, '{}'::jsonb) || jsonb_build_object('organization_id', v_org)
            );

            SELECT *
              INTO v_policy_row
              FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
             LIMIT 1;

            IF NOT FOUND OR v_policy_row.value IS NULL THEN
                SELECT *
                  INTO v_policy_row
                  FROM public.resolve_settings_row('workflow_defaults', 'global', NULL)
                 LIMIT 1;
            END IF;

            v_defaults := v_policy_row.value;
            IF v_defaults IS NULL THEN
                RAISE EXCEPTION 'workflow_defaults_missing';
            END IF;

            v_policy_scope_type := v_policy_row.scope_type;
            v_policy_scope_id := v_policy_row.scope_id;
            v_policy_settings_id := v_policy_row.settings_id;
            v_policy_settings_version_id := v_policy_row.settings_version_id;
            v_policy_version := v_policy_row.version;
            v_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb);

            v_settings_resolution_id := public.log_settings_resolution(
                p_organization_id := v_org,
                p_category := 'workflow_defaults',
                p_winning_scope_type := v_policy_scope_type,
                p_winning_scope_id := v_policy_scope_id,
                p_winning_settings_id := v_policy_settings_id,
                p_winning_settings_version_id := v_policy_settings_version_id,
                p_winning_version := v_policy_version,
                p_scope_path := v_scope_path,
                p_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'job_id', v_job.job_id,
                    'call_type', v_job.call_type,
                    'target_type', v_job.target_type,
                    'target_id', v_job.target_id
                )),
                p_merge_notes := jsonb_build_object('source', 'run_outbound_worker')
            );

            BEGIN
                v_poll_seconds := NULLIF(v_defaults->>'outbound_poll_seconds', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_seconds := NULL;
            END;
            IF v_poll_seconds IS NULL THEN
                BEGIN
                    v_poll_seconds := NULLIF(v_defaults->>'poll_seconds', '')::INT;
                EXCEPTION
                    WHEN others THEN
                        v_poll_seconds := NULL;
                END;
            END IF;
            IF v_poll_seconds IS NULL THEN
                RAISE EXCEPTION 'workflow_defaults.poll_seconds missing';
            END IF;

            BEGIN
                v_poll_min := NULLIF(v_defaults->>'poll_seconds_min', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_min := NULL;
            END;
            BEGIN
                v_poll_max := NULLIF(v_defaults->>'poll_seconds_max', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_max := NULL;
            END;

            v_poll_min := COALESCE(v_poll_min, v_poll_seconds);
            v_poll_max := COALESCE(v_poll_max, v_poll_seconds);
            v_poll_seconds := LEAST(GREATEST(v_poll_seconds, v_poll_min), v_poll_max);

            v_optout := public.should_skip_outbound_call_for_opt_out(
              v_job.call_type,
              v_job.shipment_id,
              COALESCE(v_job.context, '{}'::jsonb)
            );
            IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
                UPDATE public.outbound_calls
                   SET status = 'skipped',
                       completed_at = now(),
                       lease_expires_at = NULL,
                       error_message = COALESCE(v_optout->>'reason', 'skipped')
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'opt_out',
                    p_decision_outcome := 'skipped',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := v_optout,
                    p_decision_reason := v_optout->>'reason',
                    p_settings_resolution_id := v_settings_resolution_id
                );

                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;
            v_async_request_id := NULL;
            BEGIN
                v_async_request_id := NULLIF(v_job.context->>'async_request_id', '')::BIGINT;
            EXCEPTION
                WHEN others THEN
                    v_async_request_id := NULL;
            END;

            IF v_async_request_id IS NOT NULL THEN
                v_poll := public.check_async_response(v_async_request_id);
                v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
                v_status := COALESCE((v_poll->>'status')::INT, 0);

                IF NOT v_completed THEN
                    UPDATE public.outbound_calls
                       SET status = 'pending',
                           scheduled_at = now() + make_interval(secs => v_poll_seconds),
                           lease_expires_at = NULL
                     WHERE id = v_job.job_id;

                    PERFORM public.log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'async_pending',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_inputs := jsonb_build_object(
                          'async_request_id', v_async_request_id,
                          'poll', v_poll,
                          'poll_seconds', v_poll_seconds
                        ),
                        p_decision_reason := 'Awaiting async HTTP response (polling pg_net).',
                        p_settings_resolution_id := v_settings_resolution_id
                    );

                    v_items_processed := v_items_processed + 1;
                    CONTINUE;
                END IF;

                IF v_completed AND v_status BETWEEN 200 AND 299 THEN
                    UPDATE public.outbound_calls
                       SET status = 'completed',
                           response_status_code = v_status,
                           response_body = v_poll->'body',
                           response_headers = v_poll->'headers',
                           completed_at = now(),
                           error_message = NULL,
                           lease_expires_at = NULL,
                           context = (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id' - 'edge_dispatch')
                     WHERE id = v_job.job_id;

                    -- Response processing failures should not flip delivery state or trigger resends.
                    BEGIN
                      PERFORM public.orchestrate_api_response_processing(v_job.job_id);
                    EXCEPTION
                      WHEN OTHERS THEN
                        v_error := TRUE;
                        UPDATE public.outbound_calls
                           SET requires_investigation = TRUE,
                               root_cause = 'response_processing_exception',
                               resolution_notes = SQLERRM
                         WHERE id = v_job.job_id;

                        PERFORM public.log_decision(
                          p_organization_id := v_org,
                          p_decision_category := 'outbound_call',
                          p_resource_type := 'outbound_call',
                          p_resource_id := v_job.job_id,
                          p_decision_point := 'response_processing',
                          p_decision_outcome := 'exception',
                          p_performed_by_system := 'outbound_worker',
                          p_correlation_id := v_job.correlation_id,
                          p_decision_reason := SQLERRM
                        );
                    END;

                    -- F267 audit begin
                    BEGIN
                        PERFORM public.log_api_call_event(
                            v_job.job_id, '{}'::jsonb,
                            jsonb_build_object('headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                                               'body', COALESCE(v_poll->'body', '{}'::jsonb)),
                            v_status, NULL, NULL
                        );
                    EXCEPTION
                        WHEN OTHERS THEN
                            -- Audit failure must not undo a delivered request or schedule a resend.
                            RAISE WARNING 'outbound_api_audit_failed';
                    END;
                    -- F267 audit end

                    PERFORM public.log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'success',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_inputs := jsonb_build_object(
                          'status', v_status,
                          'async_request_id', v_async_request_id
                        ),
                        p_decision_reason := 'Outbound HTTP request completed successfully.'
                    );

                    BEGIN
                      PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                    EXCEPTION
                      WHEN OTHERS THEN
                        NULL;
                    END;
                ELSE
                    -- F267 audit begin
                    BEGIN
                        PERFORM public.log_api_call_event(
                            v_job.job_id, '{}'::jsonb,
                            jsonb_build_object('headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                                               'body', COALESCE(v_poll->'body', '{}'::jsonb)),
                            v_status, NULL, 'outbound_call_failed'
                        );
                    EXCEPTION
                        WHEN OTHERS THEN
                            -- Audit failure must not undo a delivered request or schedule a resend.
                            RAISE WARNING 'outbound_api_audit_failed';
                    END;
                    -- F267 audit end

                    PERFORM public.mark_outbound_call_failure_v2(
                      p_job_id := v_job.job_id,
                      p_status_code := v_status,
                      p_headers := COALESCE(v_poll->'headers', '{}'::jsonb),
                      p_body := COALESCE(v_poll->'body', '{}'::jsonb),
                      p_error := COALESCE(v_poll->'body'->>'error', format('HTTP %s failure', v_status)),
                      p_performed_by_system := 'outbound_worker',
                      p_correlation_id := v_job.correlation_id
                    );


                    BEGIN
                      PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                    EXCEPTION
                      WHEN OTHERS THEN
                        NULL;
                    END;
                END IF;

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

            -- Validate the queued request without opening its credential references.
            BEGIN
                v_dispatch_headers := public.outbound_dispatch_headers_v1(v_job.url, v_job.headers, v_job.job_id);
            EXCEPTION
                WHEN invalid_parameter_value THEN
                    IF SQLERRM <> 'outbound_url_invalid' THEN
                        RAISE;
                    END IF;
                    PERFORM public.mark_outbound_url_invalid_v1(v_job.job_id, 'outbound_worker');
                    v_error := TRUE;
                    v_items_processed := v_items_processed + 1;
                    CONTINUE;
            END;
            BEGIN
              -- Reject raw credential headers even if the application header filter drops them.
              PERFORM public.sql_transport_headers_v1(v_job.headers);
            EXCEPTION WHEN invalid_parameter_value THEN
              IF SQLERRM <> 'outbound_credential_headers_refused' THEN RAISE; END IF;
                PERFORM public.fail_sql_outbound_credential_job_v1(v_job.job_id, 'outbound_worker');
                v_error := TRUE;
                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END;
            v_edge_dispatch := public.handoff_outbound_call_to_edge_v1(
                v_job.job_id, v_job.method, v_dispatch_headers, NULL
            );

            PERFORM public.log_decision(
                p_organization_id := v_org,
                p_decision_category := 'outbound_call',
                p_resource_type := 'outbound_call',
                p_resource_id := v_job.job_id,
                p_decision_point := 'http_execution',
                p_decision_outcome := 'async_pending',
                p_performed_by_system := 'outbound_worker',
                p_correlation_id := v_job.correlation_id,
                p_decision_inputs := v_edge_dispatch,
                p_decision_reason := 'Edge dispatch required for outbound HTTP execution.',
                p_settings_resolution_id := v_settings_resolution_id
            );

            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;

                BEGIN
                  PERFORM public.mark_outbound_call_failure_v2(
                    p_job_id := v_job.job_id,
                    p_status_code := 0,
                    p_headers := '{}'::jsonb,
                    p_body := '{}'::jsonb,
                    p_error := format('exception: %s', SQLERRM),
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id
                  );

                  BEGIN
                    PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                  EXCEPTION
                    WHEN OTHERS THEN
                      NULL;
                  END;
                EXCEPTION
                  WHEN OTHERS THEN
                    UPDATE public.outbound_calls
                       SET status = 'permanently_failed',
                           retry_count = v_job.retry_count + 1,
                           error_message = SQLERRM,
                           completed_at = now(),
                           lease_expires_at = NULL
                     WHERE id = v_job.job_id;
                END;
        END;
    END LOOP;

    PERFORM public.complete_request_context(v_context, v_error, v_items_processed);
    PERFORM public.update_cron_config('outbound_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.run_outbound_worker() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_outbound_worker() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.dispatch_outbound_call_inline(p_job_id uuid, p_options jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_org UUID;
    v_optout JSONB;
    v_dispatch_headers JSONB;
    v_result JSONB := NULL;
    v_status INT := 0;
    v_completed BOOLEAN := FALSE;
    v_request_id BIGINT := NULL;
    v_poll JSONB := NULL;
    v_started_at TIMESTAMPTZ := clock_timestamp();
    v_deadline TIMESTAMPTZ := NULL;
    v_latency_ms INT := NULL;

    -- Options (strict; no behavioral defaults in code)
    v_timeout_seconds INT := NULL;
    v_poll_max_seconds INT := NULL;
    v_poll_interval_ms INT := NULL;
    v_pending_reschedule_seconds INT := NULL;
    v_lease_seconds INT := NULL;
    v_performed_by_system TEXT := NULL;
    v_correlation_id UUID := NULL;
    v_sleep_seconds DOUBLE PRECISION := NULL;

    v_error TEXT := NULL;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN jsonb_build_object('status', 'skipped', 'reason', 'outbound_calls_missing');
    END IF;

    IF p_job_id IS NULL THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'job_id_missing');
    END IF;

    -- Parse options. Thresholds/timeouts are policy-driven; caller must provide.
    v_timeout_seconds := NULLIF(p_options->>'timeout_seconds', '')::INT;
    v_poll_max_seconds := NULLIF(p_options->>'poll_max_seconds', '')::INT;
    v_poll_interval_ms := NULLIF(p_options->>'poll_interval_ms', '')::INT;
    v_pending_reschedule_seconds := NULLIF(p_options->>'pending_reschedule_seconds', '')::INT;
    v_lease_seconds := NULLIF(p_options->>'lease_seconds', '')::INT;

    v_performed_by_system := NULLIF(p_options->>'performed_by_system', '');
    IF v_performed_by_system IS NULL THEN
        v_performed_by_system := 'dispatch_outbound_call_inline';
    END IF;

    BEGIN
        v_correlation_id := NULLIF(p_options->>'correlation_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_correlation_id := NULL;
    END;

    IF v_timeout_seconds IS NULL OR v_timeout_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_timeout_missing_or_invalid';
    END IF;
    IF v_poll_max_seconds IS NULL OR v_poll_max_seconds < 0 THEN
        RAISE EXCEPTION 'inline_dispatch_poll_max_missing_or_invalid';
    END IF;
    IF v_poll_interval_ms IS NULL OR v_poll_interval_ms <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_poll_interval_missing_or_invalid';
    END IF;
    IF v_pending_reschedule_seconds IS NULL OR v_pending_reschedule_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_reschedule_missing_or_invalid';
    END IF;
    IF v_lease_seconds IS NULL OR v_lease_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_lease_missing_or_invalid';
    END IF;

    v_sleep_seconds := GREATEST(v_poll_interval_ms, 10)::DOUBLE PRECISION / 1000.0;

    SELECT *
      INTO v_job
      FROM public.outbound_calls
     WHERE id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'job_not_found', 'job_id', p_job_id);
    END IF;

    -- Only dispatch queued jobs; completed/skipped etc are no-ops.
    IF v_job.renderer_credential_ref IS NOT NULL OR v_job.status NOT IN ('pending', 'failed') THEN
        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', 'job_not_dispatchable',
            'job_id', p_job_id,
            'job_status', v_job.status
        );
    END IF;

    -- Respect due time (no early sends).
    IF v_job.scheduled_at IS NOT NULL AND v_job.scheduled_at > now() THEN
        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', 'job_not_due',
            'job_id', p_job_id,
            'scheduled_at', v_job.scheduled_at
        );
    END IF;

    -- Acquire a short lease so cron workers don't concurrently dispatch this job.
    UPDATE public.outbound_calls
       SET lease_expires_at = now() + make_interval(secs => v_lease_seconds)
     WHERE id = p_job_id;

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    v_optout := public.should_skip_outbound_call_for_opt_out(
        v_job.call_type,
        v_job.shipment_id,
        COALESCE(v_job.context, '{}'::jsonb)
    );

    IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
        UPDATE public.outbound_calls
           SET status = 'skipped',
               error_message = COALESCE(v_optout->>'reason', 'skipped'),
               completed_at = now(),
               lease_expires_at = NULL
         WHERE id = p_job_id;

        PERFORM public.log_decision(
            p_organization_id := v_org,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'opt_out',
            p_decision_outcome := 'skipped',
            p_performed_by_system := v_performed_by_system,
            p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
            p_decision_inputs := v_optout,
            p_decision_reason := v_optout->>'reason'
        );

        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', v_optout->>'reason',
            'job_id', p_job_id
        );
    END IF;

    -- If an async pg_net request_id already exists, poll it first (avoid duplicate sends).
    BEGIN
        v_request_id := NULLIF(v_job.context->>'async_request_id', '')::BIGINT;
    EXCEPTION
        WHEN others THEN
            v_request_id := NULL;
    END;

    IF v_request_id IS NOT NULL THEN
        v_poll := public.check_async_response(v_request_id);
        v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
        v_status := COALESCE((v_poll->>'status')::INT, 0);

        IF v_completed THEN
            v_result := jsonb_build_object(
                'status', v_status,
                'headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                'body', COALESCE(v_poll->'body', '{}'::jsonb),
                'completed', TRUE,
                'request_id', v_request_id
            );
        END IF;
    END IF;

    IF NOT v_completed AND v_request_id IS NULL THEN
        -- Validate the queued request without opening its credential references.
        BEGIN
            v_dispatch_headers := public.outbound_dispatch_headers_v1(v_job.url, v_job.headers, p_job_id);
        EXCEPTION
            WHEN invalid_parameter_value THEN
                IF SQLERRM <> 'outbound_url_invalid' THEN
                    RAISE;
                END IF;
                PERFORM public.mark_outbound_url_invalid_v1(p_job_id, v_performed_by_system);
                RETURN jsonb_build_object('status', 'failed', 'job_id', p_job_id, 'reason', 'outbound_url_invalid');
        END;
        BEGIN
          -- Reject raw credential headers even if the application header filter drops them.
          PERFORM public.sql_transport_headers_v1(v_job.headers);
        EXCEPTION WHEN invalid_parameter_value THEN
          IF SQLERRM <> 'outbound_credential_headers_refused' THEN RAISE; END IF;
            PERFORM public.fail_sql_outbound_credential_job_v1(p_job_id, v_performed_by_system);
            RETURN jsonb_build_object('status', 'failed', 'job_id', p_job_id, 'reason', 'outbound_credential_headers_refused');
        END;
        PERFORM public.handoff_outbound_call_to_edge_v1(
            p_job_id, v_job.method, v_dispatch_headers, v_timeout_seconds
        );
        RETURN jsonb_build_object('status', 'pending', 'job_id', p_job_id,
            'http_status', 202, 'completed', FALSE);
    END IF;

    -- Keep the polling budget for existing pg_net requests.
    IF NOT v_completed AND v_request_id IS NOT NULL AND v_poll_max_seconds > 0 THEN
        v_deadline := clock_timestamp() + make_interval(secs => v_poll_max_seconds);

        WHILE clock_timestamp() < v_deadline LOOP
            v_poll := public.check_async_response(v_request_id);
            v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
            v_status := COALESCE((v_poll->>'status')::INT, 0);

            IF v_completed THEN
                v_result := jsonb_build_object(
                    'status', v_status,
                    'headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                    'body', COALESCE(v_poll->'body', '{}'::jsonb),
                    'completed', TRUE,
                    'request_id', v_request_id
                );
                EXIT;
            END IF;

            PERFORM pg_sleep(v_sleep_seconds);
        END LOOP;
    END IF;

    v_latency_ms := ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000)::INT;

    IF v_completed AND v_status BETWEEN 200 AND 299 THEN
        UPDATE public.outbound_calls
           SET status = 'completed',
               response_status_code = v_status,
               response_body = COALESCE(v_result->'body', '{}'::jsonb),
               response_headers = COALESCE(v_result->'headers', '{}'::jsonb),
               latency_ms = v_latency_ms,
               completed_at = now(),
               error_message = NULL,
               lease_expires_at = NULL,
               context = (COALESCE(context, '{}'::jsonb) - 'async_request_id')
         WHERE id = p_job_id;

        -- Response processing failures should not flip delivery state or trigger resends.
        BEGIN
            PERFORM public.orchestrate_api_response_processing(p_job_id);
        EXCEPTION
            WHEN OTHERS THEN
                UPDATE public.outbound_calls
                   SET requires_investigation = TRUE,
                       root_cause = 'response_processing_exception',
                       resolution_notes = SQLERRM
                 WHERE id = p_job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := p_job_id,
                    p_decision_point := 'response_processing',
                    p_decision_outcome := 'exception',
                    p_performed_by_system := v_performed_by_system,
                    p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
                    p_decision_reason := SQLERRM
                );
        END;

        -- F267 audit begin
        BEGIN
            PERFORM public.log_api_call_event(
                p_job_id, '{}'::jsonb,
                jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                   'body', COALESCE(v_result->'body', '{}'::jsonb)),
                v_status, v_latency_ms, NULL
            );
        EXCEPTION
            WHEN OTHERS THEN
                -- Audit failure must not undo a delivered request or schedule a resend.
                RAISE WARNING 'outbound_api_audit_failed';
        END;
        -- F267 audit end

        PERFORM public.log_decision(
            p_organization_id := v_org,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'http_execution',
            p_decision_outcome := 'success',
            p_performed_by_system := v_performed_by_system,
            p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
            p_decision_inputs := jsonb_build_object('status', v_status, 'latency_ms', v_latency_ms),
            p_decision_reason := 'Outbound HTTP request completed inline.'
        );

        RETURN jsonb_build_object(
            'status', 'completed',
            'job_id', p_job_id,
            'http_status', v_status,
            'completed', TRUE,
            'latency_ms', v_latency_ms
        );
    END IF;

    IF v_completed THEN
        -- F267 audit begin
        BEGIN
            PERFORM public.log_api_call_event(
                p_job_id, '{}'::jsonb,
                jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                   'body', COALESCE(v_result->'body', '{}'::jsonb)),
                v_status, v_latency_ms, 'outbound_call_failed'
            );
        EXCEPTION
            WHEN OTHERS THEN
                -- Audit failure must not undo a delivered request or schedule a resend.
                RAISE WARNING 'outbound_api_audit_failed';
        END;
        -- F267 audit end

        PERFORM public.mark_outbound_call_failure(
            p_job_id,
            v_status,
            COALESCE(v_result->'headers', '{}'::jsonb),
            COALESCE(v_result->'body', '{}'::jsonb),
            COALESCE(
                NULLIF(v_result->'body'->>'error', ''),
                NULLIF(v_result->'body'->>'message', ''),
                format('HTTP %s failure', v_status)
            )
        );


        UPDATE public.outbound_calls
           SET lease_expires_at = NULL
         WHERE id = p_job_id;

        RETURN jsonb_build_object(
            'status', 'failed',
            'job_id', p_job_id,
            'http_status', v_status,
            'completed', TRUE,
            'latency_ms', v_latency_ms
        );
    END IF;

    -- Still pending: release lease and reschedule for worker.
    UPDATE public.outbound_calls
       SET status = 'pending',
           scheduled_at = now() + make_interval(secs => v_pending_reschedule_seconds),
           lease_expires_at = NULL
     WHERE id = p_job_id;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := 'async_pending',
        p_performed_by_system := v_performed_by_system,
        p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'status', v_status,
            'async_request_id', v_request_id,
            'latency_ms', v_latency_ms
        )),
        p_decision_reason := 'Inline dispatch did not complete within budget; left queued for worker.'
    );

    RETURN jsonb_build_object(
        'status', 'pending',
        'job_id', p_job_id,
        'completed', FALSE,
        'async_request_id', v_request_id,
        'latency_ms', v_latency_ms
    );
EXCEPTION
    WHEN OTHERS THEN
        v_error := SQLERRM;
        BEGIN
            UPDATE public.outbound_calls
               SET lease_expires_at = NULL
             WHERE id = p_job_id;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;
        RETURN jsonb_build_object('status', 'error', 'job_id', p_job_id, 'reason', v_error);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.dispatch_outbound_call_inline(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_outbound_call_inline(uuid, jsonb) TO service_role;

COMMIT;
