-- Migration: Workflow schedule task payload repair
-- Purpose:
--   - Give Console V2 operators a backend-backed way to repair scheduled
--     task_enqueue_dynamic runs whose context is missing binding_payload.task.
--   - Keep the repair row-driven through operation_templates metadata plus
--     task_type_catalog defaults instead of encoding template-specific logic in
--     the frontend.

BEGIN;

SET search_path TO public, extensions, pg_temp;

UPDATE public.operation_templates ot
SET metadata = public.jsonb_deep_merge(
  COALESCE(ot.metadata, '{}'::jsonb),
  jsonb_build_object(
    'workflow_schedule_task_payload_defaults',
    jsonb_build_object(
      'task_type_key', CASE ot.operation_name
        WHEN 'binding_review_requested_task' THEN 'customer_shipment_change_review'
        WHEN 'binding_tenant_signup_review_task' THEN 'tenant_signup_review'
        WHEN 'binding_marketing_lead_review_task' THEN 'marketing_lead_followup'
      END,
      'resource_type', CASE ot.operation_name
        WHEN 'binding_review_requested_task' THEN 'shipment'
        WHEN 'binding_tenant_signup_review_task' THEN 'tenant_signup_request'
        WHEN 'binding_marketing_lead_review_task' THEN 'marketing_lead_request'
      END,
      'actor_system', 'workflow_schedule_task_repair'
    )
  )
),
updated_at = now()
WHERE ot.handler_key = 'task_enqueue_dynamic'
  AND ot.operation_name IN (
    'binding_review_requested_task',
    'binding_tenant_signup_review_task',
    'binding_marketing_lead_review_task'
  );

CREATE OR REPLACE FUNCTION public.ui_repair_workflow_schedule_task_payload_v1(
  p_workflow_schedule_trigger_id UUID,
  p_task_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_row public.workflow_schedule_triggers%ROWTYPE;
  v_step RECORD;
  v_operation_defaults JSONB := '{}'::jsonb;
  v_operator_payload JSONB := COALESCE(p_task_payload, '{}'::jsonb);
  v_catalog_entry JSONB := '{}'::jsonb;
  v_assignment_defaults JSONB := '{}'::jsonb;
  v_task_type_key TEXT;
  v_resource_type TEXT;
  v_resource_id UUID := NULL;
  v_queue_key TEXT;
  v_priority INT := NULL;
  v_sla_minutes INT := NULL;
  v_actor_system TEXT;
  v_task_context JSONB := '{}'::jsonb;
  v_task_metadata JSONB := '{}'::jsonb;
  v_repaired_task JSONB;
  v_repaired_context_patch JSONB;
  v_context JSONB;
  v_preflight JSONB;
BEGIN
  IF p_workflow_schedule_trigger_id IS NULL THEN
    RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 requires workflow_schedule_trigger_id';
  END IF;

  IF jsonb_typeof(v_operator_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 expects task payload object'
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write', v_scope_type, v_scope_id);

  SELECT *
  INTO v_row
  FROM public.workflow_schedule_triggers
  WHERE id = p_workflow_schedule_trigger_id
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 schedule trigger not found';
  END IF;

  IF v_scope_type = 'tenant' THEN
    IF v_row.organization_id IS DISTINCT FROM v_scope_id THEN
      RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 cannot repair schedule outside current tenant scope'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_scope_type IN ('client', 'sender') THEN
    IF v_row.scope_type IS DISTINCT FROM v_scope_type
       OR v_row.scope_id IS DISTINCT FROM v_scope_id
    THEN
      RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 cannot repair schedule outside current % scope', v_scope_type
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 unsupported current scope %', COALESCE(v_scope_type, '<null>')
      USING ERRCODE = '42501';
  END IF;

  SELECT
    wts.id,
    wts.operation_name,
    wts.handler_key,
    wts.metadata,
    wts.sequence_order
  INTO v_step
  FROM public.workflow_template_steps wts
  WHERE wts.workflow_template_id = v_row.workflow_template_id
    AND wts.enabled = TRUE
    AND wts.handler_key = 'task_enqueue_dynamic'
  ORDER BY wts.sequence_order ASC, wts.id ASC
  LIMIT 1;

  IF v_step.id IS NULL THEN
    RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 found no enabled task_enqueue_dynamic step';
  END IF;

  SELECT COALESCE(ot.metadata->'workflow_schedule_task_payload_defaults', '{}'::jsonb)
  INTO v_operation_defaults
  FROM public.operation_templates ot
  WHERE ot.operation_name = v_step.operation_name
    AND ot.handler_key = v_step.handler_key
  ORDER BY ot.updated_at DESC NULLS LAST, ot.id ASC
  LIMIT 1;

  IF jsonb_typeof(v_operation_defaults) IS DISTINCT FROM 'object'
     OR v_operation_defaults = '{}'::jsonb THEN
    RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 missing operation task payload defaults for %', v_step.operation_name
      USING ERRCODE = '23503';
  END IF;

  v_task_type_key := lower(
    COALESCE(
      NULLIF(btrim(v_operator_payload->>'task_type_key'), ''),
      NULLIF(btrim(v_operation_defaults->>'task_type_key'), '')
    )
  );
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 missing task_type_key for %', v_step.operation_name
      USING ERRCODE = '23514';
  END IF;

  SELECT item.value
  INTO v_catalog_entry
  FROM public.settings s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS item(value)
  WHERE s.category = 'task_type_catalog'
    AND lower(NULLIF(btrim(COALESCE(item.value->>'key', '')), '')) = v_task_type_key
  ORDER BY s.last_updated DESC NULLS LAST, s.id ASC
  LIMIT 1;

  v_catalog_entry := COALESCE(v_catalog_entry, '{}'::jsonb);
  IF jsonb_typeof(v_catalog_entry) IS DISTINCT FROM 'object' THEN
    v_catalog_entry := '{}'::jsonb;
  END IF;

  v_assignment_defaults := COALESCE(v_catalog_entry->'metadata'->'assignment_defaults', '{}'::jsonb);
  IF jsonb_typeof(v_assignment_defaults) IS DISTINCT FROM 'object' THEN
    v_assignment_defaults := '{}'::jsonb;
  END IF;

  v_resource_type := NULLIF(
    btrim(
      COALESCE(
        v_operator_payload->>'resource_type',
        v_operation_defaults->>'resource_type',
        ''
      )
    ),
    ''
  );

  BEGIN
    v_resource_id := NULLIF(
      btrim(
        COALESCE(
          v_operator_payload->>'resource_id',
          v_operation_defaults->>'resource_id',
          ''
        )
      ),
      ''
    )::uuid;
  EXCEPTION
    WHEN others THEN
      v_resource_id := NULL;
  END;

  v_queue_key := NULLIF(
    btrim(
      COALESCE(
        v_operator_payload->>'queue_key',
        v_operation_defaults->>'queue_key',
        v_assignment_defaults->>'queue_key',
        v_catalog_entry->>'default_queue_key',
        ''
      )
    ),
    ''
  );

  BEGIN
    v_priority := NULLIF(
      btrim(COALESCE(v_operator_payload->>'priority', v_operation_defaults->>'priority', v_catalog_entry->>'default_priority', '')),
      ''
    )::int;
  EXCEPTION
    WHEN others THEN
      v_priority := NULL;
  END;

  BEGIN
    v_sla_minutes := NULLIF(
      btrim(COALESCE(v_operator_payload->>'sla_minutes', v_operation_defaults->>'sla_minutes', v_assignment_defaults->>'sla_minutes', '')),
      ''
    )::int;
  EXCEPTION
    WHEN others THEN
      v_sla_minutes := NULL;
  END;

  v_actor_system := COALESCE(
    NULLIF(btrim(v_operator_payload->>'actor_system'), ''),
    NULLIF(btrim(v_operation_defaults->>'actor_system'), ''),
    'workflow_schedule_task_repair'
  );

  v_task_context := public.jsonb_deep_merge(
    COALESCE(v_operator_payload->'context', '{}'::jsonb),
    COALESCE(v_operation_defaults->'context', '{}'::jsonb)
  );
  v_task_context := public.jsonb_deep_merge(
    v_task_context,
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_row.organization_id,
        'workflow_schedule_trigger_id', v_row.id,
        'workflow_template_id', v_row.workflow_template_id,
        'workflow_template_step_id', v_step.id,
        'scope_type', v_row.scope_type,
        'scope_id', v_row.scope_id,
        'operation_name', v_step.operation_name
      )
    )
  );

  v_task_metadata := public.jsonb_deep_merge(
    COALESCE(v_operator_payload->'metadata', '{}'::jsonb),
    COALESCE(v_operation_defaults->'metadata', '{}'::jsonb)
  );
  v_task_metadata := public.jsonb_deep_merge(
    v_task_metadata,
    jsonb_strip_nulls(
      jsonb_build_object(
        'workflow_schedule_trigger_id', v_row.id,
        'workflow_template_id', v_row.workflow_template_id,
        'workflow_template_step_id', v_step.id,
        'operation_name', v_step.operation_name,
        'repair_source', 'ui_repair_workflow_schedule_task_payload_v1'
      )
    )
  );

  v_repaired_task := jsonb_strip_nulls(
    public.jsonb_deep_merge(
      v_operator_payload - 'context' - 'metadata',
      jsonb_build_object(
        'task_type_key', v_task_type_key,
        'organization_id', v_row.organization_id,
        'resource_type', v_resource_type,
        'resource_id', v_resource_id,
        'queue_key', v_queue_key,
        'priority', v_priority,
        'sla_minutes', v_sla_minutes,
        'actor_system', v_actor_system,
        'context', v_task_context,
        'metadata', v_task_metadata
      )
    )
  );

  v_repaired_context_patch := public.jsonb_deep_merge(
    COALESCE(v_row.context_patch, '{}'::jsonb),
    jsonb_build_object(
      'binding_payload',
      jsonb_build_object('task', v_repaired_task)
    )
  );

  UPDATE public.workflow_schedule_triggers
  SET
    context_patch = v_repaired_context_patch,
    last_error = NULL,
    last_error_at = NULL,
    updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  v_context := public.build_workflow_schedule_trigger_context_v1(
    v_row,
    'manual',
    NULL,
    NULL,
    auth.uid()
  );
  v_preflight := public.workflow_schedule_trigger_preflight_v1(v_row, v_context);

  IF COALESCE((v_preflight->>'ok')::boolean, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'ui_repair_workflow_schedule_task_payload_v1 repair did not satisfy preflight: %',
      COALESCE(v_preflight->>'reason', 'unknown preflight failure')
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'status', 'payload_repaired',
    'workflow_schedule_trigger_id', v_row.id,
    'workflow_template_id', v_row.workflow_template_id,
    'workflow_template_step_id', v_step.id,
    'operation_name', v_step.operation_name,
    'task_type_key', v_task_type_key,
    'queue_key', v_queue_key,
    'priority', v_priority,
    'sla_minutes', v_sla_minutes,
    'resource_type', v_resource_type,
    'resource_id', v_resource_id,
    'preflight', v_preflight,
    'context_patch', v_row.context_patch,
    'updated_at', v_row.updated_at
  );
END;
$$;

COMMENT ON FUNCTION public.ui_repair_workflow_schedule_task_payload_v1(UUID, JSONB)
  IS 'Console V2 workflow schedule repair wrapper. Requires workflows.write, patches binding_payload.task from row-driven operation/task defaults, clears prior preflight error, and returns backend readback.';

REVOKE ALL ON FUNCTION public.ui_repair_workflow_schedule_task_payload_v1(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_repair_workflow_schedule_task_payload_v1(UUID, JSONB) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.ui_repair_workflow_schedule_task_payload_v1(
  p_workflow_schedule_trigger_id UUID,
  p_task_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_repair_workflow_schedule_task_payload_v1(
    p_workflow_schedule_trigger_id,
    p_task_payload
  );
$$;

REVOKE ALL ON FUNCTION api.ui_repair_workflow_schedule_task_payload_v1(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_repair_workflow_schedule_task_payload_v1(UUID, JSONB) TO authenticated, service_role;

COMMIT;
