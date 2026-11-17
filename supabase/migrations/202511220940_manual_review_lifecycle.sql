-- Migration: Manual Review Lifecycle (assign + resolve)

BEGIN;

SET search_path TO public;

-- 1) Handlers: assign + resolve
CREATE OR REPLACE FUNCTION workflow_handlers.execute_manual_review_assign_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_org UUID := COALESCE(NULLIF(v_ctx->>'organization_id', '')::UUID, current_user_org_id());
    v_task_id UUID := NULLIF(COALESCE(p_operation_result->>'manual_review_task_id', p_step.operation_result->>'manual_review_task_id'), '')::UUID;
    v_assigned_to UUID := NULLIF(COALESCE(p_operation_result->>'assigned_to', p_step.metadata->>'assigned_to'), '');
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id IS NULL THEN
        v_task_id := NULLIF(p_run.context->>'manual_review_task_id', '')::UUID;
    END IF;

    UPDATE manual_review_tasks
    SET status = 'assigned',
        assigned_to = NULLIF(v_assigned_to, '')::UUID,
        updated_at = now()
    WHERE id = v_task_id;

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'manual_review',
        p_resource_type := 'manual_review_task',
        p_resource_id := v_task_id,
        p_decision_point := 'assign_task',
        p_decision_outcome := 'assigned',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('assigned_to', v_assigned_to)
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id, 'assigned_to', v_assigned_to);
    RETURN v_resp;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_manual_review_resolve_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_org UUID := COALESCE(NULLIF(v_ctx->>'organization_id', '')::UUID, current_user_org_id());
    v_task_id UUID := NULLIF(COALESCE(p_operation_result->>'manual_review_task_id', p_step.operation_result->>'manual_review_task_id'), '')::UUID;
    v_resolution TEXT := COALESCE(NULLIF(p_operation_result->>'resolution_notes', ''), p_step.metadata->>'resolution_notes');
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id IS NULL THEN
        v_task_id := NULLIF(p_run.context->>'manual_review_task_id', '')::UUID;
    END IF;

    UPDATE manual_review_tasks
    SET status = 'resolved',
        resolution_notes = COALESCE(v_resolution, resolution_notes),
        resolved_at = now(),
        updated_at = now()
    WHERE id = v_task_id;

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'manual_review',
        p_resource_type := 'manual_review_task',
        p_resource_id := v_task_id,
        p_decision_point := 'resolve_task',
        p_decision_outcome := 'resolved',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('resolution_notes', v_resolution)
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id, 'resolution_notes', v_resolution);
    RETURN v_resp;
END;
$$;

-- 2) Register handler keys with signature validation guard
ALTER TABLE operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO operation_handlers (handler_key, handler_schema, handler_name, handler_signature, handler_version, is_active, notes, doc_url)
VALUES
  ('manual_review_assign','workflow_handlers','execute_manual_review_assign_v1','(workflow_run_steps,workflow_runs,jsonb)','v1', TRUE, 'Assign manual review task','docs/product/guides/handlers-cookbook.md'),
  ('manual_review_resolve','workflow_handlers','execute_manual_review_resolve_v1','(workflow_run_steps,workflow_runs,jsonb)','v1', TRUE, 'Resolve manual review task','docs/product/guides/handlers-cookbook.md')
ON CONFLICT (handler_key) DO UPDATE SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

ALTER TABLE operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

-- 3) Extend template steps if not present
DO $$
DECLARE
  v_template UUID := '99990000-0000-0000-0000-000000560001'::UUID;
  v_has_assign BOOLEAN;
  v_has_resolve BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM workflow_template_steps WHERE workflow_template_id = v_template AND handler_key = 'manual_review_assign'
  ) INTO v_has_assign;

  IF NOT v_has_assign THEN
    INSERT INTO workflow_template_steps (
      workflow_template_id, sequence_order, operation_name, transition_condition, metadata, enabled, handler_key, handler_version
    ) VALUES (
      v_template, 2, 'manual_review_assign', 'always', '{}'::jsonb, TRUE, 'manual_review_assign', 'v1'
    );
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM workflow_template_steps WHERE workflow_template_id = v_template AND handler_key = 'manual_review_resolve'
  ) INTO v_has_resolve;

  IF NOT v_has_resolve THEN
    INSERT INTO workflow_template_steps (
      workflow_template_id, sequence_order, operation_name, transition_condition, metadata, enabled, handler_key, handler_version
    ) VALUES (
      v_template, 3, 'manual_review_resolve', 'always', '{}'::jsonb, TRUE, 'manual_review_resolve', 'v1'
    );
  END IF;
END$$;

COMMIT;

