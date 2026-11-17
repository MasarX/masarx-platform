-- Migration: label print prepare v4 requested_by context fix
-- Purpose:
--  - Repair fresh-only prepare handler runtime failure by resolving requested_by from workflow context only.
--  - Keep the fresh-scope contract unchanged; this is a runtime compatibility fix.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061340_label_print_prepare_v4_requested_by_fix'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_org_id uuid := NULL;
  v_requested_by uuid := NULL;
  v_requested_count int := 0;
  v_in_scope_count int := 0;
  v_ready_count int := 0;
  v_pending_count int := 0;
  v_failed_count int := 0;
  v_expected_count int := 0;
  v_poll_seconds int := 1;
  v_render_enabled boolean := false;
  v_render_max_jobs int := 50;
  v_render_job_concurrency int := 10;
  v_render_lease_seconds int := 60;
  v_fresh_generation_required boolean := true;
  v_fresh_resolve_mode text := 'workflow_scope_only';
  v_generation_enqueued boolean := COALESCE((v_label_state->>'generation_enqueued')::boolean, false);
  v_generation_source text := format('workflow.labels_print:%s', p_step.id);
  v_should_invoke_render boolean := false;
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
      v_should_invoke_render := true;
      v_generation_enqueued := true;
      v_fresh_state := public.resolve_label_print_fresh_scope_v1(p_step.id, v_targets);
    END IF;
  END IF;

  v_ready := COALESCE(v_fresh_state->'ready', '[]'::jsonb);
  v_pending := COALESCE(v_fresh_state->'pending', '[]'::jsonb);
  v_failed := COALESCE(v_fresh_state->'failed', '[]'::jsonb);
  v_label_job_ids := COALESCE(v_fresh_state->'label_job_ids', '[]'::jsonb);
  v_ready_count := COALESCE(NULLIF(v_fresh_state->>'ready_count', '')::int, 0);
  v_pending_count := COALESCE(NULLIF(v_fresh_state->>'pending_count', '')::int, 0);
  v_failed_count := COALESCE(NULLIF(v_fresh_state->>'failed_count', '')::int, 0);

  v_render_enabled := COALESCE((v_policy->>'render_invoke_enabled')::boolean, false);
  v_render_max_jobs := LEAST(GREATEST(COALESCE(NULLIF(v_policy->>'render_max_jobs', '')::int, 50), 1), 200);
  v_render_job_concurrency := LEAST(GREATEST(COALESCE(NULLIF(v_policy->>'render_job_concurrency', '')::int, 10), 1), 50);
  v_render_lease_seconds := LEAST(GREATEST(COALESCE(NULLIF(v_policy->>'render_lease_seconds', '')::int, 60), 60), 600);

  IF v_pending_count > 0 AND v_render_enabled AND v_should_invoke_render THEN
    PERFORM public.invoke_label_renderer(
      NULL,
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'lease_seconds', v_render_lease_seconds,
        'max_jobs', LEAST(v_render_max_jobs, GREATEST(v_pending_count, 1)),
        'job_concurrency', v_render_job_concurrency
      ))
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
    'render_wait_ms', v_fresh_state->'render_wait_ms'
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
      'requested_source', v_generation_source
    )
  ));

  RETURN v_response;
END;
$$;;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v4(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Prepare labels for bundling (v4): fresh-only workflow-scope readiness, reusable bulk enqueue, and no global latest-label reuse.';

SELECT pg_advisory_unlock(hashtext('202603061340_label_print_prepare_v4_requested_by_fix'));
COMMIT;
