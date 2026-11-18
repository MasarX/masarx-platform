-- Migration: make COD manager approval tasks action-complete in Console V2.
-- Purpose:
--   - Attach approve/reject task metadata to the actual workflow enqueue step.
--   - Repair already-open manager approval tasks so Browser operators see the
--     same row-driven actions without needing a new workflow run.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605191310_console_v2_cod_manager_approval_actions_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH action_def AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'task_action_kind' LIMIT 1
),
rows(value, label, description, sort_order, metadata) AS (
  VALUES
    (
      'approve',
      'Approve',
      'Approve a review task and allow the owning workflow to continue.',
      90,
      jsonb_build_object('icon', 'check', 'tone', 'good', 'next_status', 'completed')
    ),
    (
      'reject',
      'Reject',
      'Reject a review task and stop the owning workflow from approving the closeout.',
      100,
      jsonb_build_object('icon', 'warn', 'tone', 'danger', 'next_status', 'rejected')
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
    IF v_key = 'cod_manager_approval' THEN
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

DO $do$
DECLARE
  v_template_id uuid;
  v_manager_task_metadata jsonb := jsonb_build_object(
    'allowed_actions', jsonb_build_array('approve', 'reject'),
    'subject', 'COD manager approval',
    'description', 'Review the COD variance decision and approve or reject the settlement closeout.'
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
               'task_metadata', v_manager_task_metadata,
               'queue_key', 'finance'
             )
           ),
           updated_at = now()
     WHERE workflow_template_id = v_template_id
       AND operation_name = 'cod_manager_approval_task_enqueue';

    UPDATE public.workflow_template_steps
       SET metadata = public.jsonb_deep_merge(
             COALESCE(metadata, '{}'::jsonb),
             jsonb_build_object(
               'success_statuses', jsonb_build_array('completed'),
               'failure_statuses', jsonb_build_array('canceled', 'cancelled', 'rejected')
             )
           ),
           updated_at = now()
     WHERE workflow_template_id = v_template_id
       AND operation_name = 'cod_manager_approval_task_wait';
  END IF;

  UPDATE public.tasks t
     SET metadata = public.jsonb_deep_merge(
           COALESCE(t.metadata, '{}'::jsonb),
           v_manager_task_metadata
         ),
         queue_key = 'finance',
         updated_at = now()
    FROM public.task_types tt
   WHERE tt.id = t.task_type_id
     AND tt.key = 'cod_manager_approval'
     AND lower(t.status) NOT IN ('completed', 'canceled', 'cancelled', 'rejected', 'expired');
END;
$do$;

UPDATE public.task_types
   SET default_queue_key = 'finance',
       updated_at = now()
 WHERE key = 'cod_manager_approval'
   AND COALESCE(NULLIF(btrim(default_queue_key), ''), 'default') <> 'finance';

SELECT pg_advisory_unlock(hashtext('202605191310_console_v2_cod_manager_approval_actions_v1'));

COMMIT;
