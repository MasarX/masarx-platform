-- Preserve one intake follow-up and one actual HTTP emission across engine progress.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, extensions, pg_temp;
DO $repair$
DECLARE
  v_def text;
  v_old text := $old$
      UPDATE workflow_runs
         SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('started_by_run_id', v_workflow_run_id))
       WHERE id = v_followup_run_id;
$old$;
  v_new text := $new$
      UPDATE workflow_runs
         SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('started_by_run_id', v_workflow_run_id))
       WHERE id = v_followup_run_id;

      -- Publish the actual child before the entry can be progressed by another transaction.
      UPDATE public.workflow_runs
         SET context = COALESCE(context, '{}'::jsonb)
               || jsonb_build_object('followup_workflow_run_id', v_followup_run_id),
             updated_at = now()
       WHERE id = v_workflow_run_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Webhook entry lineage missing';
      END IF;
      PERFORM public.log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'webhook_processing',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := 'followup_link',
        p_decision_outcome := 'workflow_enqueued',
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_build_object(
          'workflow_run_id', v_workflow_run_id,
          'workflow_template_id', v_entry_template_id,
          'followup_template_id', v_template_id,
          'followup_workflow_run_id', v_followup_run_id),
        p_decision_reason := NULL);
$new$;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure) INTO v_def;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'Unexpected webhook core follow-up definition shape';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END;
$repair$;

DO $repair$
DECLARE
  v_def text;
  v_old text := $old$
    -- Backward compatibility: derive webhook_source_id when it is not present in workflow context.
$old$;
  v_new text := $new$
    -- The synchronous intake has already returned this exact response. The entry
    -- still progresses normally, but must not invent a second wire emission.
    DECLARE
      v_emitted public.decision_log%ROWTYPE;
      v_inbox public.webhook_inbox%ROWTYPE;
      v_owned_run public.workflow_runs%ROWTYPE;
      v_matches integer;
    BEGIN
      -- Validate persisted identities before either reuse or the legacy writer.
      SELECT * INTO v_owned_run FROM public.workflow_runs WHERE id = p_run.id FOR UPDATE;
      SELECT * INTO v_inbox FROM public.webhook_inbox WHERE id = v_webhook_id FOR UPDATE;
      IF v_owned_run.id IS NULL OR v_organization_id IS NULL OR v_correlation_id IS NULL
         OR v_owned_run.context->>'webhook_id' IS DISTINCT FROM v_webhook_id::text
         OR v_owned_run.context->>'organization_id' IS DISTINCT FROM v_organization_id::text
         OR v_owned_run.context->>'correlation_id' IS DISTINCT FROM v_correlation_id::text
         OR NOT EXISTS (SELECT 1 FROM public.workflow_run_steps s
             JOIN public.operation_handlers h ON h.handler_key=s.handler_key
             WHERE s.id = p_step.id AND s.workflow_run_id = p_run.id
               AND s.workflow_template_step_id = p_step.workflow_template_step_id
               AND s.handler_key = p_step.handler_key
               AND h.handler_schema='workflow_handlers'
               AND h.handler_name='persist_http_response_v1' AND h.is_active)
         OR (v_inbox.id IS NOT NULL AND (
              v_inbox.organization_id IS DISTINCT FROM v_organization_id
              OR v_inbox.correlation_id IS DISTINCT FROM v_correlation_id
              OR (v_inbox.workflow_run_id IS NOT NULL AND v_inbox.workflow_run_id IS DISTINCT FROM p_run.id)
              OR (v_source_id IS NOT NULL AND v_source_id IS DISTINCT FROM v_inbox.webhook_source_id)))
      THEN
        RAISE EXCEPTION 'Webhook response ownership mismatch' USING ERRCODE = '42501';
      END IF;
      SELECT count(*) INTO v_matches FROM public.decision_log d
       WHERE d.resource_type = 'webhook_inbox' AND d.resource_id = v_webhook_id
         AND d.decision_category = 'http_response_emitted'
         AND d.performed_by_system = 'workflow_intake_webhook'
         AND d.decision_outcome = 'response_sent';
      IF v_matches > 0 THEN
        IF v_matches <> 1 THEN
          RAISE EXCEPTION 'Ambiguous webhook response ownership' USING ERRCODE = '42501';
        END IF;
        SELECT * INTO STRICT v_emitted FROM public.decision_log d
         WHERE d.resource_type = 'webhook_inbox' AND d.resource_id = v_webhook_id
           AND d.decision_category = 'http_response_emitted'
           AND d.performed_by_system = 'workflow_intake_webhook'
           AND d.decision_outcome = 'response_sent';
        IF v_owned_run.id IS NULL OR v_inbox.id IS NULL
           OR v_inbox.workflow_run_id IS DISTINCT FROM p_run.id
           OR v_emitted.decision_inputs->>'workflow_run_id' IS DISTINCT FROM p_run.id::text
           OR v_organization_id IS NULL OR v_correlation_id IS NULL
           OR v_inbox.organization_id IS DISTINCT FROM v_organization_id
           OR v_inbox.correlation_id IS DISTINCT FROM v_correlation_id
           OR v_emitted.organization_id IS DISTINCT FROM v_organization_id
           OR v_emitted.correlation_id IS DISTINCT FROM v_correlation_id
        THEN
          RAISE EXCEPTION 'Webhook response ownership mismatch' USING ERRCODE = '42501';
        END IF;
        v_response_projection := jsonb_strip_nulls(jsonb_build_object(
          'status', v_emitted.decision_inputs->'status',
          'headers', v_emitted.decision_inputs->'headers',
          'body', v_emitted.decision_inputs->'body',
          'mode', v_emitted.decision_inputs->'mode',
          'outcome', v_emitted.decision_outcome,
          'reason', v_emitted.decision_reason,
          'sent_at', v_emitted.timestamp));
        v_result.status := 'completed';
        v_result.operation_result := v_response_projection;
        v_result.context_patch := jsonb_strip_nulls(jsonb_build_object(
          'http_response', v_response_projection,
          'followup_workflow_run_id', v_owned_run.context->'followup_workflow_run_id',
          'webhook_source_id', v_inbox.webhook_source_id,
          'source_identifier', v_source_identifier));
        RETURN v_result;
      END IF;
    END;

    -- Backward compatibility: derive webhook_source_id when it is not present in workflow context.
$new$;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.persist_http_response_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure) INTO v_def;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'Unexpected HTTP persistence definition shape';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END;
$repair$;
COMMIT;
