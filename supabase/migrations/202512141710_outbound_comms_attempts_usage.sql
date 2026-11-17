-- Migration: Outbound comms SSOT logging (comms_attempts + provider_usage_tracking)
-- Purpose:
--   - Record successful comms sends into comms_attempts (provider_message_id, attempt_number, status).
--   - Increment provider_usage_tracking for comms sends using a policy-driven period type.
--   - Keep response parsing row-driven by relying on operation_templates.mapping_config_id (via outbound_calls.context.operation_template_id).
-- Date: 2025-12-14

BEGIN;

-------------------------------------------------------------------------------
-- 1) Comms attempts: enforce idempotency per outbound attempt
-------------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_comms_attempts_outbound_call_attempt
  ON public.comms_attempts(outbound_call_id, attempt_number);

-------------------------------------------------------------------------------
-- 1b) provider_usage_tracking: treat NULL scopes as a single bucket (NULLS NOT DISTINCT)
-------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.provider_usage_tracking') IS NULL THEN
    RETURN;
  END IF;

  -- Merge any existing duplicates (possible under the historical UNIQUE constraint where NULLs were distinct).
  WITH dups AS (
    SELECT
      organization_id,
      client_id,
      sender_id,
      provider_id,
      period_type,
      period_start,
      MIN(id::text)::uuid AS keep_id,
      MAX(period_end) AS period_end_max,
      SUM(call_count) AS call_count_sum,
      SUM(estimated_cost_SAR) AS estimated_cost_sum,
      SUM(actual_cost_SAR) AS actual_cost_sum,
      SUM(free_tier_units_used) AS free_tier_units_sum
    FROM public.provider_usage_tracking
    GROUP BY organization_id, client_id, sender_id, provider_id, period_type, period_start
    HAVING COUNT(*) > 1
  ),
  updated AS (
    UPDATE public.provider_usage_tracking t
       SET period_end = d.period_end_max,
           call_count = d.call_count_sum,
           estimated_cost_SAR = d.estimated_cost_sum,
           actual_cost_SAR = d.actual_cost_sum,
           free_tier_units_used = d.free_tier_units_sum,
           updated_at = now()
      FROM dups d
     WHERE t.id = d.keep_id
     RETURNING t.id
  )
  DELETE FROM public.provider_usage_tracking t
  USING dups d
  WHERE t.organization_id IS NOT DISTINCT FROM d.organization_id
    AND t.client_id IS NOT DISTINCT FROM d.client_id
    AND t.sender_id IS NOT DISTINCT FROM d.sender_id
    AND t.provider_id IS NOT DISTINCT FROM d.provider_id
    AND t.period_type IS NOT DISTINCT FROM d.period_type
    AND t.period_start IS NOT DISTINCT FROM d.period_start
    AND t.id <> d.keep_id;

  -- Replace the historical UNIQUE constraint with a NULLS NOT DISTINCT constraint.
  ALTER TABLE public.provider_usage_tracking
    DROP CONSTRAINT IF EXISTS provider_usage_tracking_organization_id_client_id_sender_id_provider_id_period_type_period_start_key;

  ALTER TABLE public.provider_usage_tracking
    ADD CONSTRAINT uq_provider_usage_tracking_bucket
    UNIQUE NULLS NOT DISTINCT (organization_id, client_id, sender_id, provider_id, period_type, period_start);
END $$;

-------------------------------------------------------------------------------
-- 2) provider_usage_policy (minimal, global default)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'provider_usage_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'period_type', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('hour', 'day', 'month'))
    )
  ),
  'Provider usage aggregation policy for provider_usage_tracking (period bucketing).',
  jsonb_build_array(jsonb_build_object('version', 1, 'period_type', 'month')),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

WITH payload AS (
  SELECT jsonb_build_object('version', 1, 'period_type', 'month') AS value
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
    'provider_usage_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global provider_usage_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'provider_usage_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'provider_usage_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_id) DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Helper: upsert provider_usage_tracking bucket
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_provider_usage_tracking(
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_provider_id UUID,
  p_period_type TEXT,
  p_event_time TIMESTAMPTZ,
  p_call_count_delta INT DEFAULT 1,
  p_actual_cost_delta NUMERIC DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_period_type TEXT := lower(NULLIF(p_period_type, ''));
  v_time TIMESTAMPTZ := COALESCE(p_event_time, now());
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
BEGIN
  IF p_organization_id IS NULL OR p_provider_id IS NULL THEN
    RETURN;
  END IF;

  IF v_period_type IS NULL THEN
    RAISE EXCEPTION 'provider_usage_policy_missing_period_type';
  END IF;

  IF v_period_type NOT IN ('hour', 'day', 'month') THEN
    RAISE EXCEPTION 'provider_usage_policy_invalid_period_type';
  END IF;

  v_period_start := date_trunc(v_period_type, v_time);
  v_period_end := CASE v_period_type
    WHEN 'hour' THEN v_period_start + interval '1 hour'
    WHEN 'day' THEN v_period_start + interval '1 day'
    ELSE v_period_start + interval '1 month'
  END;

  INSERT INTO public.provider_usage_tracking (
    organization_id,
    client_id,
    sender_id,
    provider_id,
    period_type,
    period_start,
    period_end,
    call_count,
    actual_cost_SAR,
    created_at,
    updated_at
  )
  VALUES (
    p_organization_id,
    p_client_id,
    p_sender_id,
    p_provider_id,
    v_period_type,
    v_period_start,
    v_period_end,
    GREATEST(COALESCE(p_call_count_delta, 0), 0),
    GREATEST(COALESCE(p_actual_cost_delta, 0), 0),
    now(),
    now()
  )
  ON CONFLICT (organization_id, client_id, sender_id, provider_id, period_type, period_start)
  DO UPDATE
    SET call_count = public.provider_usage_tracking.call_count + EXCLUDED.call_count,
        actual_cost_SAR = public.provider_usage_tracking.actual_cost_SAR + EXCLUDED.actual_cost_SAR,
        updated_at = now();
END;
$$;

COMMENT ON FUNCTION public.upsert_provider_usage_tracking(UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, INT, NUMERIC)
  IS 'Upsert+increment provider_usage_tracking bucket (period_type hour/day/month).';

-------------------------------------------------------------------------------
-- 4) Comms response handler: write comms_attempts + provider_usage_tracking
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.process_comms_outbound_response_v1(
  p_job public.outbound_calls,
  p_template public.operation_templates,
  p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_provider_id UUID := NULL;
  v_org_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_period_type TEXT := NULL;
  v_policy_row RECORD;
  v_policy JSONB := NULL;
  v_policy_ctx JSONB := '{}'::jsonb;

  v_parsed JSONB := '{}'::jsonb;
  v_provider_message_id TEXT := NULL;
  v_attempt_number INT := COALESCE(p_job.retry_count, 0) + 1;
BEGIN
  IF p_job.target_type = 'provider' THEN
    v_provider_id := p_job.target_id;
  END IF;

  IF v_provider_id IS NULL THEN
    RETURN jsonb_build_object('handled', FALSE, 'reason', 'missing_provider');
  END IF;

  BEGIN
    v_org_id := NULLIF(p_job.context->>'organization_id', '')::UUID;
  EXCEPTION
    WHEN others THEN v_org_id := NULL;
  END;
  IF v_org_id IS NULL THEN
    v_org_id := public.resolve_organization_id_strict('outbound_call', p_job.id);
  END IF;

  BEGIN
    v_client_id := NULLIF(p_job.context->>'client_id', '')::UUID;
  EXCEPTION
    WHEN others THEN v_client_id := NULL;
  END;

  BEGIN
    v_sender_id := NULLIF(p_job.context->>'sender_id', '')::UUID;
  EXCEPTION
    WHEN others THEN v_sender_id := NULL;
  END;

  IF v_sender_id IS NULL AND p_job.shipment_id IS NOT NULL THEN
    SELECT s.sender_id INTO v_sender_id
      FROM public.shipments s
     WHERE s.id = p_job.shipment_id
     LIMIT 1;
  END IF;

  IF v_client_id IS NULL AND p_job.shipment_id IS NOT NULL THEN
    SELECT s.client_id INTO v_client_id
      FROM public.shipments s
     WHERE s.id = p_job.shipment_id
     LIMIT 1;
  END IF;

  -- Parse provider response using the canonical mapping_config when present.
  IF p_template.mapping_config_id IS NOT NULL THEN
    v_parsed := public.apply_mapping_config(COALESCE(p_response, '{}'::jsonb), p_template.mapping_config_id);
  END IF;

  v_provider_message_id := NULLIF(COALESCE(v_parsed->>'message_id', v_parsed->>'id'), '');

  INSERT INTO public.comms_attempts (
    outbound_call_id,
    provider_id,
    attempt_number,
    status,
    provider_message_id,
    cost,
    timestamp
  )
  VALUES (
    p_job.id,
    v_provider_id,
    v_attempt_number,
    'sent',
    v_provider_message_id,
    p_job.cost,
    now()
  )
  ON CONFLICT (outbound_call_id, attempt_number) DO UPDATE
    SET status = EXCLUDED.status,
        provider_message_id = COALESCE(public.comms_attempts.provider_message_id, EXCLUDED.provider_message_id),
        cost = COALESCE(public.comms_attempts.cost, EXCLUDED.cost);

  v_policy_ctx := jsonb_strip_nulls(
    COALESCE(p_job.context, '{}'::jsonb)
    || jsonb_build_object(
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id
    )
  );

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_context('provider_usage_policy', v_policy_ctx)
    LIMIT 1;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    RAISE EXCEPTION 'provider_usage_policy_missing';
  END IF;

  v_policy := v_policy_row.value;
  v_period_type := lower(NULLIF(v_policy->>'period_type', ''));
  IF v_period_type IS NULL THEN
    RAISE EXCEPTION 'provider_usage_policy_missing_period_type';
  END IF;

  PERFORM public.upsert_provider_usage_tracking(
    p_organization_id := v_org_id,
    p_client_id := v_client_id,
    p_sender_id := v_sender_id,
    p_provider_id := v_provider_id,
    p_period_type := v_period_type,
    p_event_time := now(),
    p_call_count_delta := 1,
    p_actual_cost_delta := COALESCE(p_job.cost, 0)
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'handled', TRUE,
    'provider_message_id', v_provider_message_id,
    'attempt_number', v_attempt_number
  ));
END;
$$;

COMMENT ON FUNCTION workflow_handlers.process_comms_outbound_response_v1(public.outbound_calls, public.operation_templates, JSONB)
  IS 'Process successful comms outbound responses: write comms_attempts + bump provider_usage_tracking (row-driven mapping).';

-------------------------------------------------------------------------------
-- 5) Extend workflow_handlers.process_outbound_response_v1 to support comms sends
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.process_geocoding_outbound_response_v1(
    p_job public.outbound_calls,
    p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_result JSONB := jsonb_build_object('handled', FALSE);
    v_template_id UUID;
    v_template public.operation_templates%ROWTYPE;
    v_step public.workflow_run_steps%ROWTYPE;
    v_run public.workflow_runs%ROWTYPE;
    v_ctx RECORD;
    v_parsed JSONB;
    v_attempt_order INT;
    v_attempt_status TEXT;
    v_attempt_type TEXT;
    v_provider_name TEXT;
    v_attempt_id UUID;
    v_latitude NUMERIC;
    v_longitude NUMERIC;
    v_geocode_json JSONB;
    v_cache_step public.workflow_run_steps%ROWTYPE;
    v_confidence NUMERIC;
    v_address_json JSONB;
    v_auto_learn_result JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, pg_temp', FALSE);

    v_template_id := NULLIF(p_job.context->>'operation_template_id', '')::UUID;
    IF v_template_id IS NULL THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_template
    FROM public.operation_templates
    WHERE id = v_template_id;
    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    IF p_job.workflow_run_step_id IS NULL THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_step
    FROM public.workflow_run_steps
    WHERE id = p_job.workflow_run_step_id;
    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_run
    FROM public.workflow_runs
    WHERE id = v_step.workflow_run_id;
    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    -- Only handle geocoding templates here; other workflows fall back to handled=false.
    IF v_template.operation_name NOT LIKE 'geocoding_%' THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_ctx FROM public.geocoding_extract_context(v_run);

    IF v_template.mapping_config_id IS NOT NULL THEN
        v_parsed := public.apply_mapping_config(p_response, v_template.mapping_config_id);
    ELSE
        v_parsed := '{}'::jsonb;
    END IF;

    v_attempt_type := COALESCE(v_step.metadata->>'attempt_type', 'primary');
    v_provider_name := COALESCE(v_step.metadata->>'provider_name', v_template.operation_name);

    SELECT COALESCE(MAX(attempt_order), 0) + 1
    INTO v_attempt_order
    FROM public.geocoding_attempts
    WHERE address_id = v_ctx.address_id
      AND provider_name = v_provider_name;

    v_latitude := NULLIF(v_parsed->>'latitude', '')::NUMERIC;
    v_longitude := NULLIF(v_parsed->>'longitude', '')::NUMERIC;
    v_confidence := NULLIF(v_parsed->>'confidence_score', '')::NUMERIC;

    IF (p_job.response_status_code BETWEEN 200 AND 299)
       AND v_latitude IS NOT NULL
       AND v_longitude IS NOT NULL THEN
        v_attempt_status := 'succeeded';
    ELSE
        v_attempt_status := 'failed';
    END IF;

    INSERT INTO public.geocoding_attempts (
        organization_id,
        client_id,
        sender_id,
        address_id,
        shipment_id,
        workflow_run_step_id,
        provider_name,
        attempt_order,
        attempt_type,
        status,
        confidence,
        duration_ms,
        metadata,
        created_at,
        updated_at
    )
    VALUES (
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id,
        v_ctx.address_id,
        v_ctx.shipment_id,
        v_step.id,
        v_provider_name,
        v_attempt_order,
        v_attempt_type,
        v_attempt_status,
        v_confidence,
        p_job.latency_ms,
        jsonb_build_object(
            'response_status_code', p_job.response_status_code,
            'provider_response', p_response,
            'parsed', v_parsed
        ),
        now(),
        now()
    )
    RETURNING id INTO v_attempt_id;

    IF v_attempt_status = 'succeeded' THEN
        SELECT jsonb_strip_nulls(jsonb_build_object(
                   'line1', NULLIF(a.normalized_line1, ''),
                   'line2', NULLIF(a.normalized_line2, ''),
                   'district', NULLIF(a.district, ''),
                   'city', NULLIF(a.city, ''),
                   'province', NULLIF(a.province, ''),
                   'country', NULLIF(a.country, '')
               ))
        INTO v_address_json
        FROM public.addresses a
        WHERE a.id = v_ctx.address_id;

        v_geocode_json := jsonb_strip_nulls(jsonb_build_object(
            'provider_name', v_provider_name,
            'is_primary', v_attempt_type = 'primary',
            'confidence_score', v_confidence,
            'formatted_address', COALESCE(v_parsed->>'formatted_address', NULL),
            'accuracy_type', COALESCE(v_parsed->>'location_type', NULL),
            'metadata', jsonb_build_object(
                'attempt_id', v_attempt_id,
                'provider_name', v_provider_name,
                'parsed', v_parsed
            ),
            'coordinates', jsonb_build_object(
                'latitude', v_latitude,
                'longitude', v_longitude
            )
        ));

        v_cache_step := v_step;
        v_cache_step.metadata := jsonb_build_object('action', 'write');

        PERFORM workflow_handlers.execute_geocode_cache_v1(
            v_cache_step,
            v_run,
            jsonb_build_object('geocode', v_geocode_json)
        );

        IF to_regprocedure('public.auto_learn_geography(uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,text)') IS NOT NULL THEN
            v_auto_learn_result := public.auto_learn_geography(
                v_ctx.organization_id,
                v_ctx.client_id,
                v_ctx.sender_id,
                v_ctx.address_id,
                COALESCE(v_address_json, '{}'::jsonb),
                v_parsed,
                v_confidence,
                v_provider_name
            );

            v_result := v_result || jsonb_build_object('auto_learn', v_auto_learn_result);
        END IF;
    END IF;

    UPDATE public.workflow_run_steps
    SET operation_result = jsonb_build_object(
            'attempt_id', v_attempt_id,
            'provider_name', v_provider_name,
            'status', v_attempt_status,
            'response_status_code', p_job.response_status_code
        ),
        updated_at = now()
    WHERE id = v_step.id;

    v_result := jsonb_build_object(
        'handled', TRUE,
        'attempt_id', v_attempt_id,
        'status', v_attempt_status
    );

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.process_geocoding_outbound_response_v1(public.outbound_calls, JSONB)
  IS 'Process outbound responses for geocoding templates (records attempts and writes cache when successful).';

CREATE OR REPLACE FUNCTION workflow_handlers.process_outbound_response_v1(
    p_job public.outbound_calls,
    p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_result JSONB := jsonb_build_object('handled', FALSE);
    v_template_id UUID;
    v_template public.operation_templates%ROWTYPE;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, pg_temp', FALSE);

    -- Comms first: call_type drives comms handling (independent of operation_name).
    IF p_job.call_type IN ('comms_whatsapp', 'comms_sms', 'comms_email', 'comms_voice') THEN
        v_template_id := NULLIF(p_job.context->>'operation_template_id', '')::UUID;
        IF v_template_id IS NOT NULL THEN
            SELECT * INTO v_template
              FROM public.operation_templates
             WHERE id = v_template_id;
        END IF;

        IF v_template.id IS NULL THEN
            -- Best-effort fallback to provider-scoped template for response mapping.
            SELECT * INTO v_template
              FROM public.operation_templates ot
             WHERE ot.provider_id = p_job.target_id
               AND ot.call_type = p_job.call_type
             ORDER BY ot.updated_at DESC
             LIMIT 1;
        END IF;

        RETURN workflow_handlers.process_comms_outbound_response_v1(p_job, v_template, p_response);
    END IF;

    -- Geocoding (and any other future outbound response handlers) are routed through the
    -- dedicated geocoding handler, which returns handled=false for non-geocoding jobs.
    RETURN workflow_handlers.process_geocoding_outbound_response_v1(p_job, p_response);
END;
$$;

COMMENT ON FUNCTION workflow_handlers.process_outbound_response_v1(public.outbound_calls, JSONB)
  IS 'Shared outbound response hook: comms_* sends -> comms_attempts/provider_usage_tracking; geocoding templates -> geocoding attempts/cache.';

COMMIT;
