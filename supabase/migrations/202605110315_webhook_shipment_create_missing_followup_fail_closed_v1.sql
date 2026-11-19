-- Console V2 webhook shipment-create missing follow-up fail-closed guard.
--
-- Live operator/auditor testing exposed a shipment-create webhook path where the
-- acknowledgement workflow completed, but dispatch_followup_workflow did not
-- enqueue the canonical shipment materialization workflow. That left the inbox
-- actionable/in_progress with no shipment. Shipment-creating webhooks must fail
-- terminally when the follow-up workflow is absent and no shipment readback
-- exists.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605110315_webhook_shipment_create_missing_followup_fail_closed_v1'));

SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.sync_webhook_inbox_from_missing_shipment_followup_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_run public.workflow_runs%ROWTYPE;
  v_webhook_id UUID;
  v_webhook_text TEXT;
  v_correlation_id UUID;
  v_correlation_text TEXT;
  v_organization_id UUID;
  v_organization_text TEXT;
  v_intent TEXT;
  v_error TEXT := 'webhook shipment.create did not enqueue shipment materialization workflow';
BEGIN
  IF NEW.handler_key IS DISTINCT FROM 'dispatch_followup_workflow'
     OR NEW.step_status IS DISTINCT FROM 'completed'
     OR COALESCE(NEW.operation_result->>'workflow_enqueued', '') IS DISTINCT FROM 'false'
     OR COALESCE(NEW.operation_result->>'skipped', '') = 'followup_already_started'
     OR NULLIF(NEW.operation_result->>'followup_workflow_run_id', '') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_run
    FROM public.workflow_runs
   WHERE id = NEW.workflow_run_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_webhook_text := COALESCE(
    NULLIF(v_run.context->>'webhook_id', ''),
    NULLIF(v_run.context#>>'{workflow,context_patch,webhook_id}', '')
  );

  IF v_webhook_text IS NULL
     OR v_webhook_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;

  v_webhook_id := v_webhook_text::UUID;
  v_intent := lower(btrim(COALESCE(
    NULLIF(v_run.context->>'canonical_intent', ''),
    NULLIF(v_run.context#>>'{workflow,context_patch,canonical_intent}', ''),
    NULLIF(v_run.context#>>'{policy,workflow,intent}', ''),
    NULLIF(v_run.context#>>'{workflow,intent}', ''),
    (SELECT wi.event_type FROM public.webhook_inbox wi WHERE wi.id = v_webhook_id),
    ''
  )));

  IF v_intent NOT IN ('shipment.create', 'shipments.create', 'shipment.created') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.v_webhook_inbox_directory wid
     WHERE wid.id = v_webhook_id
       AND wid.shipment_id IS NOT NULL
  ) THEN
    RETURN NEW;
  END IF;

  v_organization_text := COALESCE(
    NULLIF(v_run.context->>'organization_id', ''),
    NULLIF(v_run.context#>>'{workflow,context_patch,organization_id}', ''),
    (SELECT wi.organization_id::TEXT FROM public.webhook_inbox wi WHERE wi.id = v_webhook_id)
  );
  IF v_organization_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_organization_id := v_organization_text::UUID;
  END IF;

  v_correlation_text := COALESCE(
    NULLIF(v_run.context->>'correlation_id', ''),
    NULLIF(v_run.context#>>'{workflow,context_patch,correlation_id}', ''),
    (SELECT wi.correlation_id::TEXT FROM public.webhook_inbox wi WHERE wi.id = v_webhook_id)
  );
  IF v_correlation_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_correlation_id := v_correlation_text::UUID;
  END IF;

  UPDATE public.webhook_inbox wi
     SET processing_status = 'failed',
         processed_at = COALESCE(wi.processed_at, now()),
         error_message = v_error,
         updated_at = now()
   WHERE wi.id = v_webhook_id
     AND wi.processing_status IS DISTINCT FROM 'succeeded'
     AND wi.processing_status NOT IN ('failed', 'dead_letter', 'processed');

  IF FOUND AND v_organization_id IS NOT NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_organization_id,
      p_decision_category := 'webhook_processing',
      p_resource_type := 'webhook_inbox',
      p_resource_id := v_webhook_id,
      p_decision_point := 'shipment_create_followup',
      p_decision_outcome := 'failed',
      p_performed_by_system := 'workflow_handlers.dispatch_followup_workflow_v1',
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object(
        'workflow_run_id', NEW.workflow_run_id,
        'workflow_step_id', NEW.id,
        'reason', 'missing_shipment_materialization_followup'
      ),
      p_decision_reason := v_error
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_run_steps_webhook_missing_shipment_followup_sync
  ON public.workflow_run_steps;

CREATE TRIGGER workflow_run_steps_webhook_missing_shipment_followup_sync
AFTER INSERT OR UPDATE OF step_status, operation_result, last_error
ON public.workflow_run_steps
FOR EACH ROW
EXECUTE FUNCTION public.sync_webhook_inbox_from_missing_shipment_followup_v1();

COMMENT ON FUNCTION public.sync_webhook_inbox_from_missing_shipment_followup_v1()
  IS 'Synchronizes webhook_inbox to terminal failed when a shipment-create acknowledgement workflow completes without enqueuing shipment materialization and no canonical shipment readback exists.';

DO $backfill$
DECLARE
  v_row RECORD;
  v_error TEXT := 'webhook shipment.create did not enqueue shipment materialization workflow';
BEGIN
  FOR v_row IN
    SELECT DISTINCT ON (wi.id)
           wi.id AS webhook_id,
           COALESCE(wr.context->>'organization_id', wr.context#>>'{workflow,context_patch,organization_id}', wi.organization_id::TEXT) AS organization_id_text,
           COALESCE(wr.context->>'correlation_id', wr.context#>>'{workflow,context_patch,correlation_id}', wi.correlation_id::TEXT) AS correlation_id_text,
           wrs.workflow_run_id,
           wrs.id AS workflow_step_id
      FROM public.workflow_run_steps wrs
      JOIN public.workflow_runs wr ON wr.id = wrs.workflow_run_id
      JOIN public.webhook_inbox wi
        ON wi.id::TEXT = COALESCE(wr.context->>'webhook_id', wr.context#>>'{workflow,context_patch,webhook_id}')
      LEFT JOIN public.v_webhook_inbox_directory wid ON wid.id = wi.id
     WHERE wrs.handler_key = 'dispatch_followup_workflow'
       AND wrs.step_status = 'completed'
       AND COALESCE(wrs.operation_result->>'workflow_enqueued', '') = 'false'
       AND COALESCE(wrs.operation_result->>'skipped', '') <> 'followup_already_started'
       AND NULLIF(wrs.operation_result->>'followup_workflow_run_id', '') IS NULL
       AND lower(btrim(COALESCE(
             NULLIF(wr.context->>'canonical_intent', ''),
             NULLIF(wr.context#>>'{workflow,context_patch,canonical_intent}', ''),
             NULLIF(wr.context#>>'{policy,workflow,intent}', ''),
             NULLIF(wr.context#>>'{workflow,intent}', ''),
             wi.event_type,
             ''
           ))) IN ('shipment.create', 'shipments.create', 'shipment.created')
       AND wid.shipment_id IS NULL
       AND wi.processing_status IS DISTINCT FROM 'succeeded'
       AND wi.processing_status NOT IN ('failed', 'dead_letter', 'processed')
     ORDER BY wi.id, wrs.updated_at DESC NULLS LAST, wrs.created_at DESC NULLS LAST
  LOOP
    UPDATE public.webhook_inbox wi
       SET processing_status = 'failed',
           processed_at = COALESCE(wi.processed_at, now()),
           error_message = v_error,
           updated_at = now()
     WHERE wi.id = v_row.webhook_id;

    IF v_row.organization_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      PERFORM public.log_decision(
        p_organization_id := v_row.organization_id_text::UUID,
        p_decision_category := 'webhook_processing',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_row.webhook_id,
        p_decision_point := 'shipment_create_followup',
        p_decision_outcome := 'failed',
        p_performed_by_system := 'workflow_handlers.dispatch_followup_workflow_v1',
        p_correlation_id := CASE
          WHEN v_row.correlation_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN v_row.correlation_id_text::UUID
          ELSE NULL
        END,
        p_decision_inputs := jsonb_build_object(
          'workflow_run_id', v_row.workflow_run_id,
          'workflow_step_id', v_row.workflow_step_id,
          'reason', 'missing_shipment_materialization_followup',
          'backfilled', TRUE
        ),
        p_decision_reason := v_error
      );
    END IF;
  END LOOP;
END;
$backfill$;

SELECT pg_advisory_unlock(hashtext('202605110315_webhook_shipment_create_missing_followup_fail_closed_v1'));

COMMIT;
