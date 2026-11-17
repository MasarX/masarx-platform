-- Migration: Dialog360 reply workflow pipeline (remove trigger, configure source policy, add workflow handler)
-- Purpose:
--   - Eliminate trigger-driven side effects for inbound replies (no DB trigger auto-processing).
--   - Process inbound Dialog360 replies via workflow intake + a dedicated workflow template/handler.
--   - Ensure webhook_ingest_policy is correctly scoped at scope_type='source' for dialog360_reply.
-- Date: 2025-12-14

BEGIN;

-- ----------------------------------------------------------------------------
-- Operation handler: comms_reply (workflow_handlers.execute_comms_reply_v1)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_comms_reply_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_response public.workflow_handler_response;
  v_webhook_id UUID;
  v_webhook RECORD;
  v_source RECORD;
  v_transformed JSONB;
  v_comm JSONB;
  v_reply_result JSONB;
  v_mark_result JSONB;
  v_org_id UUID;
  v_client_id UUID;
  v_stop_workflow BOOLEAN := FALSE;
  v_stop_reason TEXT := 'reply_received';
BEGIN
  BEGIN
    v_webhook_id := NULLIF(p_run.context->>'webhook_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_webhook_id := NULL;
  END;

  IF v_webhook_id IS NULL THEN
    v_response.status := 'failed';
    v_response.last_error := 'missing_webhook_id';
    v_response.operation_result := jsonb_build_object('error', 'missing_webhook_id');
    RETURN v_response;
  END IF;

  SELECT wi.*
    INTO v_webhook
    FROM public.webhook_inbox wi
   WHERE wi.id = v_webhook_id;

  IF NOT FOUND THEN
    v_response.status := 'failed';
    v_response.last_error := 'webhook_not_found';
    v_response.operation_result := jsonb_build_object('error', 'webhook_not_found', 'webhook_id', v_webhook_id);
    RETURN v_response;
  END IF;

  SELECT ws.id,
         ws.organization_id,
         ws.mapping_config_id,
         ws.sender_id,
         s.client_id
    INTO v_source
    FROM public.webhook_sources ws
    LEFT JOIN public.senders s ON s.id = ws.sender_id
   WHERE ws.id = v_webhook.webhook_source_id;

  IF NOT FOUND THEN
    v_response.status := 'failed';
    v_response.last_error := 'webhook_source_not_found';
    v_response.operation_result := jsonb_build_object('error', 'webhook_source_not_found', 'webhook_source_id', v_webhook.webhook_source_id);
    RETURN v_response;
  END IF;

  v_org_id := COALESCE(
    NULLIF(p_run.context->>'organization_id', '')::UUID,
    v_source.organization_id
  );
  v_client_id := v_source.client_id;

  -- Map payload into a canonical communication object via mapping_configs (row-driven).
  v_transformed := public.apply_mapping_config(v_webhook.raw_payload, v_source.mapping_config_id);
  v_comm := COALESCE(v_transformed->'communication', '{}'::jsonb);

  -- Persist transformed payload for observability/troubleshooting.
  UPDATE public.webhook_inbox
     SET transformed_payload = COALESCE(v_transformed, '{}'::jsonb)
   WHERE id = v_webhook_id;

  -- Policy-driven automated reply (queues outbound_calls; no direct network calls).
  v_reply_result := public.send_comms_reply(
    v_webhook_id,
    v_source.id,
    v_comm,
    v_org_id
  );

  v_stop_workflow := COALESCE(NULLIF(v_reply_result->>'stop_workflow', '')::BOOLEAN, FALSE);
  IF COALESCE(NULLIF(v_reply_result->>'opt_out', '')::BOOLEAN, FALSE) THEN
    v_stop_reason := 'opt_out';
  END IF;

  -- Mark reply receipt on the related workflow run (scoped + policy-driven stop).
  v_mark_result := public.worker_action_mark_communication_reply(
    v_webhook_id,
    jsonb_strip_nulls(jsonb_build_object(
      'stop_reason', v_stop_reason,
      'stop_workflow', v_stop_workflow,
      'organization_id', v_org_id,
      'client_id', v_client_id
    )),
    jsonb_build_object('transformed_payload', jsonb_build_object('communication', v_comm))
  );

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'webhook_id', v_webhook_id,
    'reply', v_reply_result,
    'mark_reply', v_mark_result
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'comms_reply', v_reply_result
  ));
  RETURN v_response;
EXCEPTION
  WHEN others THEN
    v_response.status := 'failed';
    v_response.last_error := SQLERRM;
    v_response.operation_result := jsonb_build_object('error', SQLERRM);
    RETURN v_response;
END;
$$;

-- Register handler only after the function exists (operation_handlers has a strict validation trigger).
INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  created_by,
  notes,
  doc_url
)
VALUES (
  'comms_reply',
  'workflow_handlers',
  'execute_comms_reply_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  NULL,
  'Inbound comms reply handler: maps webhook payload, marks reply_received, and enqueues policy-driven replies.',
  'docs/ops/runbooks/communications-hardening.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-- ----------------------------------------------------------------------------
-- Workflow template: dialog360_reply_handler_v1
-- ----------------------------------------------------------------------------

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type,
  scope_id,
  notes
)
VALUES (
  '99990000-0000-0000-0000-000000340101',
  'dialog360_reply_handler_v1',
  'Process inbound Dialog360 WhatsApp replies (map + mark reply + send policy-driven response).',
  1,
  'active',
  'global',
  NULL,
  'Row-driven reply handler workflow (no triggers; queue-only outbound sends).'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = 'active',
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

INSERT INTO public.workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  operation_settings_category,
  transition_condition,
  condition_jsonlogic,
  next_operation_name,
  next_operation_priority,
  next_operation_delay_seconds,
  manual_action_required,
  metadata,
  handler_key,
  handler_version,
  enabled
)
VALUES (
  '99990000-0000-0000-0000-000000340102',
  (SELECT id FROM public.workflow_templates WHERE name = 'dialog360_reply_handler_v1' LIMIT 1),
  1,
  'comms_reply',
  'workflow',
  'always',
  NULL,
  NULL,
  NULL,
  NULL,
  FALSE,
  jsonb_build_object(
    'max_retries', 3
  ),
  'comms_reply',
  'v1',
  TRUE
)
ON CONFLICT (id) DO UPDATE
SET workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    operation_settings_category = EXCLUDED.operation_settings_category,
    transition_condition = EXCLUDED.transition_condition,
    condition_jsonlogic = EXCLUDED.condition_jsonlogic,
    next_operation_name = EXCLUDED.next_operation_name,
    next_operation_priority = EXCLUDED.next_operation_priority,
    next_operation_delay_seconds = EXCLUDED.next_operation_delay_seconds,
    manual_action_required = EXCLUDED.manual_action_required,
    metadata = EXCLUDED.metadata,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    enabled = EXCLUDED.enabled,
    updated_at = now();

-- ----------------------------------------------------------------------------
-- Webhook ingest policy: dialog360_reply must be source-scoped and point to reply workflow
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_source_id UUID;
  v_policy JSONB;
BEGIN
  SELECT id
    INTO v_source_id
    FROM public.webhook_sources
   WHERE source_identifier = 'dialog360_reply'
   LIMIT 1;

  IF v_source_id IS NULL THEN
    RAISE NOTICE 'Skipping dialog360_reply webhook_ingest_policy upsert (source missing)';
    RETURN;
  END IF;

  v_policy := jsonb_build_object(
    'version', 1,
    'wait_for_ack', FALSE,
    'schema', jsonb_build_object('version', 'v1', 'registry', 'schema_registry'),
    'ack', jsonb_build_object(
      'mode', 'synchronous_success',
      'status_code', 200,
      'default_headers', jsonb_build_object('content-type', 'application/json')
    ),
    'validation', jsonb_build_object(
      'idempotency', jsonb_build_object(
        'body_path', 'entry.0.changes.0.value.messages.0.id',
        'dedupe_window_seconds', 86400
      )
    ),
    'workflow', jsonb_build_object(
      'intent', 'comms_reply',
      'template_id', '99990000-0000-0000-0000-000000340101'
    ),
    'logging', jsonb_build_object(
      'decision_point', 'workflow_intake_ack',
      'include_payload', FALSE
    )
  );

  PERFORM public.upsert_webhook_ingest_policy('source', v_source_id, v_policy);
END $$;

-- ----------------------------------------------------------------------------
-- Remove legacy trigger-based auto handler (replies are workflow-driven)
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_dialog360_reply_autohandler ON public.webhook_inbox;
DROP FUNCTION IF EXISTS public.process_dialog360_reply();

COMMIT;
