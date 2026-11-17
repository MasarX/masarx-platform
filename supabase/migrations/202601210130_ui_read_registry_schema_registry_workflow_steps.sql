-- Migration: UI read registry schema_registry + workflow_template_steps select-all
BEGIN;
SELECT pg_advisory_lock(hashtext('202601210130_ui_read_registry_schema_registry_workflow_steps'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_schema_registry JSONB := jsonb_build_object(
    'key','schema_registry',
    'label','Schema registry',
    'relation','public.schema_registry',
    'id_column','id',
    'capability_read','workflow_runs.read',
    'filters', jsonb_build_array(
      jsonb_build_object('key','category','column','category','op','eq'),
      jsonb_build_object('key','is_active','column','is_active','op','eq')
    ),
    'default_sort', jsonb_build_object('column','category','direction','asc')
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
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item WHERE item->>'key' = 'schema_registry'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_schema_registry);
  END IF;

  -- Ensure workflow template steps select all columns so schedule/metadata fields remain SSOT-driven.
  v_resources := (
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN item->>'key' = 'workflow_template_steps' THEN item - 'select'
          ELSE item
        END
        ORDER BY ordinality
      ),
      '[]'::jsonb
    )
    FROM jsonb_array_elements(v_resources) WITH ORDINALITY AS elem(item, ordinality)
  );

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
        change_reason = 'Expose schema_registry and select all workflow_template_steps columns',
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

SELECT pg_advisory_unlock(hashtext('202601210130_ui_read_registry_schema_registry_workflow_steps'));
COMMIT;

