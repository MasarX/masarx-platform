-- Migration: async_provider_dispatch_v1 shipment_create step fix
-- Purpose:
--   Ensure the async provider follow-up workflow includes an active
--   shipment_create step so that async webhooks actually materialize
--   shipments using the planned identifiers reserved by the intake
--   workflow.

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
  v_tpl UUID;
  v_step_id UUID;
BEGIN
  SELECT id
  INTO v_tpl
  FROM workflow_templates
  WHERE name = 'async_provider_dispatch_v1'
  LIMIT 1;

  IF v_tpl IS NULL THEN
    RETURN;
  END IF;

  -- Ensure there is a shipment_create step wired for this template.
  SELECT id
  INTO v_step_id
  FROM workflow_template_steps
  WHERE workflow_template_id = v_tpl
    AND handler_key = 'shipment_create'
  ORDER BY sequence_order
  LIMIT 1;

  IF v_step_id IS NULL THEN
    INSERT INTO workflow_template_steps (
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
    VALUES (
      gen_random_uuid(),
      v_tpl,
      2,
      'create_shipment',
      'workflow',
      'always',
      NULL,
      NULL,
      NULL,
      NULL,
      FALSE,
      '{}'::jsonb,
      TRUE,
      now(),
      now(),
      'shipment_create',
      'v1'
    );
  ELSE
    UPDATE workflow_template_steps
    SET operation_name = 'create_shipment',
        operation_settings_category = 'workflow',
        transition_condition = 'always',
        enabled = TRUE,
        handler_key = 'shipment_create',
        handler_version = 'v1',
        updated_at = now()
    WHERE id = v_step_id;
  END IF;

  -- Normalise step ordering for async_provider_dispatch_v1:
  --   0: context_extract_from_mapping
  --   1: reserve_identifiers (reserve_shipment_identifiers)
  --   2: create_shipment (shipment_create)
  --   3: call_supplier_api
  --   4: record_workflow_completion
  UPDATE workflow_template_steps
  SET sequence_order = 0,
      updated_at = now()
  WHERE workflow_template_id = v_tpl
    AND handler_key = 'context_extract_from_mapping';

  UPDATE workflow_template_steps
  SET sequence_order = 1,
      updated_at = now()
  WHERE workflow_template_id = v_tpl
    AND handler_key = 'reserve_shipment_identifiers';

  UPDATE workflow_template_steps
  SET sequence_order = 2,
      updated_at = now()
  WHERE workflow_template_id = v_tpl
    AND handler_key = 'shipment_create';

  UPDATE workflow_template_steps
  SET sequence_order = 3,
      updated_at = now()
  WHERE workflow_template_id = v_tpl
    AND operation_name = 'call_supplier_api';

  UPDATE workflow_template_steps
  SET sequence_order = 4,
      updated_at = now()
  WHERE workflow_template_id = v_tpl
    AND operation_name = 'record_workflow_completion';
END;
$$;

-- Recalculate steps checksum for async_provider_dispatch_v1 to keep
-- template metadata consistent across environments.
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
          COALESCE(wts.metadata::TEXT, '')
        ),
        '||' ORDER BY wts.sequence_order
      )
    ) AS checksum
  FROM workflow_template_steps wts
  WHERE wts.workflow_template_id = (
    SELECT id FROM workflow_templates WHERE name = 'async_provider_dispatch_v1' LIMIT 1
  )
  GROUP BY wts.workflow_template_id
)
UPDATE workflow_templates wt
SET steps_checksum = recalculated.checksum,
    updated_at = now()
FROM recalculated
WHERE wt.id = recalculated.workflow_template_id;

COMMIT;

