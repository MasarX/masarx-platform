-- Migration: label_print_prepare_v2 fresh generation enforcement
-- Purpose:
--  - Enforce fresh-per-click generation when label_print_policy.fresh_generation_required=true.
--  - Keep async invoke path row-driven and non-blocking.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

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
  v_ready JSONB := '[]'::jsonb;
  v_fresh_pending JSONB := '[]'::jsonb;
  v_org_id UUID := NULL;
  v_row RECORD;

  v_generation_enqueued BOOLEAN := FALSE;
  v_fresh_generation_required BOOLEAN := TRUE;
  v_generation_source TEXT := format('workflow.labels_print:%s', p_step.id);

  v_render_enabled BOOLEAN := FALSE;
  v_render_max_jobs INT := 50;
  v_render_job_concurrency INT := 10;
  v_render_lease_seconds INT := 60;
BEGIN
  v_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);

  v_policy := COALESCE(v_response.operation_result->'policy', '{}'::jsonb);
  v_org_id := NULLIF(v_response.context_patch->'label_print'->>'organization_id', '')::uuid;
  v_generation_enqueued := COALESCE((v_response.context_patch->'label_print'->>'generation_enqueued')::BOOLEAN, FALSE);
  v_fresh_generation_required := COALESCE((v_policy->>'fresh_generation_required')::BOOLEAN, TRUE);

  IF v_fresh_generation_required AND NOT v_generation_enqueued AND v_org_id IS NOT NULL THEN
    v_ready := COALESCE(v_response.operation_result->'ready', '[]'::jsonb);
    IF jsonb_typeof(v_ready) = 'array' AND jsonb_array_length(v_ready) > 0 THEN
      v_fresh_pending := v_ready;

      FOR v_row IN
        SELECT
          (elem->>'shipment_id')::uuid AS shipment_id,
          array_agg((elem->>'shipment_box_id')::uuid) FILTER (WHERE NULLIF(elem->>'shipment_box_id', '') IS NOT NULL) AS shipment_box_ids
        FROM jsonb_array_elements(v_fresh_pending) elem
        WHERE elem ? 'shipment_id'
        GROUP BY (elem->>'shipment_id')::uuid
      LOOP
        PERFORM public.request_label_generation_batch(
          v_row.shipment_id,
          'shipping',
          NULL,
          v_generation_source,
          v_row.shipment_box_ids,
          'reprint'
        );
      END LOOP;

      v_response.status := 'pending';
      v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
      v_response.operation_result := jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(v_response.operation_result, '{}'::jsonb),
              '{ready}',
              '[]'::jsonb,
              true
            ),
            '{pending}',
            v_fresh_pending,
            true
          ),
          '{counts,ready}',
          to_jsonb(0),
          true
        ),
        '{counts,pending}',
        to_jsonb(jsonb_array_length(v_fresh_pending)),
        true
      );
      v_response.context_patch := jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(v_response.context_patch, '{}'::jsonb),
              '{label_print,generation_enqueued}',
              to_jsonb(true),
              true
            ),
            '{label_print,ready}',
            '[]'::jsonb,
            true
          ),
          '{label_print,pending}',
          v_fresh_pending,
          true
        ),
        '{label_print,requested_source}',
        to_jsonb(v_generation_source),
        true
      );
    END IF;
  END IF;

  IF v_response.status IS DISTINCT FROM 'pending' THEN
    RETURN v_response;
  END IF;

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
  v_render_job_concurrency := LEAST(GREATEST(v_render_job_concurrency, 1), 25);
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
  IS 'Prepare labels for bundling (v2): batch enqueue + fresh-generation guard + optional async invoke_label_renderer (no sync wait).';

COMMIT;
