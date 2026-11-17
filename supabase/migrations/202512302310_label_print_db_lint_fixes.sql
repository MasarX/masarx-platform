-- Migration: Label print DB lint fixes
-- Purpose:
--  - Fix db lint error in request_label_generation_batch (ambiguous shipment_box_id).
--  - Clean up invoke_label_renderer (no unused vars; resolve settings via ladder).
--  - Avoid shadowed loop variables in execute_label_print_prepare_v2.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.request_label_generation_batch(
  p_shipment_id UUID,
  p_label_type TEXT,
  p_requested_by UUID DEFAULT NULL,
  p_requested_source TEXT DEFAULT NULL,
  p_shipment_box_ids UUID[] DEFAULT NULL,
  p_job_purpose TEXT DEFAULT 'primary'
)
RETURNS TABLE (
  job_id UUID,
  shipment_box_id UUID,
  inserted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_shipment RECORD;
  v_template RECORD;
  v_job_purpose TEXT := COALESCE(NULLIF(p_job_purpose, ''), 'primary');
BEGIN
  IF p_label_type IS NULL OR btrim(p_label_type) = '' THEN
    RAISE EXCEPTION 'Label type is required.';
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id
  INTO v_shipment
  FROM public.shipments s
  WHERE s.id = p_shipment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shipment % not found', p_shipment_id;
  END IF;

  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    IF public.current_user_org_id() IS NULL OR public.current_user_org_id() <> v_shipment.organization_id THEN
      RAISE EXCEPTION 'Access denied for shipment %', p_shipment_id;
    END IF;
  END IF;

  SELECT *
  INTO v_template
  FROM public.resolve_label_template(
    v_shipment.organization_id,
    v_shipment.client_id,
    v_shipment.sender_id,
    lower(p_label_type)
  )
  LIMIT 1;

  IF v_template.template_id IS NULL THEN
    RAISE EXCEPTION 'Unable to resolve label template for shipment % label_type %', p_shipment_id, p_label_type;
  END IF;

  RETURN QUERY
  WITH input_boxes AS (
    SELECT DISTINCT sb.id AS shipment_box_id
    FROM public.shipment_boxes sb
    WHERE sb.shipment_id = p_shipment_id
      AND (
        p_shipment_box_ids IS NULL
        OR array_length(p_shipment_box_ids, 1) IS NULL
        OR sb.id = ANY (p_shipment_box_ids)
      )
  ),
  job_inputs AS (
    SELECT
      v_shipment.organization_id AS organization_id,
      v_shipment.client_id AS client_id,
      p_shipment_id AS shipment_id,
      ib.shipment_box_id AS shipment_box_id,
      lower(p_label_type) AS label_type,
      v_template.template_id AS template_id,
      v_template.template_version AS template_version,
      v_template.template_snapshot AS template_snapshot,
      COALESCE(v_template.max_attempts, 5) AS max_attempts,
      now() AS scheduled_at,
      v_job_purpose AS job_purpose,
      format(
        '%s:%s:%s:%s:%s:%s',
        v_shipment.organization_id,
        p_shipment_id,
        ib.shipment_box_id,
        lower(p_label_type),
        v_template.template_id,
        v_job_purpose
      ) AS idempotency_key,
      p_requested_by AS requested_by,
      p_requested_source AS requested_source,
      v_template.template_snapshot -> 'label_config' ->> 'provider_hint' AS renderer_hint,
      COALESCE(v_template.retry_backoff, '[]'::jsonb) AS retry_state
    FROM input_boxes ib
  ),
  inserted_jobs AS (
    INSERT INTO public.label_jobs AS lj (
      organization_id,
      client_id,
      shipment_id,
      shipment_box_id,
      label_type,
      template_id,
      template_version,
      template_snapshot,
      status,
      attempts,
      max_attempts,
      scheduled_at,
      job_purpose,
      idempotency_key,
      requested_by,
      requested_source,
      renderer_hint,
      retry_state
    )
    SELECT
      ji.organization_id,
      ji.client_id,
      ji.shipment_id,
      ji.shipment_box_id,
      ji.label_type,
      ji.template_id,
      ji.template_version,
      ji.template_snapshot,
      'pending',
      0,
      ji.max_attempts,
      ji.scheduled_at,
      ji.job_purpose,
      ji.idempotency_key,
      ji.requested_by,
      ji.requested_source,
      ji.renderer_hint,
      ji.retry_state
    FROM job_inputs ji
    ON CONFLICT ON CONSTRAINT label_jobs_unique_request DO NOTHING
    RETURNING
      lj.id AS job_id,
      lj.shipment_box_id AS shipment_box_id,
      lj.idempotency_key AS idempotency_key
  ),
  resolved AS (
    SELECT
      ji.shipment_box_id,
      lj.id AS job_id,
      (ins.job_id IS NOT NULL) AS inserted
    FROM job_inputs ji
    JOIN public.label_jobs lj
      ON lj.organization_id = ji.organization_id
     AND lj.idempotency_key = ji.idempotency_key
    LEFT JOIN inserted_jobs ins
      ON ins.idempotency_key = ji.idempotency_key
  ),
  decision_rows AS (
    INSERT INTO public.decision_log (
      organization_id,
      decision_category,
      resource_type,
      resource_id,
      decision_point,
      decision_outcome,
      decision_inputs,
      decision_reason,
      performed_by_system,
      correlation_id,
      settings_resolution_id,
      timestamp
    )
    SELECT
      v_shipment.organization_id,
      'label_job',
      'label_job',
      r.job_id,
      'request_label_generation',
      CASE WHEN r.inserted THEN 'enqueued' ELSE 'reused' END,
      jsonb_build_object(
        'shipment_id', p_shipment_id,
        'shipment_box_id', r.shipment_box_id,
        'label_type', lower(p_label_type),
        'template_id', v_template.template_id,
        'template_version', v_template.template_version,
        'job_purpose', v_job_purpose,
        'batch', TRUE
      ),
      CASE WHEN r.inserted THEN NULL ELSE 'idempotent_reuse' END,
      'workflow_engine',
      NULL,
      NULL,
      now()
    FROM resolved r
    RETURNING 1
  )
  SELECT r.job_id, r.shipment_box_id, r.inserted
  FROM resolved r;
END;
$$;

COMMENT ON FUNCTION public.request_label_generation_batch(UUID, TEXT, UUID, TEXT, UUID[], TEXT)
  IS 'Batch enqueue label jobs for a shipment (idempotent per box/type/template/purpose); returns job ids + inserted flag.';

GRANT EXECUTE ON FUNCTION public.request_label_generation_batch(UUID, TEXT, UUID, TEXT, UUID[], TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_label_generation_batch(UUID, TEXT, UUID, TEXT, UUID[], TEXT) TO edge_label_renderer_role;

CREATE OR REPLACE FUNCTION public.invoke_label_renderer(
    p_max_jobs INT DEFAULT 5,
    p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_settings JSONB;
    v_provider JSONB;
    v_url TEXT;
    v_secret TEXT;
    v_timeout_ms INT;
    v_timeout_seconds INT;
    v_headers JSONB;
    v_body JSONB;
    v_response JSONB;
    v_org_id UUID;
BEGIN
    v_body := CASE
        WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
            THEN jsonb_strip_nulls(p_payload)
        ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
    END;

    v_org_id := NULLIF(v_body->>'organization_id', '')::UUID;

    v_settings := COALESCE(
        CASE
            WHEN v_org_id IS NOT NULL THEN resolve_settings('label_provider', 'tenant', v_org_id)
            ELSE NULL
        END,
        resolve_settings('label_provider', 'global', NULL)
    );

    IF v_settings IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: label_provider settings not found';
    END IF;

    v_provider := COALESCE((v_settings->'providers')->0, '{}'::jsonb);

    v_url := NULLIF(v_provider->>'invoke_url', '');
    v_secret := NULLIF(v_provider->>'invoke_secret', '');
    v_timeout_ms := COALESCE((v_provider->>'timeout_ms')::INT, 15000);

    IF v_url IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: invoke_url missing in label_provider configuration';
    END IF;

    IF v_secret IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: invoke_secret missing in label_provider configuration';
    END IF;

    IF v_url LIKE 'https://example.%' OR v_secret = 'EXAMPLE_PASSWORD' THEN
        RAISE EXCEPTION 'invoke_label_renderer: provider invoke configuration not activated (update settings)';
    END IF;

    v_headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', concat('Bearer ', v_secret)
    );

    v_timeout_seconds := GREATEST((v_timeout_ms + 999) / 1000, 1);

    v_response := public.call_api_wait(
        v_url,
        'POST',
        v_headers,
        v_body,
        v_timeout_seconds,
        v_timeout_seconds
    );

    RETURN v_response || jsonb_build_object(
        'request_payload', v_body,
        'provider_name', v_provider->>'name'
    );
END;
$$;

COMMENT ON FUNCTION public.invoke_label_renderer(INT, JSONB)
    IS 'Trigger label renderer edge worker using settings (sync via call_api_wait).';

GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO edge_label_renderer_role;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_prepare_v2(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
  v_response workflow_handler_response;
  v_policy JSONB := '{}'::jsonb;
  v_pending JSONB := '[]'::jsonb;
  v_org_id UUID := NULL;

  v_render_enabled BOOLEAN := TRUE;
  v_render_max_jobs INT := 25;
  v_render_job_concurrency INT := 10;
  v_render_lease_seconds INT := 60;
  v_render_max_calls INT := 20;

  v_call_count INT := 0;
  v_pending_count INT := 0;
BEGIN
  v_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);

  IF v_response.status IS DISTINCT FROM 'pending' THEN
    RETURN v_response;
  END IF;

  v_policy := COALESCE(v_response.operation_result->'policy', '{}'::jsonb);
  v_org_id := NULLIF(v_response.context_patch->'label_print'->>'organization_id', '')::uuid;

  v_render_enabled := COALESCE((v_policy->>'render_invoke_enabled')::BOOLEAN, TRUE);
  IF NOT v_render_enabled OR v_org_id IS NULL THEN
    RETURN v_response;
  END IF;

  v_render_max_jobs := COALESCE(NULLIF((v_policy->>'render_max_jobs')::INT, 0), 25);
  v_render_job_concurrency := COALESCE(NULLIF((v_policy->>'render_job_concurrency')::INT, 0), 10);
  v_render_lease_seconds := COALESCE(NULLIF((v_policy->>'render_lease_seconds')::INT, 0), 60);
  v_render_max_calls := COALESCE(NULLIF((v_policy->>'render_max_calls')::INT, 0), 20);

  v_render_max_jobs := LEAST(GREATEST(v_render_max_jobs, 1), 100);
  v_render_job_concurrency := LEAST(GREATEST(v_render_job_concurrency, 1), 10);
  v_render_lease_seconds := LEAST(GREATEST(v_render_lease_seconds, 60), 600);
  v_render_max_calls := LEAST(GREATEST(v_render_max_calls, 1), 50);

  WHILE v_call_count < v_render_max_calls LOOP
    IF v_response.status IS DISTINCT FROM 'pending' THEN
      EXIT;
    END IF;

    v_pending := COALESCE(v_response.operation_result->'pending', '[]'::jsonb);
    IF jsonb_typeof(v_pending) IS DISTINCT FROM 'array' THEN
      EXIT;
    END IF;

    v_pending_count := jsonb_array_length(v_pending);
    IF v_pending_count <= 0 THEN
      EXIT;
    END IF;

    BEGIN
      PERFORM public.invoke_label_renderer(
        NULL,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org_id,
          'lease_seconds', v_render_lease_seconds,
          'max_jobs', LEAST(v_render_max_jobs, v_pending_count),
          'job_concurrency', v_render_job_concurrency
        ))
      );
    EXCEPTION WHEN OTHERS THEN
      v_response.last_error := SQLERRM;
      RETURN v_response;
    END;

    v_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);
    v_call_count := v_call_count + 1;
  END LOOP;

  RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v2(workflow_run_steps, workflow_runs, JSONB)
  IS 'Prepare labels for bundling (v2): batch enqueue + synchronous invoke_label_renderer loop (policy-driven render_* knobs).';

COMMIT;

