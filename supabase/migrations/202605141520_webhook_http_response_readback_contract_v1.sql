-- Console V2 first-tenant webhook HTTP readback contract repair.
--
-- Webhook receiver responses must echo the persisted webhook_inbox
-- correlation_id, and shipment-create follow-up workflows must receive the
-- source mapping_config_id so recipient/address extraction remains
-- backend-backed and row-driven.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605141520_webhook_http_response_readback_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch_core$
DECLARE
  v_def TEXT;
  v_marker TEXT := E'''source_identifier'', v_source.source_identifier,\n        ''followup_template_id'', v_template_id';
  v_replacement TEXT := E'''source_identifier'', v_source.source_identifier,\n        ''context_mapping_id'', v_source.mapping_config_id,\n        ''mapping_config_id'', v_source.mapping_config_id,\n        ''followup_template_id'', v_template_id';
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb) not found';
  END IF;

  IF position('''context_mapping_id'', v_source.mapping_config_id' IN v_def) = 0 THEN
    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'expected webhook follow-up context marker not found';
    END IF;

    v_def := replace(v_def, v_marker, v_replacement);
    EXECUTE v_def;
  END IF;
END;
$patch_core$;

DO $patch_shipment_create$
DECLARE
  v_def TEXT;
  v_marker_recipient TEXT := $marker$      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,recipient}') = 'object' THEN v_materialized_payload#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'recipient') = 'object' THEN v_resource->'recipient' END, '{}'::jsonb)$marker$;
  v_replacement_recipient TEXT := $replacement$      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,recipient}') = 'object' THEN v_materialized_payload#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,customer}') = 'object' THEN v_materialized_payload#>'{shipment,customer}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'recipient') = 'object' THEN v_resource->'recipient' END, '{}'::jsonb)$replacement$;
  v_marker_address TEXT := $marker$      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'destination_address') = 'object' THEN v_materialized_payload->'destination_address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,recipient,address}') = 'object' THEN v_materialized_payload#>'{shipment,recipient,address}' END, '{}'::jsonb)$marker$;
  v_replacement_address TEXT := $replacement$      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'destination_address') = 'object' THEN v_materialized_payload->'destination_address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,address}') = 'object' THEN v_materialized_payload#>'{shipment,address}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,destination_address}') = 'object' THEN v_materialized_payload#>'{shipment,destination_address}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,recipient,address}') = 'object' THEN v_materialized_payload#>'{shipment,recipient,address}' END, '{}'::jsonb)$replacement$;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb) not found';
  END IF;

  IF position('v_materialized_payload#>''{shipment,customer}''' IN v_def) = 0 THEN
    IF position(v_marker_recipient IN v_def) = 0 THEN
      RAISE EXCEPTION 'expected shipment recipient materialization marker not found';
    END IF;
    v_def := replace(v_def, v_marker_recipient, v_replacement_recipient);
  END IF;

  IF position('v_materialized_payload#>''{shipment,address}''' IN v_def) = 0 THEN
    IF position(v_marker_address IN v_def) = 0 THEN
      RAISE EXCEPTION 'expected shipment address materialization marker not found';
    END IF;
    v_def := replace(v_def, v_marker_address, v_replacement_address);
  END IF;

  EXECUTE v_def;
END;
$patch_shipment_create$;

DO $patch_policy_repairs$
DECLARE
  v_def TEXT;
  v_marker_4 TEXT := $marker$'default_headers', jsonb_build_object('content-type', 'application/json')
    ),$marker$;
  v_replacement_4 TEXT := $replacement$'default_headers', jsonb_build_object('content-type', 'application/json'),
      'response_mapping_id', COALESCE(
        NULLIF(v_existing_policy#>>'{ack,response_mapping_id}', ''),
        NULLIF(v_existing_policy#>>'{response,response_mapping_id}', '')
      )
    ),$replacement$;
  v_marker_8 TEXT := $marker$'default_headers', jsonb_build_object('content-type', 'application/json')
        ),$marker$;
  v_replacement_8 TEXT := $replacement$'default_headers', jsonb_build_object('content-type', 'application/json'),
          'response_mapping_id', COALESCE(
            NULLIF(v_existing_policy#>>'{ack,response_mapping_id}', ''),
            NULLIF(v_existing_policy#>>'{response,response_mapping_id}', '')
          )
        ),$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.repair_integration_plugin_webhook_policy_v1(uuid,uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NOT NULL AND position('v_existing_policy#>>''{ack,response_mapping_id}''' IN v_def) = 0 THEN
    IF position(v_marker_4 IN v_def) > 0 THEN
      v_def := replace(v_def, v_marker_4, v_replacement_4);
    ELSIF position(v_marker_8 IN v_def) > 0 THEN
      v_def := replace(v_def, v_marker_8, v_replacement_8);
    ELSE
      RAISE EXCEPTION 'expected plugin policy ack marker not found';
    END IF;
    EXECUTE v_def;
  END IF;

  SELECT pg_get_functiondef('public.ensure_webhook_source_plugin_binding_v1(uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NOT NULL AND position('v_existing_policy#>>''{ack,response_mapping_id}''' IN v_def) = 0 THEN
    IF position(v_marker_4 IN v_def) > 0 THEN
      v_def := replace(v_def, v_marker_4, v_replacement_4);
    ELSIF position(v_marker_8 IN v_def) > 0 THEN
      v_def := replace(v_def, v_marker_8, v_replacement_8);
    ELSE
      RAISE EXCEPTION 'expected source plugin binding ack marker not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$patch_policy_repairs$;

DO $patch_followup_decision$
DECLARE
  v_def TEXT;
  v_marker TEXT := $marker$        v_response.context_patch := jsonb_build_object(
            'followup_workflow_run_id', v_existing_followup
        );
        RETURN v_response;$marker$;
  v_replacement TEXT := $replacement$        v_response.context_patch := jsonb_build_object(
            'followup_workflow_run_id', v_existing_followup
        );

        IF v_webhook_id IS NOT NULL THEN
            PERFORM public.log_decision(
                p_organization_id := v_organization_id,
                p_decision_category := 'webhook_processing',
                p_resource_type := 'webhook_inbox',
                p_resource_id := v_webhook_id,
                p_decision_point := 'workflow_start',
                p_decision_outcome := 'workflow_enqueued',
                p_performed_by_system := 'workflow_engine',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_build_object(
                    'workflow_run_id', v_existing_followup,
                    'followup_workflow_run_id', v_existing_followup,
                    'workflow_template_id', v_template_id,
                    'workflow_enqueued', FALSE,
                    'skipped', 'followup_already_started'
                ),
                p_decision_reason := 'followup_already_started'
            );
        END IF;

        RETURN v_response;$replacement$;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.dispatch_followup_workflow_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'workflow_handlers.dispatch_followup_workflow_v1(public.workflow_run_steps,public.workflow_runs,jsonb) not found';
  END IF;

  IF position('''skipped'', ''followup_already_started''' IN v_def) > 0
     AND position('p_decision_reason := ''followup_already_started''' IN v_def) = 0 THEN
    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'expected dispatch followup existing-run marker not found';
    END IF;
    v_def := replace(v_def, v_marker, v_replacement);
    EXECUTE v_def;
  END IF;
END;
$patch_followup_decision$;

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
  v_webhook_id UUID := NULL;
  v_organization_id UUID := NULL;
  v_replayed_webhook_id UUID := NULL;
  v_original_workflow_run_id UUID := NULL;
BEGIN
  v_result := public.workflow_intake_webhook_core_v1(
    p_token,
    p_headers,
    p_raw_body,
    p_payload
  );

  IF COALESCE(v_result->>'webhook_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_webhook_id := (v_result->>'webhook_id')::UUID;
  END IF;

  IF NULLIF(v_result->>'workflow_run_id', '') IS NULL
     AND COALESCE(v_result->>'ack_outcome', '') = 'ack_replayed'
     AND v_webhook_id IS NOT NULL THEN
    v_replayed_webhook_id := v_webhook_id;

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

  IF v_webhook_id IS NOT NULL THEN
    SELECT wi.correlation_id, wi.organization_id
      INTO v_response_correlation_id, v_organization_id
      FROM public.webhook_inbox wi
     WHERE wi.id = v_webhook_id;
  END IF;

  v_response_correlation_id := COALESCE(
    NULLIF(v_response_correlation_id, ''),
    NULLIF(v_result->>'correlation_id', ''),
    NULLIF(v_result->'body'->>'correlation_id', ''),
    NULLIF(v_result->'body'->'webhook'->>'correlation_id', '')
  );

  IF v_response_correlation_id IS NOT NULL THEN
    v_result := jsonb_set(v_result, '{correlation_id}', to_jsonb(v_response_correlation_id), TRUE);

    IF jsonb_typeof(v_result->'body') = 'object' THEN
      v_result := jsonb_set(v_result, '{body,correlation_id}', to_jsonb(v_response_correlation_id), TRUE);
    END IF;

    IF jsonb_typeof(v_result#>'{body,webhook}') = 'object' THEN
      v_result := jsonb_set(v_result, '{body,webhook,correlation_id}', to_jsonb(v_response_correlation_id), TRUE);
    END IF;
  END IF;

  IF v_webhook_id IS NOT NULL AND v_followup_run_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.resource_type = 'webhook_inbox'
         AND dl.resource_id = v_webhook_id
         AND dl.decision_outcome = 'workflow_enqueued'
         AND COALESCE(dl.decision_inputs->>'followup_workflow_run_id', dl.decision_inputs->>'workflow_run_id') = v_followup_run_id::TEXT
    ) THEN
      PERFORM public.log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'webhook_processing',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := 'workflow_start',
        p_decision_outcome := 'workflow_enqueued',
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := NULLIF(v_response_correlation_id, '')::UUID,
        p_decision_inputs := jsonb_build_object(
          'workflow_run_id', v_followup_run_id,
          'followup_workflow_run_id', v_followup_run_id,
          'entry_workflow_run_id', NULLIF(v_result->>'workflow_run_id', ''),
          'source', 'workflow_intake_webhook_wrapper'
        ),
        p_decision_reason := NULL
      );
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.workflow_intake_webhook(text, jsonb, text, jsonb)
  IS 'Public webhook intake wrapper: preserves original workflow_run_id in idempotency replay responses, optionally progresses sync follow-up workflows, and returns the persisted webhook_inbox correlation_id for browser/API readback.';

REVOKE EXECUTE ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO service_role;
DO $grant_edge$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_webhook_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO edge_webhook_role';
  END IF;
END;
$grant_edge$;

SELECT pg_advisory_unlock(hashtext('202605141520_webhook_http_response_readback_contract_v1'));

COMMIT;
