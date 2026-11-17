-- Migration: Fix label_print_prepare_v2 to avoid sync pg_net waits
-- Purpose:
--  - pg_net requests are dispatched after commit, so waiting inside a workflow
--    progress() transaction cannot be synchronous and will hit statement_timeout.
--  - Restore fast progress_workflow_run behavior while keeping a policy-driven
--    optional renderer invoke (fire-and-forget).
-- Notes:
--  - Row-driven: controlled via label_print_policy.render_invoke_enabled.
--  - No ordering changes to bundle output; only affects how/when jobs are invoked.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Section 1: invoke_label_renderer must be asynchronous (call_api)
-- -----------------------------------------------------------------------------
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

    v_scope_type TEXT;
    v_scope_id UUID;
    v_payload_org_id UUID;
    v_payload_client_id UUID;
    v_payload_sender_id UUID;
    v_payload_source_id UUID;
BEGIN
    -- Determine scope from payload (most specific first) to respect ladder.
    v_payload_org_id := NULLIF(COALESCE(p_payload->>'organization_id', ''), '')::uuid;
    v_payload_client_id := NULLIF(COALESCE(p_payload->>'client_id', ''), '')::uuid;
    v_payload_sender_id := NULLIF(COALESCE(p_payload->>'sender_id', ''), '')::uuid;
    v_payload_source_id := NULLIF(COALESCE(p_payload->>'webhook_source_id', p_payload->>'source_id', ''), '')::uuid;

    IF v_payload_source_id IS NOT NULL THEN
        v_scope_type := 'source';
        v_scope_id := v_payload_source_id;
    ELSIF v_payload_sender_id IS NOT NULL THEN
        v_scope_type := 'sender';
        v_scope_id := v_payload_sender_id;
    ELSIF v_payload_client_id IS NOT NULL THEN
        v_scope_type := 'client';
        v_scope_id := v_payload_client_id;
    ELSIF v_payload_org_id IS NOT NULL THEN
        v_scope_type := 'tenant';
        v_scope_id := v_payload_org_id;
    ELSE
        v_scope_type := 'global';
        v_scope_id := NULL;
    END IF;

    v_settings := resolve_settings('label_provider', v_scope_type, v_scope_id);

    IF v_settings IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: label_provider settings not found (scope=%/%)', v_scope_type, v_scope_id;
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

    IF jsonb_typeof(v_provider->'headers') = 'object' THEN
        v_headers := v_headers || (v_provider->'headers');
    END IF;

    v_body := CASE
        WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
            THEN jsonb_strip_nulls(p_payload)
        ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
    END;

    v_timeout_seconds := GREATEST((v_timeout_ms + 999) / 1000, 1);

    -- NOTE: Asynchronous by design; pg_net dispatch occurs after commit.
    v_response := public.call_api(
        v_url,
        'POST',
        v_headers,
        v_body,
        v_timeout_seconds
    );

    RETURN v_response || jsonb_build_object(
        'request_payload', v_body,
        'provider_name', v_provider->>'name',
        'provider_scope_type', v_scope_type,
        'provider_scope_id', v_scope_id
    );
END;
$$;

COMMENT ON FUNCTION public.invoke_label_renderer(INT, JSONB)
    IS 'Trigger label renderer edge worker using label_provider settings (async via call_api; policy/ladder driven).';

-- -----------------------------------------------------------------------------
-- Section 2: prepare v2 must not block on renderer completion
-- -----------------------------------------------------------------------------
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

  v_render_enabled BOOLEAN := FALSE;
  v_render_max_jobs INT := 50;
  v_render_job_concurrency INT := 10;
  v_render_lease_seconds INT := 60;
BEGIN
  v_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);

  IF v_response.status IS DISTINCT FROM 'pending' THEN
    RETURN v_response;
  END IF;

  v_policy := COALESCE(v_response.operation_result->'policy', '{}'::jsonb);
  v_org_id := NULLIF(v_response.context_patch->'label_print'->>'organization_id', '')::uuid;

  v_render_enabled := COALESCE((v_policy->>'render_invoke_enabled')::BOOLEAN, FALSE);
  IF NOT v_render_enabled OR v_org_id IS NULL THEN
    RETURN v_response;
  END IF;

  v_pending := COALESCE(v_response.operation_result->'pending', '[]'::jsonb);
  IF jsonb_typeof(v_pending) IS DISTINCT FROM 'array' THEN
    RETURN v_response;
  END IF;

  -- Fire-and-forget edge invoke (runs after commit). No sync loop inside workflow.
  v_render_max_jobs := COALESCE(NULLIF((v_policy->>'render_max_jobs')::INT, 0), 50);
  v_render_job_concurrency := COALESCE(NULLIF((v_policy->>'render_job_concurrency')::INT, 0), 10);
  v_render_lease_seconds := COALESCE(NULLIF((v_policy->>'render_lease_seconds')::INT, 0), 60);

  v_render_max_jobs := LEAST(GREATEST(v_render_max_jobs, 1), 100);
  v_render_job_concurrency := LEAST(GREATEST(v_render_job_concurrency, 1), 10);
  v_render_lease_seconds := LEAST(GREATEST(v_render_lease_seconds, 60), 600);

  PERFORM public.invoke_label_renderer(
    NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org_id,
      'lease_seconds', v_render_lease_seconds,
      'max_jobs', LEAST(v_render_max_jobs, GREATEST(jsonb_array_length(v_pending), 1)),
      'job_concurrency', v_render_job_concurrency
    ))
  );

  RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v2(workflow_run_steps, workflow_runs, JSONB)
  IS 'Prepare labels for bundling (v2): batch enqueue + optional async invoke_label_renderer (no sync wait inside progress).';

-- -----------------------------------------------------------------------------
-- Section 3: default global policy disables renderer invoke to avoid overhead
-- -----------------------------------------------------------------------------
WITH current_global AS (
  SELECT settings_version_id
  FROM settings
  WHERE category = 'label_print_policy'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY last_updated DESC
  LIMIT 1
),
updated AS (
  UPDATE settings_versions sv
  SET value =
    jsonb_set(
      sv.value,
      '{render_invoke_enabled}',
      to_jsonb(false),
      true
    ),
    change_reason = 'Disable label_print_policy.render_invoke_enabled by default; sync waiting via pg_net cannot occur inside workflow progress transactions',
    approved_at = workflow_now(),
    effective_from = workflow_now()
  FROM current_global cg
  WHERE sv.id = cg.settings_version_id
  RETURNING sv.value
),
applied AS (
  UPDATE settings s
  SET cached_value = updated.value,
      last_updated = workflow_now()
  FROM updated
  WHERE s.category = 'label_print_policy'
    AND s.scope_type = 'global'
    AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  RETURNING s.id
)
SELECT 'label_print_policy render_invoke_enabled default disabled' AS status;

COMMIT;

