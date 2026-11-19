-- Migration: repair tenant signup review task type catalog wiring.
-- Purpose:
--   - Tenant signup workflow bindings enqueue tenant_signup_review tasks.
--   - create_task_system_v1 provisions task_types from task_type_catalog.
--   - Keep the task contract row-driven so the workflow does not fail on first use.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605191455_tenant_signup_review_task_type_catalog_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH type_def AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'task_type' LIMIT 1
),
row_def(value, label, description, sort_order, metadata) AS (
  VALUES (
    'tenant_signup_review',
    'Tenant signup review',
    'Review inbound tenant signup request before approval or rejection.',
    30,
    jsonb_build_object(
      'icon', 'users',
      'tone', 'info',
      'console_path', '/platform/organizations',
      'console_focus_param', 'task',
      'console_focus_source', 'id'
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
SELECT type_def.id, row_def.value, row_def.label, row_def.description, row_def.sort_order, FALSE, 'active', row_def.metadata
FROM type_def
CROSS JOIN row_def
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    retired_at = NULL,
    metadata = EXCLUDED.metadata,
    updated_at = now();

DO $do$
DECLARE
  v_catalog_item jsonb := jsonb_build_object(
    'key', 'tenant_signup_review',
    'name', 'Tenant signup review',
    'description', 'Review inbound tenant signup request before approval or rejection.',
    'default_priority', 40,
    'default_queue_key', 'tenant_signup',
    'default_actions', jsonb_build_array('approve', 'request_info', 'reject'),
    'enabled', true,
    'metadata', jsonb_build_object(
      'assignment_defaults', jsonb_build_object(
        'queue_key', 'tenant_signup',
        'sla_minutes', 60,
        'assigned_to_user_type', 'super_admin'
      ),
      'allowed_actions', jsonb_build_array('approve', 'request_info', 'reject'),
      'console_path', '/platform/organizations',
      'console_focus_param', 'task',
      'console_focus_source', 'id'
    )
  );
  v_row record;
  v_value jsonb;
  v_task_types jsonb;
  v_next_task_types jsonb;
  v_change_reason text := 'Repair tenant signup review task type catalog';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.settings WHERE category = 'task_type_catalog') THEN
    RAISE EXCEPTION 'tenant_signup_review_task_type_catalog_repair_v1: task_type_catalog settings missing'
      USING ERRCODE = '23503';
  END IF;

  FOR v_row IN
    SELECT id, settings_version_id, COALESCE(cached_value, '{}'::jsonb) AS cached_value
      FROM public.settings
     WHERE category = 'task_type_catalog'
  LOOP
    v_value := v_row.cached_value;
    IF jsonb_typeof(v_value) <> 'object' THEN
      v_value := '{}'::jsonb;
    END IF;

    v_task_types := COALESCE(v_value->'task_types', '[]'::jsonb);
    IF jsonb_typeof(v_task_types) <> 'array' THEN
      v_task_types := '[]'::jsonb;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_task_types) AS item(value)
       WHERE lower(NULLIF(btrim(COALESCE(item.value->>'key', '')), '')) = 'tenant_signup_review'
    ) THEN
      SELECT COALESCE(
               jsonb_agg(
                 CASE
                   WHEN lower(NULLIF(btrim(COALESCE(item.value->>'key', '')), '')) = 'tenant_signup_review'
                     THEN item.value || v_catalog_item
                   ELSE item.value
                 END
                 ORDER BY item.ordinality
               ),
               '[]'::jsonb
             )
        INTO v_next_task_types
        FROM jsonb_array_elements(v_task_types) WITH ORDINALITY AS item(value, ordinality);
    ELSE
      v_next_task_types := v_task_types || jsonb_build_array(v_catalog_item);
    END IF;

    v_value := jsonb_set(v_value, '{task_types}', v_next_task_types, true);
    IF NULLIF(btrim(COALESCE(v_value->>'version', '')), '') IS NULL THEN
      v_value := jsonb_set(v_value, '{version}', to_jsonb(1), true);
    END IF;

    UPDATE public.settings
       SET cached_value = v_value,
           last_updated = now()
     WHERE id = v_row.id
       AND cached_value IS DISTINCT FROM v_value;

    UPDATE public.settings_versions
       SET value = v_value,
           change_reason = v_change_reason,
           approved_at = COALESCE(approved_at, now())
     WHERE id = v_row.settings_version_id
       AND value IS DISTINCT FROM v_value;
  END LOOP;
END;
$do$;

UPDATE public.task_types
   SET name = 'Tenant signup review',
       description = 'Review inbound tenant signup request before approval or rejection.',
       default_priority = 40,
       default_queue_key = 'tenant_signup',
       enabled = true,
       metadata = public.jsonb_deep_merge(
         COALESCE(metadata, '{}'::jsonb),
         jsonb_build_object(
           'assignment_defaults', jsonb_build_object(
             'queue_key', 'tenant_signup',
             'sla_minutes', 60,
             'assigned_to_user_type', 'super_admin'
           ),
           'allowed_actions', jsonb_build_array('approve', 'request_info', 'reject'),
           'console_path', '/platform/organizations',
           'console_focus_param', 'task',
           'console_focus_source', 'id'
         )
       ),
       updated_at = now()
 WHERE key = 'tenant_signup_review';

SELECT pg_advisory_unlock(hashtext('202605191455_tenant_signup_review_task_type_catalog_repair_v1'));

COMMIT;
