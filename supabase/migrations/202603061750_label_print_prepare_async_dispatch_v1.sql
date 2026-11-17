-- Migration: label print prepare async dispatch
-- Purpose:
--  - Restore non-blocking label-renderer invocation for workflow-driven print prepares.
--  - Dispatch all current-scope fresh label jobs in bounded async chunks using existing policy knobs.
--  - Keep fresh-only correctness fail-closed without relying on repeated prepare retries or cron timing.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061750_label_print_prepare_async_dispatch_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_label_print_fresh_scope_v1(
  p_workflow_run_step_id uuid,
  p_targets jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
WITH input_targets AS (
  SELECT
    ordinality::int AS sort_index,
    NULLIF(elem->>'shipment_id', '')::uuid AS shipment_id,
    CASE
      WHEN COALESCE(elem->>'shipment_box_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (elem->>'shipment_box_id')::uuid
      ELSE NULL
    END AS shipment_box_id,
    CASE
      WHEN COALESCE(elem->>'box_number', '') ~ '^\d+$'
        THEN (elem->>'box_number')::int
      ELSE NULL
    END AS box_number
  FROM jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(COALESCE(p_targets, '[]'::jsonb)) = 'array' THEN COALESCE(p_targets, '[]'::jsonb)
           ELSE '[]'::jsonb
         END
       ) WITH ORDINALITY AS t(elem, ordinality)
  WHERE elem ? 'shipment_id'
),
has_targets AS (
  SELECT EXISTS (SELECT 1 FROM input_targets) AS value
),
job_rows AS (
  SELECT
    lj.id AS job_id,
    lj.shipment_id,
    lj.shipment_box_id,
    lj.status AS job_status,
    lj.output_file_url,
    lj.created_at,
    lj.completed_at,
    lj.error_reason,
    lj.label_id,
    lj.last_attempt_at,
    lj.lease_expires_at,
    l.generated_at
  FROM public.label_jobs lj
  LEFT JOIN public.labels l ON l.id = lj.label_id
  WHERE lj.workflow_run_step_id = p_workflow_run_step_id
),
fallback_targets AS (
  SELECT
    row_number() OVER (ORDER BY MIN(jr.created_at), jr.shipment_id, jr.shipment_box_id) AS sort_index,
    jr.shipment_id,
    jr.shipment_box_id,
    NULL::int AS box_number
  FROM job_rows jr
  CROSS JOIN has_targets ht
  WHERE NOT ht.value
  GROUP BY jr.shipment_id, jr.shipment_box_id
),
target_rows AS (
  SELECT * FROM input_targets
  UNION ALL
  SELECT * FROM fallback_targets
),
resolved AS (
  SELECT
    tr.sort_index,
    tr.shipment_id,
    tr.shipment_box_id,
    tr.box_number,
    jr.job_id,
    jr.job_status,
    jr.output_file_url,
    jr.created_at,
    jr.completed_at,
    jr.error_reason,
    jr.label_id,
    jr.generated_at,
    jr.last_attempt_at,
    jr.lease_expires_at
  FROM target_rows tr
  LEFT JOIN LATERAL (
    SELECT jr.*
    FROM job_rows jr
    WHERE jr.shipment_id = tr.shipment_id
      AND jr.shipment_box_id IS NOT DISTINCT FROM tr.shipment_box_id
    ORDER BY COALESCE(jr.completed_at, jr.created_at) DESC, jr.job_id DESC
    LIMIT 1
  ) jr ON TRUE
),
render_stats AS (
  SELECT
    MIN(created_at) AS first_job_created_at,
    MAX(completed_at) FILTER (WHERE completed_at IS NOT NULL) AS last_job_completed_at
  FROM job_rows
),
aggregates AS (
  SELECT
    COUNT(*)::int AS expected_count,
    COUNT(DISTINCT job_id)::int AS total_job_count,
    COUNT(*) FILTER (
      WHERE job_status = 'succeeded'
        AND output_file_url IS NOT NULL
    )::int AS ready_count,
    COUNT(*) FILTER (
      WHERE job_status = 'failed'
    )::int AS failed_count,
    COUNT(*) FILTER (
      WHERE job_status = 'in_progress'
    )::int AS in_progress_count,
    COUNT(*) FILTER (
      WHERE job_status = 'pending'
    )::int AS dispatchable_count,
    COUNT(*) FILTER (
      WHERE job_id IS NULL
         OR (
              job_status IS DISTINCT FROM 'failed'
              AND NOT (job_status = 'succeeded' AND output_file_url IS NOT NULL)
            )
    )::int AS pending_count,
    COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'shipment_id', shipment_id,
            'shipment_box_id', shipment_box_id,
            'box_number', box_number,
            'label_job_id', job_id,
            'label_id', label_id,
            'file_url', output_file_url,
            'generated_at', generated_at,
            'status', 'ready'
          )
        )
        ORDER BY sort_index
      ) FILTER (
        WHERE job_status = 'succeeded'
          AND output_file_url IS NOT NULL
      ),
      '[]'::jsonb
    ) AS ready,
    COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'shipment_id', shipment_id,
            'shipment_box_id', shipment_box_id,
            'box_number', box_number,
            'label_job_id', job_id,
            'status', CASE WHEN job_id IS NULL THEN 'missing' ELSE COALESCE(job_status, 'pending') END,
            'last_attempt_at', last_attempt_at,
            'lease_expires_at', lease_expires_at
          )
        )
        ORDER BY sort_index
      ) FILTER (
        WHERE job_id IS NULL
           OR (
                job_status IS DISTINCT FROM 'failed'
                AND NOT (job_status = 'succeeded' AND output_file_url IS NOT NULL)
              )
      ),
      '[]'::jsonb
    ) AS pending,
    COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'shipment_id', shipment_id,
            'shipment_box_id', shipment_box_id,
            'box_number', box_number,
            'label_job_id', job_id,
            'label_id', label_id,
            'error_reason', error_reason,
            'status', 'failed'
          )
        )
        ORDER BY sort_index
      ) FILTER (
        WHERE job_status = 'failed'
      ),
      '[]'::jsonb
    ) AS failed,
    COALESCE(
      (
        SELECT jsonb_agg(jr.job_id ORDER BY jr.created_at, jr.job_id)
        FROM job_rows jr
      ),
      '[]'::jsonb
    ) AS label_job_ids,
    COALESCE(
      (
        SELECT jsonb_agg(jr.job_id ORDER BY jr.created_at, jr.job_id)
        FROM job_rows jr
        WHERE jr.job_status = 'pending'
      ),
      '[]'::jsonb
    ) AS dispatchable_label_job_ids
  FROM resolved
)
SELECT jsonb_strip_nulls(
  jsonb_build_object(
    'expected_count', a.expected_count,
    'total_job_count', a.total_job_count,
    'ready_count', a.ready_count,
    'failed_count', a.failed_count,
    'in_progress_count', a.in_progress_count,
    'dispatchable_count', a.dispatchable_count,
    'pending_count', a.pending_count,
    'ready', a.ready,
    'pending', a.pending,
    'failed', a.failed,
    'label_job_ids', a.label_job_ids,
    'dispatchable_label_job_ids', a.dispatchable_label_job_ids,
    'first_job_created_at', rs.first_job_created_at,
    'last_job_completed_at', rs.last_job_completed_at,
    'render_wait_ms', CASE
      WHEN rs.first_job_created_at IS NOT NULL AND rs.last_job_completed_at IS NOT NULL
        THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (rs.last_job_completed_at - rs.first_job_created_at)) * 1000))::int
      ELSE NULL
    END
  )
)
FROM aggregates a
CROSS JOIN render_stats rs;
$$;

COMMENT ON FUNCTION public.resolve_label_print_fresh_scope_v1(uuid, jsonb)
  IS 'Resolve fresh-only label print readiness from the current workflow step scope; includes dispatchable pending job ids for targeted render invokes.';

CREATE OR REPLACE FUNCTION public.resolve_label_renderer_invoke_request_v1(
  p_max_jobs int DEFAULT 5,
  p_payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_settings jsonb;
  v_provider jsonb;
  v_url text;
  v_secret text;
  v_timeout_ms int;
  v_timeout_seconds int;
  v_headers jsonb;
  v_body jsonb;
  v_scope_type text := 'global';
  v_scope_id uuid := NULL;
  v_payload_org_id uuid := NULL;
  v_payload_client_id uuid := NULL;
  v_payload_sender_id uuid := NULL;
  v_payload_source_id uuid := NULL;
BEGIN
  v_body := CASE
    WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
      THEN jsonb_strip_nulls(p_payload)
    ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
  END;

  IF COALESCE(v_body->>'organization_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_payload_org_id := (v_body->>'organization_id')::uuid;
  END IF;
  IF COALESCE(v_body->>'client_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_payload_client_id := (v_body->>'client_id')::uuid;
  END IF;
  IF COALESCE(v_body->>'sender_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_payload_sender_id := (v_body->>'sender_id')::uuid;
  END IF;
  IF COALESCE(COALESCE(v_body->>'webhook_source_id', v_body->>'source_id'), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_payload_source_id := COALESCE(v_body->>'webhook_source_id', v_body->>'source_id')::uuid;
  END IF;

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
  END IF;

  v_settings := public.resolve_settings('label_provider', v_scope_type, v_scope_id);
  IF v_settings IS NULL THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_request_v1: label_provider settings not found (scope=%/%)', v_scope_type, v_scope_id;
  END IF;

  v_provider := COALESCE((v_settings->'providers')->0, '{}'::jsonb);
  v_url := NULLIF(v_provider->>'invoke_url', '');
  v_secret := NULLIF(v_provider->>'invoke_secret', '');
  v_timeout_ms := COALESCE(NULLIF(v_provider->>'timeout_ms', '')::int, 15000);

  IF v_url IS NULL THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_request_v1: invoke_url missing in label_provider configuration';
  END IF;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_request_v1: invoke_secret missing in label_provider configuration';
  END IF;

  IF v_url LIKE 'https://example.%' OR v_secret = 'EXAMPLE_PASSWORD' THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_request_v1: provider invoke configuration not activated (update settings)';
  END IF;

  v_headers := jsonb_build_object(
    'content-type', 'application/json',
    'authorization', concat('Bearer ', v_secret)
  );

  IF jsonb_typeof(v_provider->'headers') = 'object' THEN
    v_headers := v_headers || (v_provider->'headers');
  END IF;

  v_timeout_seconds := GREATEST((v_timeout_ms + 999) / 1000, 1);

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'url', v_url,
      'headers', v_headers,
      'body', v_body,
      'timeout_ms', v_timeout_ms,
      'timeout_seconds', v_timeout_seconds,
      'provider_name', NULLIF(v_provider->>'name', ''),
      'provider_scope_type', v_scope_type,
      'provider_scope_id', v_scope_id
    )
  );
END;
$$;

COMMENT ON FUNCTION public.resolve_label_renderer_invoke_request_v1(int, jsonb)
  IS 'Resolve the canonical label-renderer HTTP invoke request from label_provider settings via the scope ladder.';

REVOKE ALL ON FUNCTION public.resolve_label_renderer_invoke_request_v1(int, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_renderer_invoke_request_v1(int, jsonb) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_label_renderer_invoke_request_v1(int, jsonb) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_label_renderer(
  p_max_jobs int DEFAULT 5,
  p_payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_request jsonb;
  v_request_id bigint;
  v_timeout_seconds int := 30;
BEGIN
  v_request := public.resolve_label_renderer_invoke_request_v1(p_max_jobs, p_payload);
  v_timeout_seconds := COALESCE(NULLIF(v_request->>'timeout_seconds', '')::int, 30);

  v_request_id := public.dispatch_api_request_v1(
    v_request->>'url',
    'POST',
    COALESCE(v_request->'headers', '{}'::jsonb),
    COALESCE(v_request->'body', '{}'::jsonb),
    v_timeout_seconds
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'status', 202,
      'completed', FALSE,
      'request_id', v_request_id,
      'latency_ms', 0,
      'headers', '{}'::jsonb,
      'body', jsonb_build_object(
        'message', 'HTTP request accepted - response pending',
        'request_id', v_request_id,
        'poll_sql', format('SELECT * FROM check_async_response(%s);', v_request_id),
        'note', 'Call check_async_response(request_id) or query net._http_response for completion'
      ),
      'request_payload', COALESCE(v_request->'body', '{}'::jsonb),
      'provider_name', v_request->>'provider_name',
      'provider_scope_type', v_request->>'provider_scope_type',
      'provider_scope_id', v_request->'provider_scope_id'
    )
  );
END;
$$;

COMMENT ON FUNCTION public.invoke_label_renderer(int, jsonb)
  IS 'Trigger label renderer edge worker asynchronously via dispatch_api_request_v1; returns request_id for polling.';

GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(int, jsonb) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(int, jsonb) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_prepare_v4(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_response public.workflow_handler_response;
  v_base_response public.workflow_handler_response;
  v_context jsonb := COALESCE(p_run.context, '{}'::jsonb);
  v_label_state jsonb := COALESCE(v_context->'label_print', '{}'::jsonb);
  v_policy jsonb := '{}'::jsonb;
  v_targets jsonb := COALESCE(v_label_state->'targets', '[]'::jsonb);
  v_shipments jsonb := COALESCE(v_label_state->'shipments', '[]'::jsonb);
  v_options jsonb := COALESCE(v_label_state->'options', '{}'::jsonb);
  v_out_of_scope jsonb := COALESCE(v_label_state->'out_of_scope', '[]'::jsonb);
  v_invalid_boxes jsonb := COALESCE(v_label_state->'invalid_boxes', '[]'::jsonb);
  v_counts jsonb := COALESCE(v_label_state->'counts', '{}'::jsonb);
  v_fresh_state jsonb := '{}'::jsonb;
  v_grouped_shipments jsonb := '[]'::jsonb;
  v_ready jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_label_job_ids jsonb := '[]'::jsonb;
  v_dispatchable_label_job_ids jsonb := '[]'::jsonb;
  v_org_id uuid := NULL;
  v_requested_by uuid := NULL;
  v_requested_count int := 0;
  v_in_scope_count int := 0;
  v_ready_count int := 0;
  v_pending_count int := 0;
  v_failed_count int := 0;
  v_expected_count int := 0;
  v_dispatchable_count int := 0;
  v_poll_seconds int := 1;
  v_render_enabled boolean := false;
  v_render_max_jobs int := 50;
  v_render_job_concurrency int := 10;
  v_render_lease_seconds int := 60;
  v_render_max_calls int := 20;
  v_render_dispatch_state jsonb := NULL;
  v_dispatch_request_ids jsonb := '[]'::jsonb;
  v_dispatch_request_count int := 0;
  v_dispatched_job_count int := 0;
  v_dispatch_window_exhausted boolean := false;
  v_dispatch_cursor int := 0;
  v_dispatch_chunk jsonb := '[]'::jsonb;
  v_dispatch_request jsonb := '{}'::jsonb;
  v_dispatch_chunk_size int := 0;
  v_fresh_generation_required boolean := true;
  v_fresh_resolve_mode text := 'workflow_scope_only';
  v_generation_enqueued boolean := COALESCE((v_label_state->>'generation_enqueued')::boolean, false);
  v_generation_source text := format('workflow.labels_print:%s', p_step.id);
BEGIN
  v_org_id := COALESCE(
    NULLIF(v_label_state->>'organization_id', '')::uuid,
    NULLIF(v_context->>'organization_id', '')::uuid,
    NULLIF(v_context->'payload'->>'organization_id', '')::uuid
  );

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'execute_label_print_prepare_v4: organization_id not present in workflow context';
  END IF;

  v_policy := COALESCE(
    resolve_settings('label_print_policy', 'tenant', v_org_id),
    resolve_settings('label_print_policy', 'global', NULL),
    '{}'::jsonb
  );

  v_fresh_generation_required := COALESCE((v_policy->>'fresh_generation_required')::boolean, true);
  v_fresh_resolve_mode := lower(COALESCE(NULLIF(v_policy->>'fresh_resolve_mode', ''), 'workflow_scope_only'));

  IF NOT v_fresh_generation_required OR v_fresh_resolve_mode <> 'workflow_scope_only' THEN
    RETURN workflow_handlers.execute_label_print_prepare_v3(p_step, p_run, p_operation_result);
  END IF;

  IF jsonb_typeof(v_targets) IS DISTINCT FROM 'array' OR jsonb_array_length(v_targets) = 0 THEN
    v_base_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);

    v_targets := COALESCE(
      (
        WITH candidate_targets AS (
          SELECT elem, ordinality::int AS sort_index
          FROM jsonb_array_elements(
                 COALESCE(v_base_response.operation_result->'ready', '[]'::jsonb)
                 || COALESCE(v_base_response.operation_result->'pending', '[]'::jsonb)
               ) WITH ORDINALITY AS t(elem, ordinality)
          WHERE elem ? 'shipment_id'
        ),
        deduped AS (
          SELECT DISTINCT ON (
              NULLIF(elem->>'shipment_id', '')::uuid,
              COALESCE(NULLIF(elem->>'shipment_box_id', ''), '00000000-0000-0000-0000-000000000000')
            )
            NULLIF(elem->>'shipment_id', '')::uuid AS shipment_id,
            CASE
              WHEN COALESCE(elem->>'shipment_box_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                THEN (elem->>'shipment_box_id')::uuid
              ELSE NULL
            END AS shipment_box_id,
            CASE
              WHEN COALESCE(elem->>'box_number', '') ~ '^\d+$'
                THEN (elem->>'box_number')::int
              ELSE NULL
            END AS box_number,
            sort_index
          FROM candidate_targets
          ORDER BY
            NULLIF(elem->>'shipment_id', '')::uuid,
            COALESCE(NULLIF(elem->>'shipment_box_id', ''), '00000000-0000-0000-0000-000000000000'),
            sort_index
        )
        SELECT COALESCE(
          jsonb_agg(
            jsonb_strip_nulls(
              jsonb_build_object(
                'shipment_id', shipment_id,
                'shipment_box_id', shipment_box_id,
                'box_number', box_number,
                'status', 'pending'
              )
            )
            ORDER BY sort_index
          ),
          '[]'::jsonb
        )
        FROM deduped
      ),
      '[]'::jsonb
    );

    v_shipments := COALESCE(v_base_response.context_patch->'label_print'->'shipments', COALESCE(v_base_response.operation_result->'shipments', '[]'::jsonb), '[]'::jsonb);
    v_options := COALESCE(v_base_response.context_patch->'label_print'->'options', v_options, '{}'::jsonb);
    v_out_of_scope := COALESCE(v_base_response.operation_result->'out_of_scope', '[]'::jsonb);
    v_invalid_boxes := COALESCE(v_base_response.operation_result->'invalid_boxes', '[]'::jsonb);
    v_counts := COALESCE(v_base_response.operation_result->'counts', '{}'::jsonb);
  END IF;

  v_requested_by := COALESCE(
    NULLIF(v_context->>'requested_by', '')::uuid,
    NULLIF(v_context->'payload'->>'requested_by', '')::uuid,
    NULLIF(v_label_state->>'requested_by', '')::uuid
  );

  IF jsonb_typeof(v_targets) IS DISTINCT FROM 'array' THEN
    v_targets := '[]'::jsonb;
  END IF;

  v_expected_count := COALESCE(jsonb_array_length(v_targets), 0);
  v_requested_count := COALESCE(NULLIF(v_counts->>'requested', '')::int, v_expected_count);
  v_in_scope_count := COALESCE(NULLIF(v_counts->>'in_scope', '')::int, v_expected_count);

  IF v_expected_count > 0 THEN
    SELECT COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'shipment_id', shipment_id,
            'box_ids', CASE
              WHEN array_length(shipment_box_ids, 1) IS NULL THEN NULL
              ELSE to_jsonb(shipment_box_ids)
            END
          )
        )
        ORDER BY shipment_order
      ),
      '[]'::jsonb
    )
    INTO v_grouped_shipments
    FROM (
      SELECT
        shipment_id,
        MIN(sort_index) AS shipment_order,
        array_agg(shipment_box_id ORDER BY sort_index) FILTER (WHERE shipment_box_id IS NOT NULL) AS shipment_box_ids
      FROM (
        SELECT
          ordinality::int AS sort_index,
          NULLIF(elem->>'shipment_id', '')::uuid AS shipment_id,
          CASE
            WHEN COALESCE(elem->>'shipment_box_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              THEN (elem->>'shipment_box_id')::uuid
            ELSE NULL
          END AS shipment_box_id
        FROM jsonb_array_elements(v_targets) WITH ORDINALITY AS t(elem, ordinality)
        WHERE elem ? 'shipment_id'
      ) grouped
      GROUP BY shipment_id
    ) shipment_groups;

    v_fresh_state := public.resolve_label_print_fresh_scope_v1(p_step.id, v_targets);

    IF COALESCE((v_fresh_state->>'total_job_count')::int, 0) < v_expected_count THEN
      PERFORM public.request_label_generation_bulk_v1(
        v_grouped_shipments,
        'shipping',
        v_requested_by,
        v_generation_source,
        'reprint'
      );
      v_generation_enqueued := true;
      v_fresh_state := public.resolve_label_print_fresh_scope_v1(p_step.id, v_targets);
    END IF;
  END IF;

  v_ready := COALESCE(v_fresh_state->'ready', '[]'::jsonb);
  v_pending := COALESCE(v_fresh_state->'pending', '[]'::jsonb);
  v_failed := COALESCE(v_fresh_state->'failed', '[]'::jsonb);
  v_label_job_ids := COALESCE(v_fresh_state->'label_job_ids', '[]'::jsonb);
  v_dispatchable_label_job_ids := COALESCE(v_fresh_state->'dispatchable_label_job_ids', '[]'::jsonb);
  v_ready_count := COALESCE(NULLIF(v_fresh_state->>'ready_count', '')::int, 0);
  v_pending_count := COALESCE(NULLIF(v_fresh_state->>'pending_count', '')::int, 0);
  v_failed_count := COALESCE(NULLIF(v_fresh_state->>'failed_count', '')::int, 0);
  v_dispatchable_count := COALESCE(NULLIF(v_fresh_state->>'dispatchable_count', '')::int, 0);

  v_render_enabled := COALESCE((v_policy->>'render_invoke_enabled')::boolean, false);
  v_render_max_jobs := LEAST(GREATEST(COALESCE(NULLIF(v_policy->>'render_max_jobs', '')::int, 50), 1), 200);
  v_render_job_concurrency := LEAST(GREATEST(COALESCE(NULLIF(v_policy->>'render_job_concurrency', '')::int, 10), 1), 50);
  v_render_lease_seconds := LEAST(GREATEST(COALESCE(NULLIF(v_policy->>'render_lease_seconds', '')::int, 60), 60), 600);
  v_render_max_calls := LEAST(GREATEST(COALESCE(NULLIF(v_policy->>'render_max_calls', '')::int, 20), 1), 50);

  IF v_dispatchable_count > 0 AND v_render_enabled THEN
    IF jsonb_typeof(v_dispatchable_label_job_ids) IS DISTINCT FROM 'array' THEN
      v_dispatchable_label_job_ids := '[]'::jsonb;
    END IF;

    WHILE v_dispatch_cursor < v_dispatchable_count AND v_dispatch_request_count < v_render_max_calls LOOP
      SELECT COALESCE(
        jsonb_agg(value ORDER BY ordinality),
        '[]'::jsonb
      )
      INTO v_dispatch_chunk
      FROM (
        SELECT value, ordinality
        FROM jsonb_array_elements(v_dispatchable_label_job_ids) WITH ORDINALITY AS t(value, ordinality)
        WHERE ordinality > v_dispatch_cursor
          AND ordinality <= v_dispatch_cursor + v_render_max_jobs
      ) dispatch_chunk;

      v_dispatch_chunk_size := COALESCE(jsonb_array_length(v_dispatch_chunk), 0);
      EXIT WHEN v_dispatch_chunk_size = 0;

      v_dispatch_request := public.invoke_label_renderer(
        NULL,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org_id,
          'workflow_run_step_id', p_step.id,
          'requested_source', v_generation_source,
          'lease_seconds', v_render_lease_seconds,
          'max_jobs', v_dispatch_chunk_size,
          'job_concurrency', v_render_job_concurrency,
          'job_ids', v_dispatch_chunk
        ))
      );

      IF NULLIF(v_dispatch_request->>'request_id', '') IS NOT NULL THEN
        v_dispatch_request_ids := v_dispatch_request_ids || jsonb_build_array((v_dispatch_request->>'request_id')::bigint);
      END IF;

      v_dispatched_job_count := v_dispatched_job_count + v_dispatch_chunk_size;
      v_dispatch_request_count := v_dispatch_request_count + 1;
      v_dispatch_cursor := v_dispatch_cursor + v_dispatch_chunk_size;
    END LOOP;

    v_dispatch_window_exhausted := v_dispatched_job_count < v_dispatchable_count;
    v_render_dispatch_state := jsonb_strip_nulls(
      jsonb_build_object(
        'request_ids', CASE
          WHEN jsonb_array_length(v_dispatch_request_ids) > 0 THEN v_dispatch_request_ids
          ELSE NULL
        END,
        'request_count', v_dispatch_request_count,
        'dispatched_job_count', v_dispatched_job_count,
        'dispatchable_job_count', v_dispatchable_count,
        'remaining_dispatchable_count', GREATEST(v_dispatchable_count - v_dispatched_job_count, 0),
        'max_jobs', v_render_max_jobs,
        'max_calls', v_render_max_calls,
        'job_concurrency', v_render_job_concurrency,
        'lease_seconds', v_render_lease_seconds,
        'window_exhausted', CASE WHEN v_dispatch_window_exhausted THEN true ELSE NULL END
      )
    );
  END IF;

  v_poll_seconds := LEAST(
    GREATEST(
      COALESCE(
        NULLIF(p_step.metadata->>'poll_interval_seconds', '')::int,
        NULLIF(v_policy->>'poll_interval_seconds', '')::int,
        1
      ),
      1
    ),
    300
  );

  v_counts := jsonb_strip_nulls(jsonb_build_object(
    'requested', v_requested_count,
    'in_scope', v_in_scope_count,
    'ready', v_ready_count,
    'pending', v_pending_count,
    'dispatchable', v_dispatchable_count,
    'failed', v_failed_count,
    'timed_out', 0,
    'out_of_scope', COALESCE(jsonb_array_length(v_out_of_scope), 0),
    'invalid_box_requests', COALESCE(jsonb_array_length(v_invalid_boxes), 0),
    'expected', v_expected_count
  ));

  IF v_failed_count > 0 THEN
    v_response.status := 'failed';
    v_response.last_error := 'label_jobs_failed';
  ELSIF v_expected_count > 0 AND v_ready_count < v_expected_count THEN
    v_response.status := 'pending';
    v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
    v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
    v_response.max_retries := p_step.max_retries;
  ELSE
    v_response.status := 'completed';
  END IF;

  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'status', v_response.status,
    'ready', v_ready,
    'pending', v_pending,
    'failed', v_failed,
    'timed_out', '[]'::jsonb,
    'out_of_scope', v_out_of_scope,
    'invalid_boxes', v_invalid_boxes,
    'counts', v_counts,
    'policy', v_policy,
    'label_job_ids', v_label_job_ids,
    'fresh_request_scope_key', p_step.id::text,
    'fresh_generation_required', v_fresh_generation_required,
    'fresh_resolve_mode', v_fresh_resolve_mode,
    'render_wait_ms', v_fresh_state->'render_wait_ms',
    'render_dispatch', v_render_dispatch_state
  ));

  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'label_print', jsonb_build_object(
      'organization_id', v_org_id,
      'generation_enqueued', v_generation_enqueued,
      'ready', v_ready,
      'pending', v_pending,
      'failed', v_failed,
      'timed_out', '[]'::jsonb,
      'out_of_scope', v_out_of_scope,
      'invalid_boxes', v_invalid_boxes,
      'counts', v_counts,
      'options', v_options,
      'policy', v_policy,
      'shipments', COALESCE(v_shipments, '[]'::jsonb),
      'targets', v_targets,
      'label_job_ids', v_label_job_ids,
      'fresh_generation_required', v_fresh_generation_required,
      'fresh_resolve_mode', v_fresh_resolve_mode,
      'fresh_request_scope_key', p_step.id::text,
      'requested_source', v_generation_source,
      'render_dispatch', v_render_dispatch_state
    )
  ));

  RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v4(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Prepare labels for bundling (v4): fresh-only workflow-scope readiness plus bounded async dispatch for all current-scope pending jobs without sync renderer waits.';

SELECT pg_advisory_unlock(hashtext('202603061750_label_print_prepare_async_dispatch_v1'));
COMMIT;
