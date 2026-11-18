-- Console V2 webhook shipment-create sender fail-closed repair.
--
-- Live clicked proof exposed an accepted webhook whose follow-up workflow
-- failed before shipment materialization because the webhook source had no
-- sender/client context. Keep the backend contract fail-closed:
--   * source binding repair refuses enabled shipment-create sources without a
--     sender binding;
--   * shipment-create workflow failures from missing org/client/tracking mark
--     the webhook inbox failed instead of leaving it in_progress.
--   * already-accepted webhook inbox rows whose follow-up workflow failed are
--     backfilled to terminal failed state with the workflow error.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605091145_webhook_shipment_create_sender_fail_closed_v1'));

SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_marker TEXT;
  v_injection TEXT;
BEGIN
  SELECT pg_get_functiondef('public.ensure_webhook_source_plugin_binding_v1(uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ensure_webhook_source_plugin_binding_v1 definition not found';
  END IF;

  IF position('missing_sender_binding' IN v_def) = 0 THEN
    v_marker := E'  IF lower(COALESCE(v_mapping.mapping_config->>''target'', '''')) NOT IN (''shipment.create'', ''shipments.create'') THEN\n    RETURN jsonb_build_object(\n      ''ok'', TRUE,\n      ''skipped'', TRUE,\n      ''reason'', ''non_shipment_create_mapping'',\n      ''mapping_config_id'', v_mapping.id\n    );\n  END IF;\n';
    v_injection := v_marker || E'\n  IF v_source.sender_id IS NULL THEN\n    RETURN jsonb_build_object(\n      ''ok'', FALSE,\n      ''reason'', ''missing_sender_binding'',\n      ''webhook_source_id'', v_source.id,\n      ''mapping_config_id'', v_mapping.id\n    );\n  END IF;\n\n  PERFORM 1\n    FROM public.senders s\n    JOIN public.clients c ON c.id = s.client_id\n   WHERE s.id = v_source.sender_id\n     AND c.organization_id = v_source.organization_id\n     AND COALESCE(s.status, ''active'') = ''active''\n     AND COALESCE(c.status, ''active'') = ''active'';\n\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object(\n      ''ok'', FALSE,\n      ''reason'', ''invalid_sender_binding'',\n      ''webhook_source_id'', v_source.id,\n      ''sender_id'', v_source.sender_id,\n      ''mapping_config_id'', v_mapping.id\n    );\n  END IF;\n';

    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch ensure_webhook_source_plugin_binding_v1 sender guard';
    END IF;

    EXECUTE replace(v_def, v_marker, v_injection);
  END IF;
END;
$patch$;

DO $patch$
DECLARE
  v_def TEXT;
  v_marker TEXT;
  v_replacement TEXT;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 definition not found';
  END IF;

  IF position('missing_required_context_failed_webhook_inbox' IN v_def) = 0 THEN
    v_marker := E'    IF v_org IS NULL OR v_client IS NULL OR v_planned_tracking IS NULL THEN\n        RAISE EXCEPTION ''execute_shipment_create_v1: missing required context (org %, client %, tracking %)'',\n            v_org, v_client, v_planned_tracking;\n    END IF;\n';
    v_replacement := E'    IF v_org IS NULL OR v_client IS NULL OR v_planned_tracking IS NULL THEN\n        v_result.status := ''failed'';\n        v_result.last_error := format(\n          ''execute_shipment_create_v1: missing required context (org %s, client %s, tracking %s)'',\n          COALESCE(v_org::TEXT, ''<NULL>''),\n          COALESCE(v_client::TEXT, ''<NULL>''),\n          COALESCE(v_planned_tracking, ''<NULL>'')\n        );\n        v_result.operation_result := jsonb_build_object(\n          ''reason'', ''missing_required_context_failed_webhook_inbox'',\n          ''error'', v_result.last_error,\n          ''webhook_id'', v_metadata_source,\n          ''organization_id'', v_org,\n          ''client_id'', v_client,\n          ''planned_tracking_number'', v_planned_tracking\n        );\n        v_result.context_patch := jsonb_build_object(\n          ''shipment_create_error'', v_result.operation_result\n        );\n\n        IF v_metadata_source IS NOT NULL THEN\n          UPDATE public.webhook_inbox wi\n             SET processing_status = ''failed'',\n                 processed_at = COALESCE(wi.processed_at, now()),\n                 error_message = v_result.last_error,\n                 updated_at = now()\n           WHERE wi.id = v_metadata_source\n             AND wi.processing_status IS DISTINCT FROM ''succeeded'';\n\n          IF v_org IS NOT NULL THEN\n            PERFORM public.log_decision(\n              p_organization_id := v_org,\n              p_decision_category := ''webhook_processing'',\n              p_resource_type := ''webhook_inbox'',\n              p_resource_id := v_metadata_source,\n              p_decision_point := ''shipment_create_context'',\n              p_decision_outcome := ''failed'',\n              p_performed_by_system := ''workflow_handlers.execute_shipment_create_v1'',\n              p_correlation_id := v_correlation_id,\n              p_decision_inputs := v_result.operation_result,\n              p_decision_reason := v_result.last_error\n            );\n          END IF;\n        END IF;\n\n        RETURN v_result;\n    END IF;\n';

    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch execute_shipment_create_v1 missing-context branch';
    END IF;

    EXECUTE replace(v_def, v_marker, v_replacement);
  END IF;
END;
$patch$;

COMMENT ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID)
  IS 'Ensures enabled shipment-create webhook sources have sender/client context plus a plugin runtime binding and source-level webhook_ingest_policy so receiver POSTs can materialize shipments through the workflow engine.';

COMMENT ON FUNCTION workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Workflow-owned shipment creation handler. Materializes API/webhook shipment, recipient, destination address, COD, reference, and lineage data from canonical workflow context; missing required webhook context marks the inbox failed instead of leaving it pending.';

WITH failed_followups AS (
  SELECT DISTINCT
         wi.id AS webhook_id,
         COALESCE(
           NULLIF(followup.failure_reason, ''),
           NULLIF(followup.last_error->>'error', ''),
           NULLIF(COALESCE(followup.last_error, '{}'::jsonb)::TEXT, '{}'),
           'follow-up workflow failed'
         ) AS error_message
    FROM public.webhook_inbox wi
    JOIN public.workflow_runs entry
      ON entry.id = wi.workflow_run_id
    JOIN public.workflow_runs followup
      ON followup.id = CASE
           WHEN COALESCE(entry.context->>'followup_workflow_run_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (entry.context->>'followup_workflow_run_id')::UUID
           ELSE NULL
         END
      OR followup.metadata->>'started_by_run_id' = entry.id::TEXT
   WHERE wi.processing_status = 'in_progress'
     AND followup.workflow_status = 'failed'
)
UPDATE public.webhook_inbox wi
   SET processing_status = 'failed',
       processed_at = COALESCE(wi.processed_at, now()),
       error_message = failed_followups.error_message,
       updated_at = now()
  FROM failed_followups
 WHERE wi.id = failed_followups.webhook_id
   AND wi.processing_status = 'in_progress';

SELECT pg_advisory_unlock(hashtext('202605091145_webhook_shipment_create_sender_fail_closed_v1'));

COMMIT;
