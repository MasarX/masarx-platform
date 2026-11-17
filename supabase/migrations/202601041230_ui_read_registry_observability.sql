-- Migration: UI read registry observability resources
BEGIN;
SELECT pg_advisory_lock(hashtext('202601041230_ui_read_registry_observability'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_decision_log JSONB := jsonb_build_object(
    'key','decision_log',
    'label','Decision log',
    'relation','public.decision_log',
    'id_column','id',
    'scope_columns', jsonb_build_object('tenant','organization_id'),
    'capability_read','audit_log.read',
    'select', jsonb_build_array(
      'id','organization_id','decision_category','decision_point','decision_outcome',
      'resource_type','resource_id','timestamp','correlation_id','settings_resolution_id'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','decision_category','column','decision_category','op','eq'),
      jsonb_build_object('key','resource_type','column','resource_type','op','eq'),
      jsonb_build_object('key','decision_outcome','column','decision_outcome','op','eq'),
      jsonb_build_object('key','correlation_id','column','correlation_id','op','eq')
    ),
    'default_sort', jsonb_build_object('column','timestamp','direction','desc')
  );
  v_settings_resolution_log JSONB := jsonb_build_object(
    'key','settings_resolution_log',
    'label','Settings resolutions',
    'relation','public.settings_resolution_log',
    'id_column','id',
    'scope_columns', jsonb_build_object('tenant','organization_id'),
    'capability_read','settings.read',
    'select', jsonb_build_array(
      'id','organization_id','category','winning_scope_type','winning_scope_id',
      'settings_id','settings_version_id','resolved_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','category','column','category','op','eq'),
      jsonb_build_object('key','winning_scope_type','column','winning_scope_type','op','eq'),
      jsonb_build_object('key','winning_scope_id','column','winning_scope_id','op','eq')
    ),
    'default_sort', jsonb_build_object('column','resolved_at','direction','desc')
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
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item WHERE item->>'key' = 'decision_log'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_decision_log);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item WHERE item->>'key' = 'settings_resolution_log'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_settings_resolution_log);
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
        change_reason = 'Add observability resources',
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

SELECT pg_advisory_unlock(hashtext('202601041230_ui_read_registry_observability'));
COMMIT;
