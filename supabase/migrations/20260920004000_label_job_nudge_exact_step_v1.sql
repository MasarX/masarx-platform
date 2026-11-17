-- Keep label-job completion nudges scoped to the exact owning workflow step.
-- A completion callback must not recurse into a downstream Edge-backed step
-- while the renderer is still awaiting the completion RPC transaction.

BEGIN;
SELECT pg_advisory_lock(hashtext('20260920004000_label_job_nudge_exact_step_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.nudge_workflow_run_for_label_jobs_v1(
  p_workflow_run_step_id uuid,
  p_reason text DEFAULT 'label_jobs_terminal'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_run_id uuid := NULL;
  v_org_id uuid := NULL;
  v_policy jsonb := '{}'::jsonb;
  v_enabled boolean := true;
  v_budget_ms int := 750;
  v_remaining_count int := 0;
  v_org_raw text := '';
BEGIN
  IF p_workflow_run_step_id IS NULL THEN
    RAISE EXCEPTION 'nudge_workflow_run_for_label_jobs_v1 requires workflow_run_step_id';
  END IF;

  SELECT wrs.workflow_run_id,
         COALESCE(wr.context->>'organization_id', '')
  INTO v_run_id, v_org_raw
  FROM public.workflow_run_steps wrs
  JOIN public.workflow_runs wr ON wr.id = wrs.workflow_run_id
  WHERE wrs.id = p_workflow_run_step_id
  LIMIT 1;

  IF v_run_id IS NULL THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_org_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_org_id := v_org_raw::uuid;
  END IF;

  SELECT COUNT(*)
  INTO v_remaining_count
  FROM public.label_jobs lj
  WHERE lj.workflow_run_step_id = p_workflow_run_step_id
    AND (
      lj.status NOT IN ('succeeded', 'failed')
      OR (lj.status = 'succeeded' AND lj.output_file_url IS NULL)
    );

  IF v_remaining_count > 0 THEN
    RETURN jsonb_build_object(
      'status', 'pending',
      'workflow_run_step_id', p_workflow_run_step_id,
      'remaining_count', v_remaining_count
    );
  END IF;

  v_policy := COALESCE(
    CASE
      WHEN v_org_id IS NOT NULL THEN public.resolve_settings('label_print_policy', 'tenant', v_org_id)
      ELSE NULL
    END,
    public.resolve_settings('label_print_policy', 'global', NULL),
    '{}'::jsonb
  );

  v_enabled := COALESCE((v_policy->>'prepare_inline_progress_enabled')::boolean, true);
  IF COALESCE(v_policy->>'prepare_inline_progress_budget_ms', '') ~ '^\d+$' THEN
    v_budget_ms := LEAST(GREATEST((v_policy->>'prepare_inline_progress_budget_ms')::int, 25), 5000);
  END IF;

  IF NOT v_enabled THEN
    RETURN jsonb_build_object(
      'status', 'disabled',
      'workflow_run_step_id', p_workflow_run_step_id,
      'workflow_run_id', v_run_id
    );
  END IF;

  -- Targeting the owning step makes late/replayed completion idempotent:
  -- an already-completed step returns already_completed and cannot consume
  -- its result on the next label_bundle or other downstream step. One step is
  -- sufficient to wake and settle the exact label-job-owning prepare step.
  RETURN public.progress_workflow_run_step_result_v1(
    v_run_id,
    p_workflow_run_step_id,
    jsonb_build_object(
      'source', COALESCE(NULLIF(p_reason, ''), 'label_jobs_terminal'),
      'workflow_run_step_id', p_workflow_run_step_id,
      'external_step_result', false
    ),
    v_budget_ms,
    1
  );
END;
$$;

COMMENT ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text)
  IS 'Advance only the exact label-job-owning workflow step after all of its jobs are terminal; replay never advances a downstream step.';

REVOKE ALL ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text) TO edge_label_renderer_role;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('20260920004000_label_job_nudge_exact_step_v1'));
COMMIT;
