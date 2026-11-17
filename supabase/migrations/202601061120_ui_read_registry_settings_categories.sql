-- Migration: UI read registry settings categories
BEGIN;
SELECT pg_advisory_lock(hashtext('202601061120_ui_read_registry_settings_categories'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_has_categories BOOLEAN := FALSE;
  v_settings_categories JSONB := jsonb_build_object(
    'key','settings_category_registry',
    'label','Settings categories',
    'relation','public.settings_category_registry',
    'id_column','category',
    'capability_read','settings.read',
    'select', jsonb_build_array(
      'category',
      'description',
      'request_capability',
      'requires_schema',
      'requires_global_default',
      'side_effecting',
      'safe_missing_behavior',
      'allowed_scopes',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','category','column','category','op','ilike'),
      jsonb_build_object('key','request_capability','column','request_capability','op','eq')
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

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_resource->>'key' = 'settings_category_registry' THEN
      v_has_categories := TRUE;
    END IF;
    v_updated := v_updated || jsonb_build_array(v_resource);
  END LOOP;

  IF v_has_categories IS FALSE THEN
    v_updated := v_updated || jsonb_build_array(v_settings_categories);
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated, true);

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
        change_reason = 'Add settings categories resource',
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

SELECT pg_advisory_unlock(hashtext('202601061120_ui_read_registry_settings_categories'));
COMMIT;
