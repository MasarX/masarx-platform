-- Migration: Outbound retry policy + scheduled job claiming (edge + worker)
-- Purpose:
--   - Treat scheduled_at as a hard gate (do not claim jobs before due).
--   - Enable policy-driven retries for edge-executed outbound_calls (failed -> retry with backoff; permanent failures stop).
--   - Keep behavior row-driven via outbound_retry_policy settings (no hardcoded status-code logic in functions).
-- Date: 2025-12-14

BEGIN;

-- -----------------------------------------------------------------------------
-- Schema registry + global default: outbound_retry_policy
-- -----------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'outbound_retry_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'http', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'retryable_status_codes', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'integer')),
          'retryable_status_ranges', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object(
              'type', 'array',
              'minItems', 2,
              'maxItems', 2,
              'items', jsonb_build_object('type', 'integer')
            )
          ),
          'permanent_status_ranges', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object(
              'type', 'array',
              'minItems', 2,
              'maxItems', 2,
              'items', jsonb_build_object('type', 'integer')
            )
          ),
          'retry_after_header', jsonb_build_object('type', 'string', 'minLength', 1)
        )
      ),
      'backoff_seconds', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'integer', 'minimum', 0)),
      'max_retry_delay_seconds', jsonb_build_object('type', 'integer', 'minimum', 0),
      'respect_retry_after', jsonb_build_object('type', 'boolean'),
      'call_type_overrides', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
    )
  ),
  'Outbound HTTP retry/backoff policy (used by edge api-caller when marking failures).',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'http', jsonb_build_object(
        'retryable_status_codes', jsonb_build_array(0, 408, 429),
        'retryable_status_ranges', jsonb_build_array(jsonb_build_array(500, 599)),
        'permanent_status_ranges', jsonb_build_array(jsonb_build_array(400, 499)),
        'retry_after_header', 'retry-after'
      ),
      'backoff_seconds', jsonb_build_array(30, 120, 300),
      'max_retry_delay_seconds', 3600,
      'respect_retry_after', TRUE,
      'call_type_overrides', jsonb_build_object(
        'comms_whatsapp', jsonb_build_object('backoff_seconds', jsonb_build_array(60, 300, 900))
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'http', jsonb_build_object(
      'retryable_status_codes', jsonb_build_array(0, 408, 429),
      'retryable_status_ranges', jsonb_build_array(jsonb_build_array(500, 599)),
      'permanent_status_ranges', jsonb_build_array(jsonb_build_array(400, 499)),
      'retry_after_header', 'retry-after'
    ),
    'backoff_seconds', jsonb_build_array(30, 120, 300),
    'max_retry_delay_seconds', 3600,
    'respect_retry_after', TRUE,
    'call_type_overrides', jsonb_build_object(
      'comms_whatsapp', jsonb_build_object('backoff_seconds', jsonb_build_array(60, 300, 900))
    )
  ) AS value
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'outbound_retry_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global outbound_retry_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'outbound_retry_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'outbound_retry_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Scheduled-at gating: do not claim jobs before due
-- -----------------------------------------------------------------------------

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
BEGIN
    RETURN QUERY
    UPDATE public.outbound_calls AS oc
    SET lease_expires_at = now() + interval '30 seconds'
    WHERE oc.id IN (
        SELECT oc2.id
        FROM public.outbound_calls oc2
        WHERE oc2.status = 'pending'
          AND oc2.scheduled_at <= now()
          AND (oc2.lease_expires_at IS NULL OR oc2.lease_expires_at < now())
        ORDER BY oc2.priority DESC, oc2.scheduled_at
        LIMIT GREATEST(COALESCE(p_batch_size, 10), 1)
        FOR UPDATE SKIP LOCKED
    )
    RETURNING oc.id, oc.call_type, oc.target_type, oc.target_id, oc.method, oc.url, oc.headers, oc.body,
              oc.priority, oc.retry_count, oc.max_retries, oc.correlation_id, oc.shipment_id, oc.context;
END;
$$;

COMMENT ON FUNCTION public.claim_pending_jobs(INT)
  IS 'Claim due outbound_calls jobs (status=pending, scheduled_at<=now) by acquiring a short lease.';

DROP FUNCTION IF EXISTS public.claim_pending_edge_jobs(INT);
CREATE OR REPLACE FUNCTION public.claim_pending_edge_jobs(p_batch INT DEFAULT 10)
RETURNS TABLE (
    job_id UUID,
    dispatch JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT
            oc.id,
            oc.call_type,
            oc.shipment_id,
            oc.context,
            oc.context->'edge_dispatch' AS edge_dispatch
        FROM public.outbound_calls oc
        WHERE oc.status IN ('pending_edge', 'failed')
          AND oc.scheduled_at <= now()
          AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
          AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries)
        ORDER BY oc.priority DESC, oc.scheduled_at
        LIMIT GREATEST(COALESCE(p_batch, 10), 1)
        FOR UPDATE SKIP LOCKED
    ),
    evaluated AS (
        SELECT
            c.*,
            public.should_skip_outbound_call_for_opt_out(
                c.call_type,
                c.shipment_id,
                COALESCE(c.context, '{}'::jsonb)
            ) AS optout
        FROM candidates c
    ),
    skipped AS (
        UPDATE public.outbound_calls oc
           SET status = 'skipped',
               error_message = COALESCE(e.optout->>'reason', 'skipped'),
               completed_at = now(),
               lease_expires_at = NULL
          FROM evaluated e
         WHERE oc.id = e.id
           AND COALESCE((e.optout->>'skip')::BOOLEAN, FALSE)
         RETURNING oc.id, oc.context, e.optout
    ),
    skipped_decisions AS (
        SELECT public.log_decision(
            p_organization_id := (s.context->>'organization_id')::UUID,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := s.id,
            p_decision_point := 'opt_out_enforcement',
            p_decision_outcome := 'skipped',
            p_performed_by_system := 'claim_pending_edge_jobs',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
              'reason', s.optout->>'reason',
              'recipient_id', s.optout->>'recipient_id',
              'channel', s.optout->>'channel'
            )),
            p_decision_reason := 'Outbound call suppressed by opt-out policy.'
        )
        FROM skipped s
        WHERE (s.context->>'organization_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
    selected AS (
        SELECT
            e.id,
            e.edge_dispatch,
            public.get_job_call_spec(e.id) AS spec
        FROM evaluated e
        WHERE NOT COALESCE((e.optout->>'skip')::BOOLEAN, FALSE)
    ),
    updated AS (
        UPDATE public.outbound_calls oc
           SET status = 'in_progress_edge',
               lease_expires_at = now() + interval '5 minutes'
         WHERE oc.id IN (SELECT id FROM selected)
         RETURNING oc.id
    )
    SELECT
        s.id AS job_id,
        jsonb_build_object(
            'url', COALESCE(s.edge_dispatch->>'url', s.spec->>'url'),
            'method', COALESCE(upper(s.edge_dispatch->>'method'), upper(s.spec->>'method'), 'POST'),
            'headers', COALESCE(s.edge_dispatch->'headers', s.spec->'headers', '{}'::jsonb),
            'body', COALESCE(s.edge_dispatch->'body', s.spec->'body', '{}'::jsonb),
            'timeout_seconds', COALESCE(
                NULLIF(s.edge_dispatch->>'timeout_seconds', '')::INT,
                NULLIF(s.spec->>'timeout_seconds', '')::INT,
                30
            )
        ) AS dispatch
    FROM selected s
    JOIN updated u ON u.id = s.id;
END;
$$;

COMMENT ON FUNCTION public.claim_pending_edge_jobs(INT)
  IS 'Claim due edge-executed outbound_calls jobs (status=pending_edge or failed, scheduled_at<=now) and lease them for api-caller.';

-- -----------------------------------------------------------------------------
-- Policy-driven retry scheduling on edge failures
-- -----------------------------------------------------------------------------

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
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_org UUID;
    v_next_retry_count INT;
    v_new_status TEXT;
    v_headers_norm JSONB := public.normalize_headers(COALESCE(p_headers, '{}'::jsonb));

    v_provider_id UUID := NULL;
    v_attempt_number INT := NULL;

    -- Retry policy resolution + provenance
    v_policy_row RECORD;
    v_policy JSONB := '{}'::jsonb;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_settings_version_id UUID;
    v_policy_version INT;
    v_scope_path JSONB := '[]'::jsonb;
    v_settings_resolution_id UUID;


    -- Policy fields
    v_retryable_codes JSONB := NULL;
    v_retryable_ranges JSONB := NULL;
    v_permanent_ranges JSONB := NULL;
    v_retry_after_header TEXT;
    v_respect_retry_after BOOLEAN := NULL;
    v_backoff JSONB := NULL;
    v_max_delay_seconds INT := NULL;

    -- Computed decision
    v_is_permanent BOOLEAN := FALSE;
    v_is_retryable BOOLEAN := FALSE;
    v_should_retry BOOLEAN := FALSE;
    v_backoff_seconds INT := 0;
    v_retry_after_seconds INT := NULL;
    v_delay_seconds INT := 0;
    v_retry_reason TEXT := NULL;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    SELECT *
      INTO v_job
      FROM public.outbound_calls
     WHERE id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Outbound call % not found', p_job_id;
    END IF;

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    IF v_job.target_type = 'provider' THEN
      v_provider_id := v_job.target_id;
    END IF;

    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row_from_context(
        'outbound_retry_policy',
        jsonb_strip_nulls(COALESCE(v_job.context, '{}'::jsonb) || jsonb_build_object('organization_id', v_org))
      )
      LIMIT 1;

    IF NOT FOUND OR v_policy_row.value IS NULL THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing';
    END IF;

    v_policy := v_policy_row.value;
    v_policy_scope_type := v_policy_row.scope_type;
    v_policy_scope_id := v_policy_row.scope_id;
    v_policy_settings_id := v_policy_row.settings_id;
    v_policy_settings_version_id := v_policy_row.settings_version_id;
    v_policy_version := v_policy_row.version;
    v_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb);

    -- Apply call_type override if present (deep merge).
    IF v_policy ? 'call_type_overrides' AND jsonb_typeof(v_policy->'call_type_overrides') = 'object' THEN
      v_policy := public.jsonb_deep_merge(
        v_policy,
        COALESCE(v_policy->'call_type_overrides'->v_job.call_type, '{}'::jsonb)
      );
    END IF;

    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org,
      p_category := 'outbound_retry_policy',
      p_winning_scope_type := v_policy_scope_type,
      p_winning_scope_id := v_policy_scope_id,
      p_winning_settings_id := v_policy_settings_id,
      p_winning_settings_version_id := v_policy_settings_version_id,
      p_winning_version := v_policy_version,
      p_scope_path := v_scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'job_id', p_job_id,
        'call_type', v_job.call_type,
        'target_type', v_job.target_type,
        'target_id', v_job.target_id,
        'status_code', p_status_code
      )),
      p_merge_notes := NULL
    );

    v_retryable_codes := v_policy#>'{http,retryable_status_codes}';
    v_retryable_ranges := v_policy#>'{http,retryable_status_ranges}';
    v_permanent_ranges := v_policy#>'{http,permanent_status_ranges}';
    v_retry_after_header := lower(NULLIF(v_policy#>>'{http,retry_after_header}', ''));
    v_respect_retry_after := NULLIF(v_policy->>'respect_retry_after', '')::BOOLEAN;
    v_backoff := v_policy->'backoff_seconds';
    v_max_delay_seconds := NULLIF(v_policy->>'max_retry_delay_seconds', '')::INT;

    IF v_retry_after_header IS NULL THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_retry_after_header';
    END IF;
    IF v_retryable_codes IS NULL OR jsonb_typeof(v_retryable_codes) <> 'array' THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_retryable_status_codes';
    END IF;
    IF v_retryable_ranges IS NULL OR jsonb_typeof(v_retryable_ranges) <> 'array' THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_retryable_status_ranges';
    END IF;
    IF v_permanent_ranges IS NULL OR jsonb_typeof(v_permanent_ranges) <> 'array' THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_permanent_status_ranges';
    END IF;
    IF v_respect_retry_after IS NULL THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_respect_retry_after';
    END IF;
    IF jsonb_typeof(v_backoff) <> 'array' OR jsonb_array_length(v_backoff) = 0 THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_backoff_seconds';
    END IF;
    IF v_max_delay_seconds IS NULL OR v_max_delay_seconds < 0 THEN
      RAISE EXCEPTION 'outbound_retry_policy_missing_max_retry_delay_seconds';
    END IF;

    v_next_retry_count := v_job.retry_count + 1;
    v_attempt_number := v_next_retry_count;

    -- Retryable classification (explicit codes/ranges override permanent ranges).
    v_is_retryable := EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_retryable_codes) AS c(val)
      WHERE (c.val)::INT = p_status_code
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_retryable_ranges) AS r(elem)
      WHERE jsonb_typeof(r.elem) = 'array'
        AND jsonb_array_length(r.elem) = 2
        AND p_status_code BETWEEN (r.elem->>0)::INT AND (r.elem->>1)::INT
    );

    v_is_permanent := (NOT v_is_retryable) AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_permanent_ranges) AS r(elem)
      WHERE jsonb_typeof(r.elem) = 'array'
        AND jsonb_array_length(r.elem) = 2
        AND p_status_code BETWEEN (r.elem->>0)::INT AND (r.elem->>1)::INT
    );

    v_should_retry := v_is_retryable AND (v_next_retry_count < v_job.max_retries);

    -- Backoff delay selection by attempt number (1-based).
    SELECT COALESCE(NULLIF(value, '')::INT, 0)
      INTO v_backoff_seconds
      FROM jsonb_array_elements_text(v_backoff) WITH ORDINALITY AS arr(value, idx)
     WHERE idx = LEAST(jsonb_array_length(v_backoff), GREATEST(1, v_next_retry_count))
     LIMIT 1;

    v_delay_seconds := GREATEST(COALESCE(v_backoff_seconds, 0), 0);

    -- Optional Retry-After header support (numeric seconds only).
    IF v_respect_retry_after THEN
      BEGIN
        v_retry_after_seconds := NULLIF(v_headers_norm->>v_retry_after_header, '')::INT;
      EXCEPTION
        WHEN others THEN
          v_retry_after_seconds := NULL;
      END;
      IF v_retry_after_seconds IS NOT NULL AND v_retry_after_seconds > v_delay_seconds THEN
        v_delay_seconds := v_retry_after_seconds;
      END IF;
    END IF;

    IF v_max_delay_seconds IS NOT NULL AND v_max_delay_seconds > 0 THEN
      v_delay_seconds := LEAST(v_delay_seconds, v_max_delay_seconds);
    END IF;

    IF v_should_retry THEN
      v_new_status := 'failed';
      v_retry_reason := 'retry_scheduled';
    ELSE
      v_new_status := 'permanently_failed';
      v_retry_reason := CASE
        WHEN v_is_permanent THEN 'permanent_status_code'
        WHEN NOT v_is_retryable THEN 'not_retryable_by_policy'
        WHEN v_next_retry_count >= v_job.max_retries THEN 'max_retries_exhausted'
        ELSE 'retry_disallowed'
      END;
    END IF;

    UPDATE public.outbound_calls
       SET status = v_new_status,
           retry_count = v_next_retry_count,
           response_status_code = p_status_code,
           response_headers = COALESCE(p_headers, '{}'::jsonb),
           response_body = COALESCE(p_body, '{}'::jsonb),
           error_message = p_error,
           scheduled_at = CASE
             WHEN v_new_status = 'failed' THEN now() + make_interval(secs => v_delay_seconds)
             ELSE public.outbound_calls.scheduled_at
           END,
           completed_at = CASE WHEN v_new_status = 'permanently_failed' THEN now() ELSE NULL END,
           lease_expires_at = NULL,
           context = CASE
               WHEN context ? 'edge_dispatch' THEN context - 'edge_dispatch'
               ELSE context
           END
      WHERE id = p_job_id;

    -- Comms attempt logging (failure): keep SSOT visibility even when no provider_message_id exists.
    IF v_job.call_type IN ('comms_whatsapp', 'comms_sms', 'comms_email', 'comms_voice')
       AND v_provider_id IS NOT NULL
       AND v_attempt_number IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.comms_attempts ca
        WHERE ca.outbound_call_id = p_job_id
          AND ca.attempt_number = v_attempt_number
      ) THEN
        INSERT INTO public.comms_attempts (
          outbound_call_id,
          provider_id,
          attempt_number,
          status,
          provider_message_id,
          error_code,
          error_message,
          cost,
          timestamp
        )
        VALUES (
          p_job_id,
          v_provider_id,
          v_attempt_number,
          'failed',
          NULL,
          v_retry_reason,
          p_error,
          v_job.cost,
          now()
        );
      END IF;
    END IF;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := v_new_status,
        p_performed_by_system := 'api_caller_edge',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'status', p_status_code,
          'error', p_error,
          'next_retry_count', v_next_retry_count,
          'max_retries', v_job.max_retries,
          'retryable', v_is_retryable,
          'permanent', v_is_permanent,
          'retry_after_seconds', v_retry_after_seconds,
          'delay_seconds', v_delay_seconds,
          'retry_reason', v_retry_reason
        )),
        p_decision_reason := 'Outbound HTTP request failed via edge function.',
        p_settings_resolution_id := v_settings_resolution_id
    );
END;
$$;

COMMENT ON FUNCTION public.mark_outbound_call_failure(UUID, INT, JSONB, JSONB, TEXT)
  IS 'Mark outbound_call failure and, when policy permits, schedule a retry using scheduled_at backoff (row-driven via outbound_retry_policy).';

COMMIT;
