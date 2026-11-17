-- Migration: label print prepare v3 low-latency polling + async invoke default
-- Purpose:
--  - Keep print flow on-demand while reducing pending recheck latency.
--  - Remove long next_run_at floor inherited from v1 by enforcing policy/step-driven low-latency scheduling.
--  - Keep renderer invocation row-driven via label_print_policy (default enabled).

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_prepare_v3(
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
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_org_id UUID := NULL;
  v_step_poll_seconds INT := NULL;
  v_policy_poll_seconds INT := NULL;
  v_poll_seconds INT := 1;
BEGIN
  v_response := workflow_handlers.execute_label_print_prepare_v2(
    p_step,
    p_run,
    p_operation_result
  );

  IF v_response.status IS DISTINCT FROM 'pending' THEN
    RETURN v_response;
  END IF;

  v_org_id := NULLIF(v_response.context_patch->'label_print'->>'organization_id', '')::uuid;

  v_policy := COALESCE(
    CASE
      WHEN v_org_id IS NOT NULL THEN resolve_settings('label_print_policy', 'tenant', v_org_id)
      ELSE NULL
    END,
    resolve_settings('label_print_policy', 'global', NULL),
    '{}'::jsonb
  );

  v_step_poll_seconds := NULLIF(v_metadata->>'poll_interval_seconds', '')::INT;
  v_policy_poll_seconds := NULLIF(v_policy->>'poll_interval_seconds', '')::INT;

  v_poll_seconds := LEAST(
    COALESCE(v_step_poll_seconds, 60),
    COALESCE(v_policy_poll_seconds, 60)
  );
  v_poll_seconds := LEAST(GREATEST(v_poll_seconds, 1), 300);

  v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
  RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v3(workflow_run_steps, workflow_runs, JSONB)
  IS 'Prepare labels for bundling (v3): uses v2 async invoke path, then enforces low-latency next_run_at from policy/step poll interval.';

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
  'execute_label_print_prepare_v3',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v3',
  TRUE,
  'Prepare labels for bundling (v3): async invoke + low-latency next_run_at scheduling.',
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
SET handler_version = 'v3',
    metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{poll_interval_seconds}',
      to_jsonb(1),
      true
    ),
    updated_at = now()
WHERE workflow_template_id = (
    SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' LIMIT 1
  )
  AND handler_key = 'label_print_prepare';

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
      jsonb_set(
        sv.value,
        '{render_invoke_enabled}',
        to_jsonb(true),
        true
      ),
      '{poll_interval_seconds}',
      to_jsonb(1),
      true
    ),
    change_reason = 'Enable async label renderer invoke by default and lower poll interval to 1s for print prepare v3',
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
SELECT 'label_print_prepare v3 low-latency policy applied' AS status;

COMMIT;
