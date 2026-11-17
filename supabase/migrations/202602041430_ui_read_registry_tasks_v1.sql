-- Plan: PLAN-202602-mobile-field-ops-native-app-v1 / Step: S04
-- Migration: UI read registry tasks resource v1
-- Purpose:
-- - Expose `public.tasks` via `ui_read_registry` so Field Ops mobile can render tasks dynamically.
-- - Keep behavior row-driven (registry rows), with scope ladder + RLS enforced by the underlying table/policies.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041430_ui_read_registry_tasks_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_tasks JSONB := jsonb_build_object(
    'key', 'tasks',
    'label', 'Tasks',
    'relation', 'public.tasks',
    'id_column', 'id',
    'scope_columns', jsonb_build_object(
      'tenant', 'organization_id',
      'client', 'client_id',
      'sender', 'sender_id'
    ),
    'capability_read', 'tasks.read',
    'select', jsonb_build_array(
      'id',
      'status',
      'status_reason',
      'priority',
      'queue_key',
      'assigned_to',
      'assigned_at',
      'sla_due_at',
      'resource_type',
      'resource_id',
      'client_id',
      'sender_id',
      'organization_id',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'queue_key', 'column', 'queue_key', 'op', 'eq'),
      jsonb_build_object('key', 'assigned_to', 'column', 'assigned_to', 'op', 'eq'),
      jsonb_build_object('key', 'resource_type', 'column', 'resource_type', 'op', 'eq'),
      jsonb_build_object('key', 'resource_id', 'column', 'resource_id', 'op', 'eq'),
      jsonb_build_object('key', 'sla_due_at', 'column', 'sla_due_at', 'op', 'gte')
    ),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item WHERE item->>'key' = 'tasks'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_tasks);
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Expose tasks in ui_read_registry',
        approved_at = now(),
        effective_from = now()
    FROM current
    WHERE sv.id = current.settings_version_id
      AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
  SET cached_value = applied.value,
      last_updated = now()
  FROM applied
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202602041430_ui_read_registry_tasks_v1'));
COMMIT;

