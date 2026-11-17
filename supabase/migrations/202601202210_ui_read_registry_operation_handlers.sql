-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04
-- Migration: UI read registry operation handlers
BEGIN;
SELECT pg_advisory_lock(hashtext('202601202210_ui_read_registry_operation_handlers'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_operation_handlers JSONB := jsonb_build_object(
    'key','operation_handlers',
    'label','Operation handlers',
    'relation','public.operation_handlers',
    'id_column','handler_key',
    'capability_read','workflow_runs.read',
    'select', jsonb_build_array(
      'handler_key','handler_schema','handler_name','handler_signature','handler_version',
      'is_active','created_by','created_at','updated_at','notes','doc_url'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','handler_key','column','handler_key','op','ilike'),
      jsonb_build_object('key','is_active','column','is_active','op','eq')
    ),
    'default_sort', jsonb_build_object('column','handler_key','direction','asc')
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
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item WHERE item->>'key' = 'operation_handlers'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_operation_handlers);
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
        change_reason = 'Add operation handler resource',
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

SELECT pg_advisory_unlock(hashtext('202601202210_ui_read_registry_operation_handlers'));
COMMIT;
