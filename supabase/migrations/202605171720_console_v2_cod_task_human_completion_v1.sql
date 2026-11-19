-- Migration: Console V2 COD task human completion contract
-- Purpose:
--   - Make COD settlement human tasks operator-actionable through row-driven
--     task action metadata instead of generic "Resolve" completion.
--   - Expose api.open_ops_session_v1 for browser-safe task completion payloads.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605171720_console_v2_cod_task_human_completion_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH action_def AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'task_action_kind' LIMIT 1
),
rows(value, label, description, sort_order, metadata) AS (
  VALUES
    (
      'record_handover',
      'Record handover',
      'Record the driver COD cash handover for a settlement batch.',
      70,
      jsonb_build_object('icon', 'check', 'tone', 'good', 'next_status', 'completed')
    ),
    (
      'record_cashier_count',
      'Record cashier count',
      'Record the cashier counted amount for a COD settlement batch.',
      80,
      jsonb_build_object('icon', 'check', 'tone', 'good', 'next_status', 'completed')
    )
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT action_def.id, rows.value, rows.label, rows.description, rows.sort_order, FALSE, 'active', rows.metadata
FROM action_def
CROSS JOIN rows
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = now();

WITH task_type_def AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'task_type' LIMIT 1
),
rows(value, label, description, sort_order, metadata) AS (
  VALUES
    (
      'cod_cash_handover',
      'COD cash handover',
      'Driver-shift COD cash handover task owned by the settlement workflow.',
      70,
      jsonb_build_object(
        'tone', 'warn',
        'console_path', '/workflows/review-queue',
        'console_focus_param', 'focus',
        'console_focus_source', 'id',
        'reviewer_description', 'Record the driver handover amount for the COD settlement batch. Completion opens the required operational session and wakes the parent settlement workflow.'
      )
    ),
    (
      'cod_cashier_count',
      'COD cashier count',
      'Branch cashier count task owned by the COD settlement workflow.',
      80,
      jsonb_build_object(
        'tone', 'warn',
        'console_path', '/workflows/review-queue',
        'console_focus_param', 'focus',
        'console_focus_source', 'id',
        'reviewer_description', 'Record the branch cashier counted amount for the COD settlement batch. Completion opens the required operational session and wakes the parent settlement workflow.'
      )
    ),
    (
      'cod_manager_approval',
      'COD manager approval',
      'Manager approval task for COD settlement variances.',
      90,
      jsonb_build_object(
        'tone', 'danger',
        'console_path', '/workflows/review-queue',
        'console_focus_param', 'focus',
        'console_focus_source', 'id',
        'reviewer_description', 'Review the COD variance decision and approve or reject the settlement closeout.'
      )
    )
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT task_type_def.id, rows.value, rows.label, rows.description, rows.sort_order, FALSE, 'active', rows.metadata
FROM task_type_def
CROSS JOIN rows
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = now();

DO $do$
DECLARE
  v_scope_hash uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_current jsonb;
  v_task_types jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_item jsonb;
  v_key text;
BEGIN
  SELECT cached_value
    INTO v_current
    FROM public.settings
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
   LIMIT 1;

  IF v_current IS NULL OR jsonb_typeof(v_current) <> 'object' THEN
    RETURN;
  END IF;

  v_task_types := COALESCE(v_current->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) <> 'array' THEN
    RETURN;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_task_types)
  LOOP
    v_key := lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), ''));
    IF v_key = 'cod_cash_handover' THEN
      v_item := jsonb_set(v_item, '{default_actions}', jsonb_build_array('record_handover'), TRUE);
      v_item := jsonb_set(v_item, '{default_queue_key}', to_jsonb('finance'::text), TRUE);
    ELSIF v_key = 'cod_cashier_count' THEN
      v_item := jsonb_set(v_item, '{default_actions}', jsonb_build_array('record_cashier_count'), TRUE);
      v_item := jsonb_set(v_item, '{default_queue_key}', to_jsonb('finance'::text), TRUE);
    ELSIF v_key = 'cod_manager_approval' THEN
      v_item := jsonb_set(v_item, '{default_actions}', jsonb_build_array('approve', 'reject'), TRUE);
      v_item := jsonb_set(v_item, '{default_queue_key}', to_jsonb('finance'::text), TRUE);
    END IF;
    v_updated := v_updated || jsonb_build_array(v_item);
  END LOOP;

  v_current := jsonb_set(v_current, '{task_types}', v_updated, TRUE);

  UPDATE public.settings_versions
     SET value = v_current
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND approved_at IS NOT NULL
     AND effective_until IS NULL
     AND value IS DISTINCT FROM v_current;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND cached_value IS DISTINCT FROM v_current;
END;
$do$;

CREATE OR REPLACE FUNCTION api.open_ops_session_v1(p_input jsonb)
RETURNS TABLE (
  ops_session_id uuid,
  created boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT * FROM public.open_ops_session_v1(p_input);
$$;

REVOKE ALL ON FUNCTION api.open_ops_session_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.open_ops_session_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.open_ops_session_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.open_ops_session_v1(jsonb) IS
  'API schema wrapper for public.open_ops_session_v1. Used by Console V2 task completion flows that require an operational session.';

DO $do$
DECLARE
  v_template_id uuid;
  v_driver_schema jsonb := jsonb_build_object(
    'action_kind', 'record_handover',
    'next_status', 'completed',
    'title', 'Record driver COD handover',
    'description', 'Enter the cash amount handed over for this driver-shift settlement.',
    'submit_label', 'Record handover',
    'requires_session_type', 'driver_shift',
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'amount', 'label', 'Cash amount', 'type', 'number', 'required', TRUE, 'min', 0, 'step', '0.01', 'default_from', 'settlement.expected_amount'),
      jsonb_build_object('key', 'currency', 'label', 'Currency', 'type', 'text', 'required', TRUE, 'default_from', 'settlement.currency'),
      jsonb_build_object('key', 'receipt_context', 'label', 'Receipt or bag reference', 'type', 'text', 'required', FALSE)
    )
  );
  v_cashier_schema jsonb := jsonb_build_object(
    'action_kind', 'record_cashier_count',
    'next_status', 'completed',
    'title', 'Record cashier COD count',
    'description', 'Enter the branch cashier count for this settlement batch.',
    'submit_label', 'Record cashier count',
    'requires_session_type', 'branch_cash_drawer',
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'amount', 'label', 'Cashier counted amount', 'type', 'number', 'required', TRUE, 'min', 0, 'step', '0.01', 'default_from', 'settlement.expected_amount'),
      jsonb_build_object('key', 'currency', 'label', 'Currency', 'type', 'text', 'required', TRUE, 'default_from', 'settlement.currency'),
      jsonb_build_object('key', 'receipt_context', 'label', 'Receipt or drawer reference', 'type', 'text', 'required', FALSE)
    )
  );
BEGIN
  SELECT id INTO v_template_id
    FROM public.workflow_templates
   WHERE template_key = 'cod_driver_shift_settlement_v2'
      OR name = 'cod_driver_shift_settlement_v2'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NOT NULL THEN
    UPDATE public.workflow_template_steps
       SET metadata = public.jsonb_deep_merge(
             COALESCE(metadata, '{}'::jsonb),
             jsonb_build_object(
               'task_metadata',
               jsonb_build_object(
                 'allowed_actions', jsonb_build_array('record_handover'),
                 'completion_payload_schema', v_driver_schema,
                 'subject', 'COD driver cash handover',
                 'description', 'Record driver COD cash handover against the settlement batch.'
               ),
               'queue_key', 'finance'
         )
       ),
       updated_at = now()
     WHERE workflow_template_id = v_template_id
       AND operation_name = 'cod_driver_handover_task_enqueue';

    UPDATE public.workflow_template_steps
       SET metadata = public.jsonb_deep_merge(
             COALESCE(metadata, '{}'::jsonb),
             jsonb_build_object(
               'task_metadata',
               jsonb_build_object(
                 'allowed_actions', jsonb_build_array('record_cashier_count'),
                 'completion_payload_schema', v_cashier_schema,
                 'subject', 'COD cashier count',
                 'description', 'Record branch cashier count against the settlement batch.'
               ),
               'queue_key', 'finance'
         )
       ),
       updated_at = now()
     WHERE workflow_template_id = v_template_id
       AND operation_name = 'cod_cashier_count_task_enqueue';
  END IF;

  UPDATE public.tasks t
     SET metadata = public.jsonb_deep_merge(
           COALESCE(t.metadata, '{}'::jsonb),
           jsonb_build_object(
             'allowed_actions', jsonb_build_array('record_handover'),
             'completion_payload_schema', v_driver_schema,
             'subject', COALESCE(NULLIF(t.metadata->>'subject', ''), 'COD driver cash handover'),
             'description', COALESCE(NULLIF(t.metadata->>'description', ''), 'Record driver COD cash handover against the settlement batch.')
           )
         ),
         queue_key = 'finance',
         updated_at = now()
    FROM public.task_types tt
   WHERE tt.id = t.task_type_id
     AND tt.key = 'cod_cash_handover'
     AND lower(t.status) NOT IN ('completed', 'canceled', 'cancelled', 'rejected', 'expired');

  UPDATE public.tasks t
     SET metadata = public.jsonb_deep_merge(
           COALESCE(t.metadata, '{}'::jsonb),
           jsonb_build_object(
             'allowed_actions', jsonb_build_array('record_cashier_count'),
             'completion_payload_schema', v_cashier_schema,
             'subject', COALESCE(NULLIF(t.metadata->>'subject', ''), 'COD cashier count'),
             'description', COALESCE(NULLIF(t.metadata->>'description', ''), 'Record branch cashier count against the settlement batch.')
           )
         ),
         queue_key = 'finance',
         updated_at = now()
    FROM public.task_types tt
   WHERE tt.id = t.task_type_id
     AND tt.key = 'cod_cashier_count'
     AND lower(t.status) NOT IN ('completed', 'canceled', 'cancelled', 'rejected', 'expired');
END;
$do$;

UPDATE public.task_types
   SET default_queue_key = 'finance',
       updated_at = now()
 WHERE key IN ('cod_cash_handover', 'cod_cashier_count', 'cod_manager_approval')
   AND COALESCE(NULLIF(btrim(default_queue_key), ''), 'default') <> 'finance';

SELECT pg_advisory_unlock(hashtext('202605171720_console_v2_cod_task_human_completion_v1'));

COMMIT;
