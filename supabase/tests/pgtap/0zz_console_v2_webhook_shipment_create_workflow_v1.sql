-- pgTAP: Console V2 shipment-creating webhooks must use a shipment-only
-- follow-up workflow. pgTAP is supporting proof only; live clicked Browser/
-- Chrome evidence remains required before readiness can be marked Complete.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(23);

SELECT is(
  (
    SELECT status
      FROM public.workflow_templates
     WHERE name = 'webhook_shipment_create_v1'
     LIMIT 1
  ),
  'active',
  'webhook_shipment_create_v1 exists and is active'
);

SELECT is(
  (
    SELECT string_agg(handler_key, ',' ORDER BY sequence_order)
      FROM public.workflow_template_steps
     WHERE workflow_template_id = (
       SELECT id FROM public.workflow_templates WHERE name = 'webhook_shipment_create_v1'
     )
       AND enabled IS TRUE
  ),
  'context_extract_from_mapping,reserve_shipment_identifiers,shipment_create,shipment_update_geocode,workflow_control',
  'webhook_shipment_create_v1 materializes shipment and completes without provider dispatch'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.workflow_template_steps
     WHERE workflow_template_id = (
       SELECT id FROM public.workflow_templates WHERE name = 'webhook_shipment_create_v1'
     )
       AND enabled IS TRUE
       AND handler_key = 'outbound_http'
  ),
  'webhook_shipment_create_v1 has no enabled outbound HTTP step'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.workflow_template_steps
     WHERE workflow_template_id = (
       SELECT id FROM public.workflow_templates WHERE name = 'async_provider_dispatch_v1'
     )
       AND enabled IS TRUE
       AND handler_key = 'outbound_http'
       AND NULLIF(metadata->>'operation_template_id', '') IS NULL
  ),
  'async_provider_dispatch_v1 has no enabled outbound step with a missing operation_template_id'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.workflow_template_steps wts
     WHERE wts.enabled IS TRUE
       AND wts.handler_key = 'outbound_http'
       AND NOT EXISTS (
         SELECT 1
           FROM public.operation_templates ot
          WHERE NULLIF(wts.metadata->>'operation_template_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND ot.id = NULLIF(wts.metadata->>'operation_template_id', '')::uuid
       )
  ),
  'every enabled outbound_http workflow step references an existing operation template'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_template_steps
     WHERE workflow_template_id = (
       SELECT id FROM public.workflow_templates WHERE name = 'async_provider_dispatch_v1'
     )
       AND handler_key = 'outbound_http'
       AND enabled IS FALSE
       AND metadata->>'disabled_reason' = 'operation_template_unavailable'
  ),
  'unconfigured async provider outbound step is disabled with an explicit reason'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.onboarding_integration_plugin_defaults
     WHERE plugin_key = 'default-shipment-webhook-intake'
       AND workflow_binding = '{"template_name":"webhook_intake_v1"}'::jsonb
  ),
  'onboarding default keeps the general webhook intake binding'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.integration_plugin_versions v
      JOIN public.integration_plugins p ON p.id = v.plugin_id
     WHERE p.plugin_key = 'default-shipment-webhook-intake'
       AND v.status = 'active'
       AND v.workflow_binding = '{"template_name":"webhook_intake_v1"}'::jsonb
  ),
  'an active onboarding webhook plugin retains the general intake binding'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'webhook_ingest_policy'
       AND s.cached_value#>>'{workflow,intent}' = 'shipment.create'
       AND (
         s.cached_value#>>'{workflow,template_id}' = '99990000-0000-0000-0000-000000300002'
         OR s.cached_value#>>'{workflow,templates_by_intent,shipment.create,template_id}' = '99990000-0000-0000-0000-000000300002'
       )
  ),
  'shipment.create webhook ingest policies no longer point at async_provider_dispatch_v1'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'webhook_ingest_policy'
       AND public.webhook_policy_applies_to_shipment_intent_v1(s.cached_value, 'shipment.create')
       AND public.resolve_webhook_followup_template_id_v1(s.cached_value, 'shipment.create') =
           '77770000-0000-0000-0000-000000770002'::UUID
  ),
  'shipment.create webhook ingest policies point at webhook_shipment_create_v1'
);

SELECT ok(
  position(
    'missing_required_webhook_party_address_failed_webhook_inbox'
    IN pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
  ) > 0,
  'shipment-create webhook handler fails closed when recipient or destination address materialization is missing'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'workflow_run_steps'
       AND t.tgname = 'workflow_run_steps_webhook_shipment_create_failure_sync'
       AND NOT t.tgisinternal
  ),
  'failed shipment-create workflow steps synchronize webhook inbox terminal failure readback'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'workflow_run_steps'
       AND t.tgname = 'workflow_run_steps_webhook_missing_shipment_followup_sync'
       AND NOT t.tgisinternal
  ),
  'missing shipment materialization follow-up synchronizes webhook inbox terminal failure readback'
);

DO $$
DECLARE
  v_source_id UUID;
  v_template_id UUID;
  v_template_version INTEGER;
  v_template_step_id UUID;
  v_run_id UUID := '77770000-0000-4000-8000-000000770145'::UUID;
  v_webhook_id UUID := '77770000-0000-4000-8000-000000770146'::UUID;
BEGIN
  SELECT id
    INTO v_source_id
    FROM public.webhook_sources
   ORDER BY created_at ASC, id ASC
   LIMIT 1;

  SELECT id, version
    INTO v_template_id, v_template_version
    FROM public.workflow_templates
   WHERE name = 'webhook_shipment_create_v1'
   LIMIT 1;

  SELECT id
    INTO v_template_step_id
    FROM public.workflow_template_steps
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'shipment_create'
   ORDER BY sequence_order ASC
   LIMIT 1;

  IF v_source_id IS NULL OR v_template_id IS NULL OR v_template_step_id IS NULL THEN
    RAISE EXCEPTION 'missing webhook source or webhook_shipment_create_v1 shipment_create step for sync behavior test';
  END IF;

  INSERT INTO public.webhook_inbox (
    id,
    webhook_source_id,
    provider_type,
    event_type,
    raw_payload,
    transformed_payload,
    processing_status,
    correlation_id,
    idempotency_key
  )
  VALUES (
    v_webhook_id,
    v_source_id,
    'generic',
    'shipment.created',
    jsonb_build_object('event', jsonb_build_object('id', 'pgtap-webhook-failed-sync')),
    jsonb_build_object('event', jsonb_build_object('id', 'pgtap-webhook-failed-sync')),
    'pending',
    gen_random_uuid(),
    'pgtap-webhook-failed-sync'
  );

  PERFORM set_config('app.workflow_run_id', v_run_id::TEXT, true);

  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
  )
  VALUES (
    v_run_id,
    v_template_id,
    v_template_version,
    'webhook',
    'in_progress',
    jsonb_build_object('webhook_id', v_webhook_id)
  );

  PERFORM set_config('app.workflow_run_id', v_run_id::TEXT, true);

  INSERT INTO public.workflow_run_steps (
    workflow_run_id,
    workflow_template_step_id,
    sequence_order,
    step_status,
    operation_name,
    operation_result,
    last_error,
    max_retries,
    handler_key
  )
  VALUES (
    v_run_id,
    v_template_step_id,
    2,
    'failed',
    'create_shipment',
    jsonb_build_object(
      'webhook_id', v_webhook_id,
      'error', 'execute_shipment_create_v1: missing required webhook shipment recipient/address'
    ),
    'execute_shipment_create_v1: missing required webhook shipment recipient/address',
    1,
    'shipment_create'
  );
END;
$$;

SELECT is(
  (
    SELECT processing_status
      FROM public.webhook_inbox
     WHERE id = '77770000-0000-4000-8000-000000770146'::UUID
  ),
  'failed',
  'failed shipment-create step flips webhook inbox status to failed'
);

SELECT matches(
  (
    SELECT error_message
      FROM public.webhook_inbox
     WHERE id = '77770000-0000-4000-8000-000000770146'::UUID
  ),
  '.*missing required webhook shipment recipient/address.*',
  'failed shipment-create step writes the terminal inbox error message'
);

DO $$
DECLARE
  v_source_id UUID;
  v_template_id UUID;
  v_template_version INTEGER;
  v_template_step_id UUID;
  v_run_id UUID := '77770000-0000-4000-8000-000000770245'::UUID;
  v_webhook_id UUID := '77770000-0000-4000-8000-000000770246'::UUID;
BEGIN
  SELECT id
    INTO v_source_id
    FROM public.webhook_sources
   ORDER BY created_at ASC, id ASC
   LIMIT 1;

  SELECT wt.id, wt.version, wts.id
    INTO v_template_id, v_template_version, v_template_step_id
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
   WHERE wts.handler_key = 'dispatch_followup_workflow'
   ORDER BY wt.created_at DESC NULLS LAST, wt.id ASC, wts.sequence_order ASC
   LIMIT 1;

  IF v_source_id IS NULL OR v_template_id IS NULL OR v_template_step_id IS NULL THEN
    RAISE EXCEPTION 'missing webhook source or dispatch_followup_workflow step for missing-followup behavior test';
  END IF;

  PERFORM set_config('app.workflow_run_id', v_run_id::TEXT, true);

  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
  )
  VALUES (
    v_run_id,
    v_template_id,
    v_template_version,
    'webhook',
    'completed',
    jsonb_build_object(
      'webhook_id', v_webhook_id,
      'canonical_intent', 'shipment.create',
      'correlation_id', '77770000-0000-4000-8000-000000770247'
    )
  );

  INSERT INTO public.webhook_inbox (
    id,
    webhook_source_id,
    provider_type,
    event_type,
    raw_payload,
    transformed_payload,
    processing_status,
    correlation_id,
    idempotency_key,
    workflow_run_id
  )
  VALUES (
    v_webhook_id,
    v_source_id,
    'generic',
    'shipment.created',
    jsonb_build_object('event', jsonb_build_object('id', 'pgtap-webhook-missing-followup')),
    jsonb_build_object('event', jsonb_build_object('id', 'pgtap-webhook-missing-followup')),
    'in_progress',
    '77770000-0000-4000-8000-000000770247'::UUID,
    'pgtap-webhook-missing-followup',
    v_run_id
  );

  PERFORM set_config('app.workflow_run_id', v_run_id::TEXT, true);

  INSERT INTO public.workflow_run_steps (
    workflow_run_id,
    workflow_template_step_id,
    sequence_order,
    step_status,
    operation_name,
    operation_result,
    max_retries,
    handler_key
  )
  VALUES (
    v_run_id,
    v_template_step_id,
    3,
    'completed',
    'dispatch_followup_workflow',
    jsonb_build_object('workflow_enqueued', FALSE),
    1,
    'dispatch_followup_workflow'
  );
END;
$$;

SELECT is(
  (
    SELECT processing_status
      FROM public.webhook_inbox
     WHERE id = '77770000-0000-4000-8000-000000770246'::UUID
  ),
  'failed',
  'shipment-create webhook inbox fails terminally when no materialization follow-up is enqueued'
);

SELECT matches(
  (
    SELECT error_message
      FROM public.webhook_inbox
     WHERE id = '77770000-0000-4000-8000-000000770246'::UUID
  ),
  '.*did not enqueue shipment materialization workflow.*',
  'missing follow-up shipment-create webhook writes the terminal inbox error message'
);

SELECT ok(
  to_regprocedure('public.webhook_inbox_is_terminal_shipment_create_failure_v1(uuid)') IS NOT NULL,
  'terminal shipment-create webhook failure classifier exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'webhook_inbox'
       AND t.tgname = 'webhook_inbox_preserve_terminal_shipment_failure'
       AND NOT t.tgisinternal
  ),
  'webhook inbox has a terminal shipment-create failure preservation trigger'
);

SELECT ok(
  public.webhook_inbox_is_terminal_shipment_create_failure_v1('77770000-0000-4000-8000-000000770146'::UUID),
  'missing recipient/address webhook failure classifies as terminal shipment-create failure'
);

UPDATE public.webhook_inbox
   SET processing_status = 'pending',
       processed_at = NULL,
       error_message = NULL,
       lease_expires_at = NULL,
       retry_count = COALESCE(retry_count, 0) + 1
 WHERE id = '77770000-0000-4000-8000-000000770146'::UUID;

SELECT is(
  (
    SELECT processing_status
      FROM public.webhook_inbox
     WHERE id = '77770000-0000-4000-8000-000000770146'::UUID
  ),
  'failed',
  'terminal shipment-create failure cannot be downgraded to pending'
);

SELECT matches(
  (
    SELECT error_message
      FROM public.webhook_inbox
     WHERE id = '77770000-0000-4000-8000-000000770146'::UUID
  ),
  '.*missing required webhook shipment recipient/address.*',
  'terminal shipment-create failure keeps its error message when retry paths try to clear it'
);

DO $$
BEGIN
  PERFORM public.ops_maintenance_retry_webhook_inbox(jsonb_build_object(
    'task_key', 'retry_webhook_inbox',
    'arguments', jsonb_build_object(
      'batch_size', 500,
      'backoff_seconds', jsonb_build_array(0),
      'max_retries', 3
    )
  ));
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.ops_quarantine oq
     WHERE oq.resource_type = 'webhook_inbox'
       AND oq.resource_id = '77770000-0000-4000-8000-000000770146'::UUID
       AND oq.status = 'open'
       AND oq.reason = 'non_retryable_shipment_create_failure'
  ),
  'ops maintenance quarantines terminal shipment-create failures instead of requeueing them'
);

SELECT * FROM finish();
ROLLBACK;
