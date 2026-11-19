-- Migration: Console V2 bank deposit slip human completion contract
-- Purpose:
--   - Make bank deposit slip tasks operator-actionable through row-driven
--     task action metadata instead of generic "Resolve" completion.
--   - Backfill the live/open tasks created before the action metadata existed.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605182340_console_v2_bank_deposit_task_human_completion_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH action_def AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'task_action_kind' LIMIT 1
),
rows(value, label, description, sort_order, metadata) AS (
  VALUES
    (
      'record_deposit_slip',
      'Record deposit slip',
      'Record the branch bank deposit slip details for a settlement batch.',
      85,
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
      'bank_deposit_slip_create',
      'Bank deposit slip',
      'Branch deposit slip task owned by the bank deposit reconciliation workflow.',
      85,
      jsonb_build_object(
        'tone', 'warn',
        'console_path', '/workflows/review-queue',
        'console_focus_param', 'focus',
        'console_focus_source', 'id',
        'reviewer_description', 'Record the branch bank deposit slip amount, currency, and reference for the settlement batch. Completion opens the required operational session and wakes the parent reconciliation workflow.'
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
    IF v_key = 'bank_deposit_slip_create' THEN
      v_item := jsonb_set(v_item, '{default_actions}', jsonb_build_array('record_deposit_slip'), TRUE);
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

DO $do$
DECLARE
  v_template_id uuid;
  v_deposit_schema jsonb := jsonb_build_object(
    'action_kind', 'record_deposit_slip',
    'next_status', 'completed',
    'title', 'Record bank deposit slip',
    'description', 'Enter the bank deposit slip details for this settlement batch.',
    'submit_label', 'Record deposit slip',
    'requires_session_type', 'branch_cash_drawer',
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'amount', 'label', 'Deposit amount', 'type', 'number', 'required', TRUE, 'min', 0, 'step', '0.01', 'default_from', 'settlement.expected_amount'),
      jsonb_build_object('key', 'currency', 'label', 'Currency', 'type', 'text', 'required', TRUE, 'default_value', 'SAR'),
      jsonb_build_object('key', 'deposit_slip_ref', 'label', 'Deposit slip reference', 'type', 'text', 'required', TRUE),
      jsonb_build_object('key', 'notes', 'label', 'Notes', 'type', 'textarea', 'required', FALSE)
    )
  );
BEGIN
  SELECT id INTO v_template_id
    FROM public.workflow_templates
   WHERE template_key = 'bank_deposit_reconciliation_v2'
      OR name = 'bank_deposit_reconciliation_v2'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NOT NULL THEN
    UPDATE public.workflow_template_steps
       SET metadata = public.jsonb_deep_merge(
             COALESCE(metadata, '{}'::jsonb),
             jsonb_build_object(
               'task_metadata',
               jsonb_build_object(
                 'allowed_actions', jsonb_build_array('record_deposit_slip'),
                 'completion_payload_schema', v_deposit_schema,
                 'subject', 'Bank deposit slip',
                 'description', 'Record bank deposit slip details against the settlement batch.'
               ),
               'queue_key', 'finance'
             )
           ),
           updated_at = now()
     WHERE workflow_template_id = v_template_id
       AND operation_name = 'deposit_slip_task_enqueue';
  END IF;

  UPDATE public.tasks t
     SET metadata = public.jsonb_deep_merge(
           COALESCE(t.metadata, '{}'::jsonb),
           jsonb_build_object(
             'allowed_actions', jsonb_build_array('record_deposit_slip'),
             'completion_payload_schema', v_deposit_schema,
             'subject', COALESCE(NULLIF(t.metadata->>'subject', ''), 'Bank deposit slip'),
             'description', COALESCE(NULLIF(t.metadata->>'description', ''), 'Record bank deposit slip details against the settlement batch.')
           )
         ),
         queue_key = 'finance',
         updated_at = now()
    FROM public.task_types tt
   WHERE tt.id = t.task_type_id
     AND tt.key = 'bank_deposit_slip_create'
     AND lower(t.status) NOT IN ('completed', 'canceled', 'cancelled', 'rejected', 'expired');
END;
$do$;

UPDATE public.task_types
   SET default_queue_key = 'finance',
       updated_at = now()
 WHERE key = 'bank_deposit_slip_create'
   AND COALESCE(NULLIF(btrim(default_queue_key), ''), 'default') <> 'finance';

SELECT pg_advisory_unlock(hashtext('202605182340_console_v2_bank_deposit_task_human_completion_v1'));

COMMIT;
