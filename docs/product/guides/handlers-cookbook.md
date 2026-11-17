# Workflow Handlers Cookbook

Purpose
- Provide ready-to-use patterns for implementing workflow handlers under the `workflow_handlers` schema.

Contract
- Signature: `(workflow_run_steps, workflow_runs, jsonb) -> workflow_handler_response`.
- Must log decisions via `log_decision`.
- Idempotence: design handlers to be safe on retry; use `workflow_run_steps.retry_attempt` when helpful.
- Context best practices: lift IDs from `p_run.context` and nested `context.payload` when present; persist newly created resource IDs into `p_run.context` via the engine (by returning them in `operation_result`).
- Scheduling semantics: the engine is strictly sequence-ordered. Only the earliest pending step is eligible to run; later pending steps must never overtake it because of `run_at`.
- Explicit wake semantics: a non-empty `p_operation_result` is treated as interactive input for the earliest pending step and may wake it immediately even when its `run_at` is still in the future.
- Entry-point contract: `public.progress_workflow_run` is the canonical dispatcher; engine migrations must keep that wrapper aligned with `progress_workflow_run_base` so the in-progress guard, pending-step reopen logic, and sequence-order semantics stay live.

Templates
- Outbound HTTP: see `workflow_handlers.execute_outbound_http_v1` (enqueue `outbound_calls`, record call specs via `operation_templates` + `mapping_configs`).
- Label Job: see `workflow_handlers.execute_label_job_v1` (enqueue job, poll, record decisions).
- Manual Review (skeleton): enqueue/assign review tasks, record decisions (`manual_review.enqueue_task`, `manual_review.assigned`, `manual_review.resolved`).
- Context Guards (generic, row-driven):
  - `context_set_defaults` (`workflow_handlers.execute_context_set_defaults_v1`): apply step `metadata.defaults` into run context (non-stomping by default).
  - `context_require` (`workflow_handlers.execute_context_require_v1`): require context keys/paths; on missing either fail or early-complete workflow (via `metadata.on_missing`).

Context Guards (examples)
- `context_set_defaults` step metadata:
```
jsonb_build_object(
  'mode', 'set_if_missing', -- or 'overwrite'
  'defaults', jsonb_build_object(
    'service_type', 'rto',
    'service_level', 'standard'
  )
)
```
- `context_require` step metadata:
```
jsonb_build_object(
  'required', jsonb_build_array('client_id', 'shipment_id'),
  'on_missing', 'complete_workflow' -- or 'fail_workflow'
)
```
- JSONPath requirements are supported when the item starts with `$` and are evaluated against:
  - `$.context` (the workflow run context)
  - `$.operation_result` (the prior step operation_result)

Manual Review Enqueue (context lifting)
```
-- See migration 202511231215_manual_review_context_fix.sql for full source
DECLARE
  v_ctx JSONB := COALESCE(p_run.context,'{}'::jsonb);
  v_payload JSONB := CASE WHEN jsonb_typeof(v_ctx->'payload')='object' THEN v_ctx->'payload' ELSE '{}'::jsonb END;
  v_org UUID := COALESCE(NULLIF(v_ctx->>'organization_id','')::uuid, NULLIF(v_payload->>'organization_id','')::uuid);
  v_client UUID := COALESCE(NULLIF(v_ctx->>'client_id','')::uuid, NULLIF(v_payload->>'client_id','')::uuid);
  v_shipment UUID := COALESCE(NULLIF(v_ctx->>'shipment_id','')::uuid,
                              CASE WHEN v_payload->>'resource_type'='shipment' THEN NULLIF(v_payload->>'resource_id','')::uuid END,
                              NULLIF(v_payload->>'shipment_id','')::uuid);
  v_task_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO manual_review_tasks(id, organization_id, client_id, shipment_id, task_type, status, metadata)
  VALUES (v_task_id, v_org, v_client, v_shipment, 'geocoding', 'pending', jsonb_build_object('workflow_run_id', p_run.id, 'step_id', p_step.id));
  PERFORM log_decision(v_org,'manual_review','manual_review_task',v_task_id,'enqueue_task','created','workflow_engine',NULL,jsonb_build_object('task_type','geocoding'),NULL);
  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id);
  RETURN v_resp;
END;
```

Assign/Resolve (robust id passing)
```
v_task_id_text := COALESCE(
  p_operation_result->>'manual_review_task_id',
  p_step.operation_result->>'manual_review_task_id',
  p_run.context->>'manual_review_task_id'
);
IF v_task_id_text IS NULL OR btrim(v_task_id_text)='' THEN RAISE EXCEPTION 'manual_review_assign/resolve: manual_review_task_id missing'; END IF;
v_task_id := v_task_id_text::uuid;
```

Webhook Intake (dynamic responses)
- Resolve policy + defaults and set the response status at the start of evaluation; HMAC failures become synchronous failures with `bad_request_status`. See migration `202511231205_webhook_intake_dynamic_defaults.sql` for reference.

Decision Logging Cheat Sheet
```
PERFORM log_decision(
  p_organization_id := org_id,
  p_decision_category := 'your_category',
  p_resource_type := 'your_resource',
  p_resource_id := resource_id,
  p_decision_point := 'step_name',
  p_decision_outcome := 'succeeded' -- or failed/retry_scheduled/etc,
  p_performed_by_system := 'workflow_engine',
  p_correlation_id := NULL,
  p_decision_inputs := jsonb_build_object('input_key', 'value'),
  p_decision_reason := NULL
);
```

Testing Tips
- pgTAP: validate handler registration exists in `operation_handlers` (and doc_url set).
- Integration: start a workflow run referencing the handler; assert downstream effects and decision rows exist.
