-- Migration: Labels print prepare v2 (sync render invoke)
-- Purpose:
--  - Add a v2 prepare handler that invokes the label renderer immediately when labels are pending.
--  - Keeps workflow ordering intact while reducing end-to-end latency (sync path).

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
  v_org_id UUID := NULL;
  v_render_enabled BOOLEAN := TRUE;
  v_render_max_jobs INT := 100;
  v_render_job_concurrency INT := 10;
  v_render_lease_seconds INT := 180;
BEGIN
  v_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);

  IF v_response.status IS DISTINCT FROM 'pending' THEN
    RETURN v_response;
  END IF;

  v_policy := COALESCE(v_response.operation_result->'policy', '{}'::jsonb);
  v_pending := COALESCE(v_response.operation_result->'pending', '[]'::jsonb);
  v_org_id := NULLIF(v_response.context_patch->'label_print'->>'organization_id', '')::uuid;

  v_render_enabled := COALESCE((v_policy->>'render_invoke_enabled')::BOOLEAN, TRUE);
  IF NOT v_render_enabled THEN
    RETURN v_response;
  END IF;

  v_render_max_jobs := COALESCE(NULLIF((v_policy->>'render_max_jobs')::INT, 0), 100);
  v_render_job_concurrency := COALESCE(NULLIF((v_policy->>'render_job_concurrency')::INT, 0), 10);
  v_render_lease_seconds := COALESCE(NULLIF((v_policy->>'render_lease_seconds')::INT, 0), 180);

  v_render_max_jobs := LEAST(GREATEST(v_render_max_jobs, 1), 100);
  v_render_job_concurrency := LEAST(GREATEST(v_render_job_concurrency, 1), 10);
  v_render_lease_seconds := LEAST(GREATEST(v_render_lease_seconds, 60), 600);

  IF jsonb_typeof(v_pending) = 'array' THEN
    v_render_max_jobs := LEAST(v_render_max_jobs, GREATEST(jsonb_array_length(v_pending), 1));
  END IF;

  IF v_org_id IS NULL THEN
    RETURN v_response;
  END IF;

  BEGIN
    PERFORM invoke_label_renderer(
      NULL,
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'lease_seconds', v_render_lease_seconds,
        'max_jobs', v_render_max_jobs,
        'job_concurrency', v_render_job_concurrency
      ))
    );
  EXCEPTION WHEN OTHERS THEN
    v_response.last_error := SQLERRM;
    RETURN v_response;
  END;

  -- Re-evaluate immediately after invoking the renderer (sync path).
  v_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);
  RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v2(workflow_run_steps, workflow_runs, JSONB)
  IS 'Prepare labels for bundling (v2): batch enqueue + synchronous invoke_label_renderer when pending.';

-- Wire v2 into operation_handlers + workflow template
INSERT INTO operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'label_print_prepare',
  'workflow_handlers',
  'execute_label_print_prepare_v2',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v2',
  TRUE,
  'Prepare labels for bundling (v2): batch enqueue + synchronous renderer invoke.',
  'docs/ops/runbooks/label_renderer_runbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = TRUE,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

UPDATE workflow_template_steps
SET handler_version = 'v2',
    updated_at = now()
WHERE workflow_template_id = (SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' LIMIT 1)
  AND handler_key = 'label_print_prepare';

COMMIT;
