-- Console V2 webhook shipment-create terminal retry guard.
--
-- Shipment-creating webhooks that already failed because required shipment
-- materialization data is missing must not be silently reopened by duplicate
-- idempotency replay, operator replay, response persistence, or the ops
-- maintenance retry worker. A pending row without shipment readback looks
-- actionable in Console even though no real shipment can exist.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605110445_webhook_shipment_create_terminal_retry_guard_v1'));

SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.webhook_inbox_is_terminal_shipment_create_failure_v1(
  p_webhook_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.webhook_inbox wi
      LEFT JOIN public.v_webhook_inbox_directory wid ON wid.id = wi.id
     WHERE wi.id = p_webhook_id
       AND wi.processing_status IN ('failed', 'dead_letter')
       AND wid.shipment_id IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.shipments s
          WHERE s.metadata->>'source_webhook_id' = wi.id::TEXT
             OR s.metadata#>>'{webhook,id}' = wi.id::TEXT
             OR s.metadata#>>'{source,webhook_id}' = wi.id::TEXT
       )
       AND lower(btrim(COALESCE(
             NULLIF(wid.mapping_target, ''),
             NULLIF(wid.canonical_intent, ''),
             NULLIF(wi.event_type, ''),
             NULLIF(wi.raw_payload->>'event_type', ''),
             NULLIF(wi.transformed_payload->>'event_type', ''),
             ''
           ))) IN ('shipment.create', 'shipments.create', 'shipment.created')
       AND (
         wi.error_message ILIKE '%missing required webhook shipment recipient/address%'
         OR wi.error_message ILIKE '%missing required context%'
         OR wi.error_message ILIKE '%did not enqueue shipment materialization workflow%'
         OR EXISTS (
           SELECT 1
             FROM public.workflow_run_steps wrs
            WHERE wrs.handler_key = 'shipment_create'
              AND wrs.step_status = 'failed'
              AND wrs.operation_result->>'webhook_id' = wi.id::TEXT
         )
       )
  );
$$;

COMMENT ON FUNCTION public.webhook_inbox_is_terminal_shipment_create_failure_v1(UUID)
  IS 'Returns true when a shipment-creating webhook failed terminally with no canonical shipment readback, so retry/replay paths must preserve failure truth instead of reopening pending work.';

CREATE OR REPLACE FUNCTION public.preserve_terminal_webhook_shipment_failure_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.processing_status IN ('failed', 'dead_letter')
     AND public.webhook_inbox_is_terminal_shipment_create_failure_v1(OLD.id)
     AND (
       NEW.processing_status IS DISTINCT FROM OLD.processing_status
       OR NEW.error_message IS DISTINCT FROM OLD.error_message
       OR NEW.processed_at IS DISTINCT FROM OLD.processed_at
     ) THEN
    NEW.processing_status := OLD.processing_status;
    NEW.error_message := OLD.error_message;
    NEW.processed_at := OLD.processed_at;
    NEW.lease_expires_at := NULL;
    NEW.retry_count := OLD.retry_count;
    NEW.max_retries := OLD.max_retries;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webhook_inbox_preserve_terminal_shipment_failure
  ON public.webhook_inbox;

CREATE TRIGGER webhook_inbox_preserve_terminal_shipment_failure
BEFORE UPDATE OF processing_status, error_message, processed_at, lease_expires_at, retry_count, max_retries
ON public.webhook_inbox
FOR EACH ROW
EXECUTE FUNCTION public.preserve_terminal_webhook_shipment_failure_v1();

COMMENT ON FUNCTION public.preserve_terminal_webhook_shipment_failure_v1()
  IS 'Fail-closed guard: terminal shipment-create webhook failures without shipment readback cannot be downgraded back to pending/in_progress or have their error cleared by replay/retry paths.';

CREATE OR REPLACE FUNCTION public.webhook_inbox_replay_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_uuid UUID := gen_random_uuid();
  v_correlation_id TEXT := v_correlation_uuid::TEXT;
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'webhook_inbox_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_before public.webhook_inbox%ROWTYPE;
  v_source_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'webhook_inbox_replay_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'webhook_inbox_replay_v1 requires webhook_inbox_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.webhook_inbox WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'webhook_inbox_replay_v1 webhook_inbox % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  SELECT organization_id INTO v_source_org
    FROM public.webhook_sources WHERE id = v_before.webhook_source_id;
  IF v_org_id IS NOT NULL
     AND v_source_org IS NOT NULL
     AND v_source_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'webhook_inbox_replay_v1 webhook_inbox % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  IF public.webhook_inbox_is_terminal_shipment_create_failure_v1(v_resource_id) THEN
    INSERT INTO public.webhook_inbox_replays (
      webhook_inbox_id, organization_id, webhook_source_id, action,
      prior_status, forced_status, reason, changed_by, correlation_id, decision_log_id
    ) VALUES (
      v_resource_id, v_source_org, v_before.webhook_source_id, 'replay',
      v_before.processing_status, v_before.processing_status,
      COALESCE(v_reason, 'non_retryable_shipment_create_failure'),
      v_user_id, v_correlation_id, v_decision_id
    );

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, decision_inputs, decision_reason,
      performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, COALESCE(v_source_org, '00000000-0000-0000-0000-000000000000'::uuid),
      'webhooks.replay', 'webhook_inbox', v_resource_id,
      'webhook_inbox_replay_v1', 'blocked',
      jsonb_strip_nulls(jsonb_build_object(
        'prior_status', v_before.processing_status,
        'preserved_status', v_before.processing_status,
        'reason', 'non_retryable_shipment_create_failure',
        'operator_reason', v_reason
      )),
      'Replay blocked because shipment-create failure is terminal without shipment readback.',
      'webhook_inbox_replay_v1', v_correlation_uuid
    );

    RETURN jsonb_build_object(
      'ok', true,
      'status', 'preserved_terminal_failure',
      'replay_queued', false,
      'webhook_inbox_id', v_resource_id,
      'prior_status', v_before.processing_status,
      'preserved_status', v_before.processing_status,
      'reason', 'non_retryable_shipment_create_failure',
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id
    );
  END IF;

  UPDATE public.webhook_inbox
     SET processing_status = 'pending',
         processed_at = NULL,
         error_message = NULL,
         lease_expires_at = NULL
   WHERE id = v_resource_id;

  INSERT INTO public.webhook_inbox_replays (
    webhook_inbox_id, organization_id, webhook_source_id, action,
    prior_status, forced_status, reason, changed_by, correlation_id, decision_log_id
  ) VALUES (
    v_resource_id, v_source_org, v_before.webhook_source_id, 'replay',
    v_before.processing_status, NULL, v_reason, v_user_id, v_correlation_id, v_decision_id
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_source_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'webhooks.replay', 'webhook_inbox', v_resource_id,
    'webhook_inbox_replay_v1', 'replay_queued',
    jsonb_strip_nulls(jsonb_build_object(
      'prior_status', v_before.processing_status,
      'reason', v_reason
    )),
    'webhook_inbox_replay_v1', v_correlation_uuid
  );

  IF v_source_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_source_org, 'webhook_inbox.replay_requested', 'webhook_inbox', v_resource_id,
      jsonb_strip_nulls(jsonb_build_object('prior_status', v_before.processing_status, 'reason', v_reason)),
      v_correlation_uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'replay_queued',
    'replay_queued', true,
    'webhook_inbox_id', v_resource_id,
    'prior_status', v_before.processing_status,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.webhook_inbox_replay_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_replay_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_replay_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.webhook_inbox_replay_v1(jsonb)
  IS 'Canonical write RPC: requeue retryable webhook_inbox rows or preserve terminal shipment-create failure truth with replay audit. Capability: webhooks.write.';

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(
  p_token text,
  p_headers jsonb,
  p_raw_body text,
  p_payload jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_result JSONB;
  v_followup_run_id UUID := NULL;
  v_source_id UUID := NULL;
  v_policy_row RECORD;
  v_policy_body JSONB := '{}'::jsonb;
  v_launch_mode TEXT := 'in_background';
  v_response_correlation_id TEXT := NULL;
  v_replayed_webhook_id UUID := NULL;
  v_original_workflow_run_id UUID := NULL;
BEGIN
  v_result := public.workflow_intake_webhook_core_v1(
    p_token,
    p_headers,
    p_raw_body,
    p_payload
  );

  IF NULLIF(v_result->>'workflow_run_id', '') IS NULL
     AND COALESCE(v_result->>'ack_outcome', '') = 'ack_replayed'
     AND COALESCE(v_result->>'webhook_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_replayed_webhook_id := (v_result->>'webhook_id')::UUID;

    SELECT wi.workflow_run_id
      INTO v_original_workflow_run_id
      FROM public.webhook_inbox wi
     WHERE wi.id = v_replayed_webhook_id;

    IF v_original_workflow_run_id IS NOT NULL THEN
      v_result := jsonb_set(
        v_result,
        '{workflow_run_id}',
        to_jsonb(v_original_workflow_run_id::TEXT),
        TRUE
      );
    END IF;
  END IF;

  BEGIN
    v_followup_run_id := NULLIF(v_result->>'followup_workflow_run_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_followup_run_id := NULL;
  END;

  IF v_followup_run_id IS NOT NULL THEN
    SELECT id
      INTO v_source_id
      FROM public.get_webhook_source_by_token(p_token)
      LIMIT 1;
  END IF;

  IF v_followup_run_id IS NOT NULL AND v_source_id IS NOT NULL THEN
    BEGIN
      SELECT *
        INTO v_policy_row
        FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_source_id)
       LIMIT 1;

      v_policy_body := COALESCE(v_policy_row.policy, '{}'::jsonb);
      v_launch_mode := COALESCE(
        NULLIF(v_policy_body#>>'{workflow,launch_mode}', ''),
        'in_background'
      );

      IF v_launch_mode = 'sync_only' THEN
        IF EXISTS (
          SELECT 1
          FROM public.workflow_run_steps wrs
          WHERE wrs.workflow_run_id = v_followup_run_id
            AND wrs.step_status = 'pending'
            AND COALESCE(wrs.run_at, now()) <= now()
        ) THEN
          PERFORM public.progress_workflow_run(v_followup_run_id);
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM public.workflow_run_steps wrs
          WHERE wrs.workflow_run_id = v_followup_run_id
            AND wrs.step_status = 'pending'
        ) THEN
          PERFORM public.progress_workflow_run(v_followup_run_id);
        END IF;

        v_result := jsonb_set(v_result, '{followup_sync}', to_jsonb(TRUE), TRUE);
      END IF;
    EXCEPTION
      WHEN others THEN
        v_result := jsonb_set(v_result, '{followup_sync_error}', to_jsonb(SQLERRM), TRUE);
    END;
  END IF;

  v_response_correlation_id := COALESCE(
    NULLIF(v_result->>'correlation_id', ''),
    NULLIF(v_result->'body'->>'correlation_id', ''),
    NULLIF(v_result->'body'->'webhook'->>'correlation_id', '')
  );
  IF v_response_correlation_id IS NOT NULL THEN
    v_result := jsonb_set(v_result, '{correlation_id}', to_jsonb(v_response_correlation_id), TRUE);
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.workflow_intake_webhook(text, jsonb, text, jsonb)
  IS 'Public webhook intake wrapper: preserves original workflow_run_id in idempotency replay responses and optionally progresses sync follow-up workflows.';

DO $patch_ops_maintenance$
DECLARE
  v_def TEXT;
  v_marker TEXT := E'      IF v_quarantine_after_minutes IS NOT NULL AND v_age_minutes >= v_quarantine_after_minutes THEN\n';
  v_insert TEXT;
BEGIN
  SELECT pg_get_functiondef('public.ops_maintenance_retry_webhook_inbox(jsonb)'::regprocedure)
    INTO v_def;

  IF position('non_retryable_shipment_create_failure' IN v_def) = 0 THEN
    v_insert := E'      IF public.webhook_inbox_is_terminal_shipment_create_failure_v1(v_row.id) THEN\n'
      || E'        PERFORM public.enqueue_ops_quarantine(\n'
      || E'          p_organization_id := v_row.organization_id,\n'
      || E'          p_resource_type := ''webhook_inbox'',\n'
      || E'          p_resource_id := v_row.id,\n'
      || E'          p_reason := ''non_retryable_shipment_create_failure'',\n'
      || E'          p_next_action := COALESCE(v_next_action, ''inspect_webhook_payload''),\n'
      || E'          p_details := jsonb_strip_nulls(jsonb_build_object(\n'
      || E'            ''status'', v_row.processing_status,\n'
      || E'            ''retry_count'', v_row.retry_count,\n'
      || E'            ''max_retries'', v_max_retries,\n'
      || E'            ''error_message'', v_row.error_message,\n'
      || E'            ''task_key'', v_task_key,\n'
      || E'            ''reason'', ''non_retryable_shipment_create_failure''\n'
      || E'          )),\n'
      || E'          p_settings_resolution_id := v_settings_resolution_id\n'
      || E'        );\n\n'
      || E'        PERFORM public.log_decision(\n'
      || E'          p_organization_id := v_row.organization_id,\n'
      || E'          p_decision_category := ''ops_maintenance'',\n'
      || E'          p_resource_type := ''webhook_inbox'',\n'
      || E'          p_resource_id := v_row.id,\n'
      || E'          p_decision_point := COALESCE(v_task_key, ''retry_webhook_inbox''),\n'
      || E'          p_decision_outcome := ''quarantined'',\n'
      || E'          p_performed_by_system := ''ops_maintenance_worker'',\n'
      || E'          p_correlation_id := v_row.correlation_id,\n'
      || E'          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(\n'
      || E'            ''reason'', ''non_retryable_shipment_create_failure'',\n'
      || E'            ''retry_count'', v_row.retry_count,\n'
      || E'            ''max_retries'', v_max_retries\n'
      || E'          )),\n'
      || E'          p_decision_reason := ''Shipment-create webhook failure has no shipment readback and is not retryable by maintenance.'',\n'
      || E'          p_settings_resolution_id := v_settings_resolution_id\n'
      || E'        );\n\n'
      || E'        v_quarantined := v_quarantined + 1;\n'
      || E'        CONTINUE;\n'
      || E'      END IF;\n\n';

    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'ops maintenance webhook retry insertion point not found';
    END IF;

    v_def := replace(v_def, v_marker, v_insert || v_marker);
    EXECUTE v_def;
  END IF;
END;
$patch_ops_maintenance$;

WITH shipment_create_failures AS (
  SELECT DISTINCT ON (webhook_id)
         webhook_id,
         error_message
    FROM (
      SELECT (wrs.operation_result->>'webhook_id')::UUID AS webhook_id,
             COALESCE(
               NULLIF(wrs.last_error, ''),
               NULLIF(wrs.operation_result->>'error', ''),
               'shipment_create workflow step failed'
             ) AS error_message,
             wrs.updated_at,
             wrs.created_at
        FROM public.workflow_run_steps wrs
       WHERE wrs.handler_key = 'shipment_create'
         AND wrs.step_status = 'failed'
         AND COALESCE(wrs.operation_result->>'webhook_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      UNION ALL
      SELECT dl.resource_id AS webhook_id,
             COALESCE(NULLIF(dl.decision_reason, ''), 'shipment-create webhook failed without shipment readback') AS error_message,
             dl.created_at AS updated_at,
             dl.created_at
        FROM public.decision_log dl
       WHERE dl.resource_type = 'webhook_inbox'
         AND dl.decision_category = 'webhook_processing'
         AND dl.decision_outcome = 'failed'
         AND dl.decision_point IN ('shipment_create_payload', 'shipment_create_context', 'shipment_create_followup')
    ) evidence
   ORDER BY webhook_id, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
)
UPDATE public.webhook_inbox wi
   SET processing_status = 'failed',
       processed_at = COALESCE(wi.processed_at, now()),
       error_message = COALESCE(shipment_create_failures.error_message, wi.error_message),
       updated_at = now()
  FROM shipment_create_failures
  LEFT JOIN public.v_webhook_inbox_directory wid ON wid.id = shipment_create_failures.webhook_id
 WHERE wi.id = shipment_create_failures.webhook_id
   AND wi.processing_status NOT IN ('succeeded', 'processed', 'failed', 'dead_letter')
   AND wid.shipment_id IS NULL
   AND lower(btrim(COALESCE(
         NULLIF(wid.mapping_target, ''),
         NULLIF(wid.canonical_intent, ''),
         NULLIF(wi.event_type, ''),
         NULLIF(wi.raw_payload->>'event_type', ''),
         NULLIF(wi.transformed_payload->>'event_type', ''),
         ''
       ))) IN ('shipment.create', 'shipments.create', 'shipment.created');

SELECT pg_advisory_unlock(hashtext('202605110445_webhook_shipment_create_terminal_retry_guard_v1'));

COMMIT;
