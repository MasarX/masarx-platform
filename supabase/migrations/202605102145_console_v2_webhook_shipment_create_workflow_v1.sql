-- Console V2 first-tenant webhook shipment-create workflow repair.
--
-- Shipment-creating webhooks are inbound provider/client events. They must
-- materialize the shipment, recipient, address, COD, and audit trail, then
-- complete. They must not silently start an outbound provider dispatch step
-- unless a real provider operation template is configured.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605102145_console_v2_webhook_shipment_create_workflow_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_template_id CONSTANT UUID := '77770000-0000-0000-0000-000000770002';
  v_old_async_template_id CONSTANT UUID := '99990000-0000-0000-0000-000000300002';
BEGIN
  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    notes,
    metadata,
    template_key,
    published_at,
    updated_at
  )
  VALUES (
    v_template_id,
    'webhook_shipment_create_v1',
    'Materialize a shipment from an authenticated webhook shipment.create payload without outbound provider dispatch.',
    1,
    'active',
    'global',
    NULL,
    'Console V2 first-tenant inbound webhook shipment-create follow-up workflow.',
    jsonb_build_object(
      'intent', 'shipment.create',
      'entry_point', 'webhook',
      'provider_dispatch', false,
      'readiness_scope', 'first_tenant_console_v2'
    ),
    'webhook_shipment_create_v1',
    now(),
    now()
  )
  ON CONFLICT (name) DO UPDATE
     SET description = EXCLUDED.description,
         status = 'active',
         scope_type = 'global',
         scope_id = NULL,
         notes = EXCLUDED.notes,
         metadata = COALESCE(public.workflow_templates.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         template_key = EXCLUDED.template_key,
         published_at = COALESCE(public.workflow_templates.published_at, EXCLUDED.published_at),
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
    enabled,
    created_at,
    updated_at,
    handler_key,
    handler_version
  )
  VALUES
    (
      '77770000-0000-0000-0000-000000770021',
      v_template_id,
      0,
      'context_extract_from_mapping',
      'workflow',
      'always',
      NULL,
      'reserve_identifiers',
      90,
      NULL,
      FALSE,
      '{}'::jsonb,
      TRUE,
      now(),
      now(),
      'context_extract_from_mapping',
      'v1'
    ),
    (
      '77770000-0000-0000-0000-000000770022',
      v_template_id,
      1,
      'reserve_identifiers',
      'workflow',
      'always',
      NULL,
      'create_shipment',
      85,
      NULL,
      FALSE,
      jsonb_build_object('resource_type', 'shipment'),
      TRUE,
      now(),
      now(),
      'reserve_shipment_identifiers',
      'v1'
    ),
    (
      '77770000-0000-0000-0000-000000770023',
      v_template_id,
      2,
      'create_shipment',
      'workflow',
      'always',
      NULL,
      'record_workflow_completion',
      80,
      NULL,
      FALSE,
      '{}'::jsonb,
      TRUE,
      now(),
      now(),
      'shipment_create',
      'v1'
    ),
    (
      '77770000-0000-0000-0000-000000770024',
      v_template_id,
      3,
      'record_workflow_completion',
      'workflow',
      'always',
      NULL,
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'action', 'complete',
        'status', 'completed',
        'handler_key', 'workflow_control'
      ),
      TRUE,
      now(),
      now(),
      'workflow_control',
      'v1'
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
         enabled = EXCLUDED.enabled,
         updated_at = now(),
         handler_key = EXCLUDED.handler_key,
         handler_version = EXCLUDED.handler_version;

  UPDATE public.onboarding_integration_plugin_defaults d
     SET workflow_binding = jsonb_set(
           jsonb_set(
             COALESCE(d.workflow_binding, '{}'::jsonb),
             ARRAY['template_name'],
             to_jsonb('webhook_shipment_create_v1'::text),
             true
           ),
           ARRAY['intent'],
           to_jsonb('shipment.create'::text),
           true
         ),
         updated_at = now()
   WHERE d.plugin_key = 'default-shipment-webhook-intake'
     AND COALESCE(d.workflow_binding->>'intent', 'shipment.create') = 'shipment.create';

  UPDATE public.integration_plugin_versions v
     SET workflow_binding = jsonb_set(
           jsonb_set(
             COALESCE(v.workflow_binding, '{}'::jsonb),
             ARRAY['template_name'],
             to_jsonb('webhook_shipment_create_v1'::text),
             true
           ),
           ARRAY['intent'],
           to_jsonb('shipment.create'::text),
           true
         ),
         updated_at = now()
    FROM public.integration_plugins p
   WHERE p.id = v.plugin_id
     AND p.plugin_key = 'default-shipment-webhook-intake'
     AND COALESCE(v.workflow_binding->>'intent', 'shipment.create') = 'shipment.create';

  UPDATE public.settings s
     SET cached_value = jsonb_set(
           jsonb_set(
             COALESCE(s.cached_value, '{}'::jsonb),
             ARRAY['workflow', 'template_id'],
             to_jsonb(v_template_id::text),
             true
           ),
           ARRAY['workflow', 'templates_by_intent', 'shipment.create', 'template_id'],
           to_jsonb(v_template_id::text),
           true
         ),
         last_updated = now()
   WHERE s.category = 'webhook_ingest_policy'
     AND COALESCE(s.cached_value#>>'{workflow,intent}', 'shipment.create') = 'shipment.create'
     AND (
       NULLIF(s.cached_value#>>'{workflow,template_id}', '')::uuid = v_old_async_template_id
       OR NULLIF(s.cached_value#>>'{workflow,templates_by_intent,shipment.create,template_id}', '')::uuid = v_old_async_template_id
     );

  UPDATE public.settings_versions sv
     SET value = jsonb_set(
           jsonb_set(
             COALESCE(sv.value, '{}'::jsonb),
             ARRAY['workflow', 'template_id'],
             to_jsonb(v_template_id::text),
             true
           ),
           ARRAY['workflow', 'templates_by_intent', 'shipment.create', 'template_id'],
           to_jsonb(v_template_id::text),
           true
         ),
         change_reason = 'Console V2 webhook shipment-create workflow repair (202605102145)',
         approved_at = now(),
         effective_from = COALESCE(sv.effective_from, now())
   WHERE sv.category = 'webhook_ingest_policy'
     AND COALESCE(sv.value#>>'{workflow,intent}', 'shipment.create') = 'shipment.create'
     AND (
       NULLIF(sv.value#>>'{workflow,template_id}', '')::uuid = v_old_async_template_id
       OR NULLIF(sv.value#>>'{workflow,templates_by_intent,shipment.create,template_id}', '')::uuid = v_old_async_template_id
     );

  -- Existing workflow rows should never execute a missing provider operation.
  -- API/provider shipment creation remains a separate lifecycle slice and
  -- must wire a real operation template before enabling outbound steps again.
  UPDATE public.workflow_template_steps wts
     SET enabled = FALSE,
         metadata = jsonb_strip_nulls(
           COALESCE(wts.metadata, '{}'::jsonb)
           || jsonb_build_object(
             'disabled_reason', 'operation_template_unavailable',
             'requires_provider_operation', TRUE
           )
         ),
         updated_at = now()
   WHERE wts.handler_key = 'outbound_http'
     AND wts.enabled IS TRUE
     AND NOT EXISTS (
       SELECT 1
         FROM public.operation_templates ot
        WHERE NULLIF(wts.metadata->>'operation_template_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND ot.id = NULLIF(wts.metadata->>'operation_template_id', '')::uuid
     );
END;
$$;

WITH recalculated AS (
  SELECT
    wts.workflow_template_id,
    md5(
      string_agg(
        concat_ws(
          '|',
          wts.sequence_order,
          COALESCE(wts.operation_name, ''),
          COALESCE(wts.operation_settings_category, ''),
          COALESCE(wts.transition_condition, ''),
          COALESCE(wts.handler_key, ''),
          COALESCE(wts.handler_version, ''),
          COALESCE(wts.enabled::text, ''),
          COALESCE(wts.metadata::text, '')
        ),
        '||' ORDER BY wts.sequence_order, wts.id
      )
    ) AS checksum
  FROM public.workflow_template_steps wts
  WHERE wts.workflow_template_id IN (
    '77770000-0000-0000-0000-000000770002'::uuid,
    '99990000-0000-0000-0000-000000300002'::uuid
  )
  GROUP BY wts.workflow_template_id
)
UPDATE public.workflow_templates wt
   SET steps_checksum = recalculated.checksum,
       updated_at = now()
  FROM recalculated
 WHERE wt.id = recalculated.workflow_template_id;

SELECT pg_advisory_unlock(hashtext('202605102145_console_v2_webhook_shipment_create_workflow_v1'));

COMMIT;
